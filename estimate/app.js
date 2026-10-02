/* 청풍 현장견적 — app.js
   현장 실측(mm) → 면적 자동산출 → 공종별 견적서 → 엑셀/PDF
   데이터는 이 기기(IndexedDB)에만 저장됩니다. */
'use strict';

/* ══════════════ 0. 유틸 ══════════════ */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const won = n => Math.round(n).toLocaleString('ko-KR');
const m2  = n => (Math.round(n * 100) / 100).toFixed(2);
const uid = () => 'x' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);
const esc = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const today = () => new Date().toISOString().slice(0, 10);

/* 개구부 공제 면적(㎡) */
const OPEN_DOOR = 1.89;   // 900 × 2100
const OPEN_WIN  = 0.50;   // 방음창 평균
/* -H(고천장) 적용 기준 높이(mm) */
const H_LIMIT = 2600;

/* 벽 마감 인건비 — 1인이 하루에 시공하는 면적(㎡).
   면적을 이 값으로 나눠 올림한 인원수 × 인건비 단가로 계산합니다.
   null 이면 인원 산정을 하지 않고 견적서 비고에 "인건비 별도"로 표시합니다. */
const LABOR_M2 = { 도배: 60, 필름: 45, 도장: 30 };

/* ══════════════ 1. 저장소 (IndexedDB) ══════════════ */
const DB = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('cheongpung', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction('kv', mode);
      const rq = fn(t.objectStore('kv'));
      rq.onsuccess = () => res(rq.result);
      rq.onerror = () => rej(rq.error);
    });
  };
  return {
    get: k => tx('readonly', s => s.get(k)),
    set: (k, v) => tx('readwrite', s => s.put(v, k))
  };
})();

/* ══════════════ 2. 상태 ══════════════ */
let S = { sites: [], curId: null, priceOverride: {}, priceTable: [] };
let PRICES = [];          // 적용 단가표 (원본 + 사용자 수정)

const cur = () => S.sites.find(x => x.id === S.curId) || null;

let saveTimer = null;
function save(now) {
  clearTimeout(saveTimer);
  const go = () => DB.set('state', JSON.parse(JSON.stringify(S))).catch(e => console.error('저장 실패', e));
  if (now) go(); else saveTimer = setTimeout(go, 400);
}

/* ══════════════ 3. 단가표 ══════════════ */
const pkey = it => it.g + '|' + it.n + '|' + it.s;

/* 기준 단가표. 기기에 불러온 표가 있으면 그걸 쓴다.
   (앱 코드에는 단가가 들어있지 않다 — 공개 사이트에 원가를 올리지 않기 위함) */
function basePrices() {
  return (S.priceTable && S.priceTable.length) ? S.priceTable : UNIT_PRICES;
}
function hasPrices() { return basePrices().length > 0; }

function buildPrices() {
  PRICES = basePrices().map(it => {
    const o = Object.assign({}, it);
    const ov = S.priceOverride[pkey(it)];
    if (typeof ov === 'number') { o.p = ov; o.edited = true; }
    return o;
  });
}
/* 품목 조회 */
function P(g, n, s) {
  return PRICES.find(x => x.g === g && x.n === n && (s == null || x.s === s)) || null;
}
/* 공종 + 단위로 후보 목록 */
function byUnit(g, u) { return PRICES.filter(x => x.g === g && x.u === u); }

/* ── 방음벽 매트릭스: 단가표에서 직접 파생 ── */
function wallMatrix(kind) {           // kind: '칸막이' | '천장'
  const re = new RegExp('^방음벽-' + kind + '\\(([^)]+)\\)(-H)?$');
  const map = {};
  PRICES.filter(x => x.g === '목공').forEach(x => {
    const m = re.exec(x.n);
    if (!m) return;
    const base = '방음벽-' + kind + '(' + m[1] + ')';
    const k = base + '|' + x.s;
    map[k] = map[k] || { base, ply: x.s, opt: m[1], normal: null, high: null };
    map[k][m[2] ? 'high' : 'normal'] = x.p;
  });
  return Object.values(map).filter(v => v.normal || v.high);
}
/* 높이에 따라 -H 자동 선택 */
function resolveWall(base, ply, H) {
  const wantH = H >= H_LIMIT;
  const a = P('목공', base + (wantH ? '-H' : ''), ply);
  if (a) return { item: a, fallback: false };
  const b = P('목공', base, ply) || P('목공', base + '-H', ply);
  return b ? { item: b, fallback: true } : null;
}

/* ══════════════ 4. 현장/방 기본값 ══════════════ */
function newSite(name) {
  return {
    id: uid(), name: name, client: '', project: '', date: today(),
    addr: '', tel: '', use: '피아노 교습소',
    gong: 0, yun: 10, yunbase: 'direct', vat: 1, remark: '',
    gaseol: { 폐자재: 0, 보양: 0, 정리정돈: 0, 철거: 0, 관리일수: 0 },
    options: { sign: 0, paintSpecial: 0, scaffold: 0 },
    rooms: []
  };
}
// 걸레받이 몰딩 선택지 — 단가표의 몰딩 항목을 그대로 노출합니다
function MOLDING_OPTS(cur) {
  const list = [{ v: '', t: '— 없음 —' }];
  PRICES.filter(x => x.g === '목공' && x.n.indexOf('몰딩') >= 0)
        .forEach(x => list.push({ v: pkey(x), t: `${x.n} ${x.s || ''} (${x.p.toLocaleString()}원/본)`.trim() }));
  return list;
}

function newRoom(name) {
  return {
    id: uid(), name: name, W: 3000, D: 3000, H: 2400,
    wallOn: true, wallBase: '', wallPly: '', wallSides: 4, wallLen: 0,
    ceilOn: true, ceilBase: '', ceilPly: '', ceilBogang: 0,
    absWall: '', absWallRatio: 100, absCeil: '',
    floor: '', wallFin: '', floating: false,
    doors: [], wins: [],
    lights: 0, ipseon: false, wiring: false, detector: 0, sprinkler: 0, aircon: 0,
    railLight: 0, molding: '',
    photos: [], memo: ''
  };
}

/* ══════════════ 5. 면적 계산 ══════════════ */
function calcArea(r) {
  const W = num(r.W) / 1000, D = num(r.D) / 1000, H = num(r.H) / 1000;
  const floor = W * D;
  const perim = 2 * (W + D);
  // 방음 대상 벽 길이: 4면이면 둘레, 그 외는 비례. 직접 입력 시 우선.
  const len = num(r.wallLen) > 0 ? num(r.wallLen) : perim * (num(r.wallSides) / 4);
  const wallGross = len * H;
  // 문틀은 문과 같은 자리이므로 개구부를 두 번 빼지 않습니다
  const nDoor = r.doors.reduce((a, d) => a + (/문틀/.test(d.key || '') ? 0 : num(d.qty)), 0);
  const nWin  = r.wins.reduce((a, d) => a + num(d.qty), 0);
  const open  = nDoor * OPEN_DOOR + nWin * OPEN_WIN;
  const wall  = Math.max(0, wallGross - open);
  return { W, D, H, floor, perim, len, wallGross, open, wall, ceil: floor, nDoor, nWin, pyeong: floor / 3.3058 };
}

/* ══════════════ 6. 견적 엔진 ══════════════ */
function buildEstimate() {
  const st = cur();
  if (!st) return null;

  const G = {};   // 공종 → 항목[]
  const notes = [];
  const add = (g, n, s, u, qty, price, remark) => {
    if (!(qty > 0) || !(price > 0)) return;
    (G[g] = G[g] || []).push({
      n, s: s || '', u, qty: Math.round(qty * 100) / 100,
      p: Math.round(price), amt: Math.round(Math.round(qty * 100) / 100 * Math.round(price)),
      remark: remark || ''
    });
  };

  const areas = [];
  const finArea = {};      // 벽 마감 종류별 누계 면적 → 인건비 인원 산정용
  let acCount = 0;         // 시스템 에어컨 실내기 총 대수

  st.rooms.forEach(r => {
    const A = calcArea(r);
    areas.push({ room: r, A });
    const tag = r.name;

    /* ── 목공: 방음벽 ── */
    if (r.wallOn && r.wallBase && A.wall > 0) {
      const w = resolveWall(r.wallBase, r.wallPly, num(r.H));
      if (w) {
        add('목공', w.item.n, w.item.s, '㎡', A.wall, w.item.p, tag);
        if (w.fallback) notes.push(`[${tag}] 높이 ${r.H}mm에 맞는 -H 단가가 단가표에 없어 "${w.item.n} / ${w.item.s}"로 적용했습니다.`);
      } else notes.push(`[${tag}] 방음벽 단가를 찾지 못했습니다: ${r.wallBase} / ${r.wallPly}`);
    }
    /* ── 목공: 천장 방음 ── */
    if (r.ceilOn && r.ceilBase && A.ceil > 0) {
      const c = resolveWall(r.ceilBase, r.ceilPly, num(r.H));
      if (c) {
        add('목공', c.item.n, c.item.s, '㎡', A.ceil, c.item.p, tag);
        if (c.fallback) notes.push(`[${tag}] 천장 -H 단가가 없어 "${c.item.n} / ${c.item.s}"로 적용했습니다.`);
      } else notes.push(`[${tag}] 천장 방음 단가를 찾지 못했습니다: ${r.ceilBase} / ${r.ceilPly}`);
    }
    if (num(r.ceilBogang) > 0) {
      const bg = PRICES.find(x => x.g === '목공' && x.n.indexOf('천장보강재') >= 0);
      if (bg) add('목공', bg.n, bg.s, 'ea', num(r.ceilBogang), bg.p, tag);
    }

    // '흡음재 시공'은 자재+시공비+접착제가 이미 합쳐진 단가라 별도로 더하지 않습니다
    const ALLIN = n => /^흡음재 시공/.test(n || '');
    /* ── 방음공사: 벽면 흡음/마감재 ── */
    if (r.absWall) {
      const it = PRICES.find(x => pkey(x) === r.absWall);
      const q = A.wall * (num(r.absWallRatio) / 100);
      if (it && q > 0) {
        add('방음', it.n, it.s, '㎡', q, it.p, tag);
        if (!ALLIN(it.n)) {
          const sg = P('방음', '시공비', '');            if (sg) add('방음', sg.n, sg.s, '㎡', q, sg.p, tag);
          const bz = P('방음', '부자재-접착재', '');     if (bz) add('방음', bz.n, bz.s, '㎡', q, bz.p, tag);
        }
      }
    }
    /* ── 방음공사: 천장 흡음재 ── */
    if (r.absCeil) {
      const it = PRICES.find(x => pkey(x) === r.absCeil);
      if (it && A.ceil > 0) {
        add('방음', it.n, it.s, '㎡', A.ceil, it.p, tag);
        if (!ALLIN(it.n)) {
          const sc = P('방음', '시공비-천장', '');       if (sc) add('방음', sc.n, sc.s, '㎡', A.ceil, sc.p, tag);
          const bz = P('방음', '부자재-접착재', '');     if (bz) add('방음', bz.n, bz.s, '㎡', A.ceil, bz.p, tag);
        }
      }
    }

    /* ── 하드웨어: 문 / 창 ── */
    r.doors.forEach(d => {
      if (!d.key || !(num(d.qty) > 0)) return;
      const it = PRICES.find(x => pkey(x) === d.key);
      if (!it) return;
      add(it.g, it.n, it.s, it.u, num(d.qty), it.p, tag);
      if (it.g === '하드웨어') {
        const ins = P('하드웨어', '시스템방음문 설치', '');
        if (ins && it.n.indexOf('방음문') >= 0) add('하드웨어', ins.n, ins.s, 'ea', num(d.qty), ins.p, tag);
      }
      if (it.n.indexOf('목문') >= 0) {
        const a1 = P('목공', '목문 시공비', '문설치'); if (a1) add('목공', a1.n, a1.s, 'ea', num(d.qty), a1.p, tag);
        const a2 = P('목공', '문 부자재', '실린더,경첩'); if (a2) add('목공', a2.n, a2.s, 'ea', num(d.qty), a2.p, tag);
      }
      if (it.n.indexOf('문틀') >= 0) {
        const a3 = P('목공', '문틀 시공비', ''); if (a3) add('목공', a3.n, a3.s, 'ea', num(d.qty), a3.p, tag);
      }
    });
    r.wins.forEach(d => {
      if (!d.key || !(num(d.qty) > 0)) return;
      const it = PRICES.find(x => pkey(x) === d.key);
      if (!it) return;
      add(it.g, it.n, it.s, it.u, num(d.qty), it.p, tag);
      const ins = P('하드웨어', '시스템 방음창 설치', '');
      if (ins) add('하드웨어', ins.n, ins.s, 'ea', num(d.qty), ins.p, tag);
    });

    /* ── 목공: 뜬바닥(뜬구조) ── */
    if (r.floating && A.floor > 0) {
      const it = PRICES.find(x => x.g === '목공' && x.n.indexOf('뜬바닥') >= 0);
      if (it) add('목공', it.n, it.s, '㎡', A.floor, it.p, tag);
    }

    /* ── 마감: 바닥재 ── */
    if (r.floor && A.floor > 0) {
      const it = PRICES.find(x => pkey(x) === r.floor);
      if (it) add('마감', it.n, it.s, it.u, A.floor, it.p, tag);
    }
    /* ── 마감: 벽 마감 (도배/필름/도장) ── */
    if (r.wallFin && A.wall > 0) {
      const set = {
        '도배': [['도배', '합지'], ['도배 부자재', '합지']],
        '필름': [['필름', ''], ['필름 부자재', '']],
        '도장': [['도장', ''], ['도장 부자재', '']]
      }[r.wallFin] || [];
      set.forEach(([n, s]) => {
        const it = P('마감', n, s) || PRICES.find(x => x.g === '마감' && x.n.trim() === n);
        if (it) add('마감', it.n, it.s, '㎡', A.wall, it.p, tag);
      });
      // 인건비는 현장 전체 면적을 모아 한 번에 산정합니다(실마다 올림하면 인원이 부풀려집니다)
      finArea[r.wallFin] = (finArea[r.wallFin] || 0) + A.wall;
    }

    /* ── 전기 ── */
    if (num(r.lights) > 0) {
      const it = P('전기', '기본조명', '');
      if (it) add('전기', it.n, it.s, 'ea', num(r.lights), it.p, tag);
    }
    if (r.ipseon) {
      const it = P('전기', '천장 등 입선', '');
      if (it) add('전기', it.n, it.s, it.u, 1, it.p, tag);
    }
    // 전기를 전부 새로 까는 실 — 바닥면적 × ㎡단가
    if (r.wiring && A.floor > 0) {
      const it = P('전기', '입선·배선 신설', '전체 신설');
      if (it) add('전기', it.n, it.s, '㎡', A.floor, it.p, tag);
    }
    // 레일조명 · 포인트조명 (옵션) — 세트 단위
    if (num(r.railLight) > 0) {
      const it = P('전기', '레일조명/포인트', '레일3개    조명8개');
      if (it) add('전기', it.n, it.s, '식', num(r.railLight), it.p, tag);
    }
    /* ── 걸레받이 몰딩 (옵션) ── */
    if (r.molding) {
      const it = PRICES.find(x => pkey(x) === r.molding);
      if (it) {
        // 실 둘레에서 문 폭을 빼고 1본 2.4m 기준으로 올림
        const perim = 2 * (num(r.W) / 1000 + num(r.D) / 1000);
        const doorW = r.doors.reduce((a, d) => a + num(d.qty) * 0.9, 0);
        const runM = Math.max(0, perim - doorW);
        const bon = Math.ceil(runM / 2.4);
        if (bon > 0) add('목공', it.n, it.s, 'ea', bon, it.p, `${tag} · 둘레 ${runM.toFixed(1)}m ÷ 2.4m/본`);
      }
    }
    /* ── 소방 ── */
    if (num(r.detector) > 0)  { const it = P('소방', '화재감지기', '신설'); if (it) add('소방', it.n, it.s, 'ea', num(r.detector), it.p, tag); }
    if (num(r.sprinkler) > 0) { const it = P('소방', '스프링클러', '');     if (it) add('소방', it.n, it.s, 'ea', num(r.sprinkler), it.p, tag); }
    /* ── 냉난방 ── */
    // 시스템 에어컨 — 실별로는 실내기와 배수펌프만. 실외기·전원·잡자재는 현장 공통으로 아래에서 한 번.
    if (num(r.aircon) > 0) {
      const inn = P('냉난방', '시스템 실내기', '6평 벽걸이');
      if (inn) add('냉난방', inn.n, inn.s, 'ea', num(r.aircon), inn.p, tag);
      const pu = P('냉난방', '배수펌프', '시스템');
      if (pu) add('냉난방', pu.n, pu.s, 'ea', num(r.aircon), pu.p, tag);
      acCount += num(r.aircon);
    }
  });

  /* ── 마감 인건비 (현장 전체 면적 기준) ── */
  Object.keys(finArea).forEach(kind => {
    const area = finArea[kind];
    if (!(area > 0)) return;
    const it = PRICES.find(x => x.g === '마감' && x.n.trim() === kind + ' 인건비');
    if (!it) return;
    const per = LABOR_M2[kind];
    if (!per) { notes.push(`${kind} 인건비는 1인 시공면적 기준이 정해져 있지 않아 견적에서 빠졌습니다 (${m2(area)}㎡). 별도 산정하세요.`); return; }
    const men = Math.ceil(area / per);
    add('마감', it.n, it.s, it.u, men, it.p, `${m2(area)}㎡ ÷ ${per}㎡/인`);
  });

  /* ── 시스템 에어컨 공통분 (실외기 · 설치 · 배관 · 전원 · 잡자재) ── */
  if (acCount > 0) {
    const OUT_M_PER_UNIT = 4.6;   // 반원상가 실적: 실내기 7대 / 동배관 32m
    const ou = P('냉난방', '시스템 실외기', '6HP');
    if (ou) add('냉난방', ou.n, ou.s, 'ea', 1, ou.p, '실외기 1대에 실내기 전체 연결');
    const ins = P('냉난방', '실내외기 설치비', '');
    if (ins) add('냉난방', ins.n, ins.s, 'ea', acCount + 1, ins.p, `실내기 ${acCount} + 실외기 1`);
    const pipe = P('냉난방', '동배관', '');
    if (pipe) add('냉난방', pipe.n, pipe.s, 'm', Math.round(acCount * OUT_M_PER_UNIT), pipe.p, '실측 후 정산');
    const pw = P('냉난방', '메인전원 및 실내전원', '');
    if (pw) add('냉난방', pw.n, pw.s, '식', 1, pw.p, '');
    const et = P('냉난방', '분지관 및 잡자재', '');
    if (et) add('냉난방', et.n, et.s, '식', 1, et.p, '');
    notes.push(`시스템 에어컨: 실내기 ${acCount}대 기준입니다. 실외기 용량(6HP)과 동배관 길이는 공조업체 현장 확인 후 확정됩니다.`);
    notes.push('드레인을 매립할 경우 500,000원이 추가됩니다.');
  }

  /* ── 사인 · 특수마감 (현장 공통 옵션) ── */
  const op = st.options || {};
  if (num(op.sign) > 0) {
    const it = P('사인', '간판 채널형', '');
    if (it) add('사인', it.n, it.s, '식', num(op.sign), it.p, '');
    const dz = P('사인', '간판 디자인·시안', '');
    if (dz) add('사인', dz.n, dz.s, '식', 1, dz.p, '');
    notes.push('간판은 채널형 기준입니다. 실제 금액은 글자 수·크기·전기 인입 조건에 따라 변동됩니다.');
  }
  if (num(op.scaffold) > 0) {
    const jo = num(op.scaffold);
    const bt = P('가설', '이동식 비계', 'BT아시바 1조·주단위');
    if (bt) add('가설', bt.n, bt.s, '조', jo, bt.p, '기본 1주일 사용 기준');
    const bu = P('가설', '비계 부속', '연결핀·바퀴 1조분');
    if (bu) add('가설', bu.n, bu.s, '조', jo, bu.p, '');
    const tr = P('가설', '비계 운송료', '왕복 상·하차');
    if (tr) add('가설', tr.n, tr.s, '식', 1, tr.p, '');
    notes.push('이동식 비계는 대한가설산업 2020.04 견적을 건설공사비지수(2020=100 → 2026.04 136.9)로 환산한 추정 단가입니다. 발주 전 업체 확인이 필요하며, 보증금(약 70,000원)은 반환분이라 견적에서 제외했습니다.');
  }
  if (num(op.paintSpecial) > 0) {
    const it = P('마감', '도장-특수', '아트월·곡면');
    if (it) add('마감', it.n, it.s, '㎡', num(op.paintSpecial), it.p, '아트월·곡면 도장');
  }

  /* ── 가설공사 (현장 공통) ── */
  const gs = st.gaseol || {};
  const gmap = [['폐자재', '페자재 처리'], ['보양', '현장보양'], ['정리정돈', '현장 정리정돈'], ['철거', '철거']];
  gmap.forEach(([k, nm]) => {
    if (num(gs[k]) > 0) { const it = PRICES.find(x => x.g === '가설' && x.n.trim() === nm); if (it) add('가설', it.n, it.s, it.u, num(gs[k]), it.p, ''); }
  });
  if (num(gs.관리일수) > 0) { const it = P('가설', '현장관리비', ''); if (it) add('가설', it.n, it.s, 'day', num(gs.관리일수), it.p, ''); }

  /* ── 합산 ── */
  const ORDER = ['방음', '전기', '목공', '하드웨어', '마감', '소방', '냉난방', '사인', '가설'];
  const NAME  = { 방음: '방음공사', 전기: '전기공사', 목공: '목공사', 하드웨어: '하드웨어 공사', 마감: '마감 공사', 소방: '소방 공사', 냉난방: '냉난방 공조공사', 가설: '가설 공사' };
  const groups = ORDER.filter(g => G[g] && G[g].length).map(g => {
    // 동일 품목 합치기
    const merged = [];
    G[g].forEach(it => {
      const f = merged.find(x => x.n === it.n && x.s === it.s && x.p === it.p && x.u === it.u);
      if (f) {
        f.qty = Math.round((f.qty + it.qty) * 100) / 100; f.amt += it.amt;
        const tags = (f.remark + ',' + it.remark).split(',').map(s => s.trim()).filter(Boolean);
        f.remark = Array.from(new Set(tags)).join(', ');
      }
      else merged.push(Object.assign({}, it));
    });
    return { key: g, name: NAME[g], items: merged, sum: merged.reduce((a, x) => a + x.amt, 0) };
  });

  const direct = groups.reduce((a, x) => a + x.sum, 0);
  const gong = Math.round(direct * num(st.gong) / 100);
  const yun  = Math.round((st.yunbase === 'sum' ? direct + gong : direct) * num(st.yun) / 100);
  const base = direct + gong + yun;
  const vat  = num(st.vat) ? Math.round(base * 0.1) : 0;
  const total = base + vat;

  return { st, groups, areas, notes, direct, gong, yun, vat, total };
}

/* ══════════════ 7. 렌더 — 현장 목록 ══════════════ */
function renderSites() {
  const ul = $('#siteList'); ul.innerHTML = '';
  $('#siteEmpty').style.display = S.sites.length ? 'none' : 'block';
  S.sites.forEach(s => {
    const li = document.createElement('li');
    if (s.id === S.curId) li.className = 'on';
    li.innerHTML = `<div style="flex:1">
        <div class="nm">${esc(s.name)}</div>
        <div class="muted">${esc(s.client || '의뢰인 미입력')} · 방 ${s.rooms.length}개 · ${esc(s.date)}</div>
      </div>
      <button class="btn ghost sm" data-act="open">열기</button>
      <button class="btn ghost sm" data-act="exp">내보내기</button>
      <button class="btn dan sm" data-act="del">삭제</button>`;
    li.querySelector('[data-act=open]').onclick = e => { e.stopPropagation(); selectSite(s.id); go('info'); };
    li.querySelector('[data-act=exp]').onclick = e => {
      e.stopPropagation();
      const pack = { type: 'cheongpung-site', v: 1, sites: [s], priceOverride: S.priceOverride };
      dl(new Blob([JSON.stringify(pack)], { type: 'application/json' }),
        `${s.name}_${today().replace(/-/g, '').slice(2)}.json`);
    };
    li.querySelector('[data-act=del]').onclick = e => {
      e.stopPropagation();
      if (!confirm(`"${s.name}" 현장을 삭제할까요?\n입력한 실측·사진이 모두 지워집니다.`)) return;
      S.sites = S.sites.filter(x => x.id !== s.id);
      if (S.curId === s.id) S.curId = S.sites.length ? S.sites[0].id : null;
      save(true); renderAll();
    };
    li.onclick = () => { selectSite(s.id); };
    ul.appendChild(li);
  });
}
function selectSite(id) { S.curId = id; save(); renderAll(); }

/* ══════════════ 8. 렌더 — 기본정보 ══════════════ */
const INFO_FIELDS = ['name', 'client', 'project', 'date', 'addr', 'tel', 'use', 'gong', 'yun', 'yunbase', 'vat', 'remark'];
function renderInfo() {
  const st = cur();
  const dis = !st;
  INFO_FIELDS.forEach(k => {
    const el = $('#f_' + k); if (!el) return;
    el.disabled = dis;
    el.value = st ? (st[k] == null ? '' : st[k]) : '';
  });
  const box = $('#gaseolBox'); box.innerHTML = '';
  if (!st) return;
  const G = [['폐자재', '폐자재 처리 (식)'], ['보양', '현장보양 (식)'], ['정리정돈', '현장 정리정돈 (식)'], ['철거', '철거 (식)'], ['관리일수', '현장관리비 (일수)']];
  G.forEach(([k, lab]) => {
    const d = document.createElement('div');
    d.innerHTML = `<label>${lab}</label><input type="number" min="0" step="1" value="${num(st.gaseol[k])}">`;
    d.querySelector('input').oninput = e => { st.gaseol[k] = num(e.target.value); save(); };
    box.appendChild(d);
  });
  // 현장 공통 옵션 — 간판 · 특수도장
  st.options = st.options || { sign: 0, paintSpecial: 0, scaffold: 0 };
  const OPTF = [['sign', '간판 채널형 (식)'], ['paintSpecial', '특수도장 아트월·곡면 (㎡)'], ['scaffold', '이동식 비계 (조)']];
  OPTF.forEach(([k, lab]) => {
    const d = document.createElement('div');
    d.innerHTML = `<label>${lab}</label><input type="number" min="0" step="1" value="${num(st.options[k])}">`;
    d.querySelector('input').oninput = e => { st.options[k] = num(e.target.value); save(); };
    box.appendChild(d);
  });
}
INFO_FIELDS.forEach(k => {
  document.addEventListener('DOMContentLoaded', () => {
    const el = $('#f_' + k); if (!el) return;
    el.oninput = el.onchange = () => {
      const st = cur(); if (!st) return;
      st[k] = (['gong', 'yun', 'vat'].indexOf(k) >= 0) ? num(el.value) : el.value;
      if (k === 'name') { renderSites(); updHeader(); }
      save();
    };
  });
});

/* ══════════════ 9. 렌더 — 실측(방) ══════════════ */
function opt(list, sel, fmt) {
  return list.map(o => `<option value="${esc(o.v)}"${o.v === sel ? ' selected' : ''}>${esc(fmt ? fmt(o) : o.t)}</option>`).join('');
}
function renderRooms() {
  const wrap = $('#roomList'); wrap.innerHTML = '';
  const st = cur();
  $('#roomEmpty').style.display = (st && st.rooms.length) ? 'none' : 'block';
  if (!st) { $('#roomEmpty').textContent = '먼저 [현장] 탭에서 현장을 선택하거나 추가하세요.'; return; }
  $('#roomEmpty').textContent = '방을 추가하고 가로·세로·높이를 입력하면 견적이 자동 계산됩니다.';

  const wallM = wallMatrix('칸막이'), ceilM = wallMatrix('천장');
  const wallOpts = [{ v: '', t: '— 방음벽 없음 —' }].concat(
    dedupeBase(wallM).map(b => ({ v: b, t: b.replace('방음벽-칸막이', '칸막이 ') })));
  const ceilOpts = [{ v: '', t: '— 천장 방음 없음 —' }].concat(
    dedupeBase(ceilM).map(b => ({ v: b, t: b.replace('방음벽-천장', '천장 ') })));

  const absWallOpts = [{ v: '', t: '— 없음 —' }].concat(byUnit('방음', '㎡')
    .filter(x => !/시공비|부자재|조이너/.test(x.n))
    .map(x => ({ v: pkey(x), t: `${x.n}${x.s ? ' ' + x.s : ''} (${won(x.p)}원/㎡)` })));
  const floorOpts = [{ v: '', t: '— 없음 —' }].concat(byUnit('마감', '㎡')
    .filter(x => /마루|타일|카펫|한바닥/.test(x.n))
    .map(x => ({ v: pkey(x), t: `${x.n}${x.s ? ' ' + x.s : ''} (${won(x.p)}원/㎡)` })));
  const doorOpts = [{ v: '', t: '— 선택 —' }].concat(
    PRICES.filter(x => (x.g === '하드웨어' && /문/.test(x.n) && !/설치|개당/.test(x.n)) || (x.g === '목공' && /목문|문틀/.test(x.n) && !/시공비/.test(x.n)))
      .map(x => ({ v: pkey(x), t: `${x.n}${x.s ? ' ' + x.s : ''} (${won(x.p)}원)` })));
  const winOpts = [{ v: '', t: '— 선택 —' }].concat(
    PRICES.filter(x => x.g === '하드웨어' && /창/.test(x.n) && !/설치/.test(x.n))
      .map(x => ({ v: pkey(x), t: `${x.n}${x.s ? ' ' + x.s : ''} (${won(x.p)}원)` })));

  let fixed = false;
  st.rooms.forEach((r, idx) => {
    const A = calcArea(r);
    const plyW = plyOptions(wallM, r.wallBase), plyC = plyOptions(ceilM, r.ceilBase);
    // 화면에 보이는 값과 실제 저장값이 어긋나지 않도록 보정.
    // (select는 selected가 없으면 첫 항목을 보여주지만 상태는 비어 있게 됨)
    if (!plyW.some(o => o.v === r.wallPly)) { r.wallPly = plyW[0].v; fixed = true; }
    if (!plyC.some(o => o.v === r.ceilPly)) { r.ceilPly = plyC[0].v; fixed = true; }
    const isH = num(r.H) >= H_LIMIT;

    const d = document.createElement('details');
    d.className = 'room';
    // 폰은 화면이 좁아 전부 펼치면 스크롤이 감당이 안 된다 → 기본 접힘, 노트북은 기본 펼침
    const narrow = window.matchMedia('(max-width:620px)').matches;
    d.open = (r._open === undefined) ? !narrow : r._open;
    d.ontoggle = () => { r._open = d.open; };
    d.innerHTML = `
      <summary>
        <span data-nm>${idx + 1}. ${esc(r.name)}</span>
        <span class="chip" data-sz>${m2(A.floor)}㎡ · ${(A.pyeong).toFixed(1)}평</span>
        <span data-hchip>${isH ? '<span class="chip w">고천장 -H</span>' : ''}</span>
        <span class="right muted" data-dim>${r.W}×${r.D}×${r.H}</span>
      </summary>
      <div class="body">
        <div class="grid g4">
          <div style="grid-column:1/-1"><label>방 이름</label><input data-f="name" value="${esc(r.name)}"></div>
          <div><label>가로 W (mm)</label><input type="number" data-f="W" value="${r.W}"></div>
          <div><label>세로 D (mm)</label><input type="number" data-f="D" value="${r.D}"></div>
          <div><label>높이 H (mm)</label><input type="number" data-f="H" value="${r.H}"></div>
          <div><label>방음 벽면 수</label>
            <select data-f="wallSides">${opt([1, 2, 3, 4].map(n => ({ v: String(n), t: n + '면' })), String(r.wallSides))}</select>
          </div>
        </div>

        <div class="calcbox" data-calc>${calcBoxHtml(A, isH)}</div>
        <div class="grid g2">
          <div><label>벽 시공길이 직접입력 (m, 비우면 자동)</label><input type="number" step="0.01" data-f="wallLen" data-lenin value="${r.wallLen || ''}" placeholder="자동: ${m2(A.perim * r.wallSides / 4)}"></div>
          <div></div>
        </div>

        <h3>방음 구조 (목공사)</h3>
        <div class="grid g4">
          <div style="grid-column:span 2"><label>벽 방음 구성</label>
            <select data-f="wallBase">${opt(wallOpts, r.wallBase)}</select></div>
          <div><label>석고</label><select data-f="wallPly">${opt(plyW, r.wallPly)}</select></div>
          <div><label>적용단가</label><input data-wallprice value="${wallPriceLabel(r.wallBase, r.wallPly, r.H)}" readonly></div>

          <div style="grid-column:span 2"><label>천장 방음 구성</label>
            <select data-f="ceilBase">${opt(ceilOpts, r.ceilBase)}</select></div>
          <div><label>석고</label><select data-f="ceilPly">${opt(plyC, r.ceilPly)}</select></div>
          <div><label>적용단가</label><input data-ceilprice value="${wallPriceLabel(r.ceilBase, r.ceilPly, r.H)}" readonly></div>
          <div><label>천장보강재 (ea)</label><input type="number" min="0" data-f="ceilBogang" value="${r.ceilBogang}"></div>
        </div>

        <h3>흡음 · 마감재</h3>
        <div class="grid g4">
          <div style="grid-column:span 2"><label>벽면 흡음/마감재</label><select data-f="absWall">${opt(absWallOpts, r.absWall)}</select></div>
          <div><label>적용률 (%)</label><input type="number" min="0" max="100" data-f="absWallRatio" value="${r.absWallRatio}"></div>
          <div><label>천장 흡음재</label><select data-f="absCeil">${opt(absWallOpts, r.absCeil)}</select></div>
          <div style="grid-column:span 2"><label>바닥 마감</label><select data-f="floor">${opt(floorOpts, r.floor)}</select></div>
          <div style="grid-column:span 2"><label>뜬바닥 (뜬구조)</label>
            <select data-f="floating">${opt([{ v: '0', t: '— 없음 —' }, { v: '1', t: '시공 (95,000원/㎡)' }], r.floating ? '1' : '0')}</select></div>
          <div style="grid-column:span 2"><label>벽 마감</label>
            <select data-f="wallFin">${opt([{ v: '', t: '— 없음 —' }, { v: '도배', t: '도배 (합지)' }, { v: '필름', t: '필름' }, { v: '도장', t: '도장' }], r.wallFin)}</select></div>
        </div>

        <h3>문 · 창</h3>
        <div data-list="doors"></div>
        <div class="row" style="margin:6px 0 12px"><button class="btn ghost sm" data-add="doors">+ 문 추가</button></div>
        <div data-list="wins"></div>
        <div class="row" style="margin:6px 0 0"><button class="btn ghost sm" data-add="wins">+ 창 추가</button></div>

        <h3>설비</h3>
        <div class="grid g4">
          <div><label>조명 (ea)</label><input type="number" min="0" data-f="lights" value="${r.lights}"></div>
          <div><label>천장 등 입선</label><select data-f="ipseon">${opt([{ v: '0', t: '없음' }, { v: '1', t: '포함' }], r.ipseon ? '1' : '0')}</select></div>
          <div><label>전기 신설 (㎡)</label><select data-f="wiring">${opt([{ v: '0', t: '— 없음 —' }, { v: '1', t: '전체 신설 (90,000원/㎡)' }], r.wiring ? '1' : '0')}</select></div>
          <div><label>화재감지기 (ea)</label><input type="number" min="0" data-f="detector" value="${r.detector}"></div>
          <div><label>스프링클러 (ea)</label><input type="number" min="0" data-f="sprinkler" value="${r.sprinkler}"></div>
          <div><label>냉난방기 (ea)</label><input type="number" min="0" data-f="aircon" value="${r.aircon}"></div>
        </div>

        <h3>옵션 <span class="muted" style="font-weight:400">— 본 견적과 분리해 별지로 뽑을 수 있습니다</span></h3>
        <div class="grid g4">
          <div><label>레일·포인트조명 (식)</label><input type="number" min="0" data-f="railLight" value="${r.railLight || 0}"></div>
          <div><label>걸레받이 몰딩</label><select data-f="molding">${opt(MOLDING_OPTS(r.molding), r.molding)}</select></div>
        </div>

        <h3>현장 사진</h3>
        <div class="row">
          <input type="file" accept="image/*" capture="environment" multiple data-photo hidden>
          <button class="btn ghost sm" data-shot>📷 사진 추가</button>
          <span class="muted">${r.photos.length}장</span>
        </div>
        <div class="photos" data-gal></div>

        <h3>메모</h3>
        <textarea data-f="memo" placeholder="특이사항, 기존 구조, 요청사항">${esc(r.memo)}</textarea>

        <div class="row" style="margin-top:12px">
          <button class="btn ghost sm" data-dup>이 방 복제</button>
          <button class="btn dan sm right" data-del>방 삭제</button>
        </div>
      </div>`;

    /* 필드 바인딩 */
    $$('[data-f]', d).forEach(el => {
      const f = el.dataset.f;
      el.oninput = el.onchange = () => {
        const numeric = ['W', 'D', 'H', 'wallSides', 'wallLen', 'ceilBogang', 'absWallRatio', 'lights', 'detector', 'sprinkler', 'aircon', 'railLight'];
        if (f === 'ipseon' || f === 'floating' || f === 'wiring') r[f] = el.value === '1';
        else if (numeric.indexOf(f) >= 0) r[f] = num(el.value);
        else r[f] = el.value;
        save();
        // 화면 전체를 다시 그리면 입력 중 포커스와 스크롤이 날아간다.
        // 구성(석고 선택지)이 바뀌는 항목만 재렌더하고, 나머지는 제자리 갱신.
        if (f === 'wallBase' || f === 'ceilBase') { renderRoomsKeepScroll(); return; }
        if (f === 'name') { renderSites(); updHeader(); }
        roomDerived(r, d, idx);
      };
    });
    /* 문/창 목록 */
    ['doors', 'wins'].forEach(kind => {
      const host = $(`[data-list=${kind}]`, d);
      const opts = kind === 'doors' ? doorOpts : winOpts;
      const label = kind === 'doors' ? '문' : '창';
      r[kind].forEach((row, i) => {
        const div = document.createElement('div');
        div.className = 'row'; div.style.marginBottom = '6px';
        div.innerHTML = `<select style="flex:1;min-width:180px">${opt(opts, row.key)}</select>
          <input type="number" min="0" value="${row.qty}" style="width:80px" title="${label} 개수">
          <button class="btn dan sm">×</button>`;
        div.children[0].onchange = e => { row.key = e.target.value; save(); roomDerived(r, d, idx); };
        div.children[1].oninput = e => { row.qty = num(e.target.value); save(); roomDerived(r, d, idx); };
        div.children[2].onclick = () => { r[kind].splice(i, 1); save(); renderRoomsKeepScroll(); };
        host.appendChild(div);
      });
      $(`[data-add=${kind}]`, d).onclick = () => { r[kind].push({ key: '', qty: 1 }); save(); renderRoomsKeepScroll(); };
    });
    /* 사진 */
    const fi = $('[data-photo]', d), gal = $('[data-gal]', d);
    $('[data-shot]', d).onclick = () => fi.click();
    fi.onchange = async e => {
      for (const f of e.target.files) { try { r.photos.push(await shrink(f)); } catch (err) { console.error(err); } }
      e.target.value = ''; save(true); renderRoomsKeepScroll();
    };
    r.photos.forEach((src, i) => {
      const fg = document.createElement('figure');
      fg.innerHTML = `<img src="${src}" alt=""><button>×</button>`;
      fg.querySelector('button').onclick = () => { r.photos.splice(i, 1); save(true); renderRoomsKeepScroll(); };
      gal.appendChild(fg);
    });
    /* 복제 / 삭제 */
    $('[data-dup]', d).onclick = () => {
      const c = JSON.parse(JSON.stringify(r)); c.id = uid(); c.name = r.name + ' 사본';
      st.rooms.splice(idx + 1, 0, c); save(); renderRoomsKeepScroll(); updHeader(); renderSites();
    };
    $('[data-del]', d).onclick = () => {
      if (!confirm(`"${r.name}" 방을 삭제할까요?`)) return;
      st.rooms.splice(idx, 1); save(); renderRoomsKeepScroll(); updHeader(); renderSites();
    };
    wrap.appendChild(d);
  });
  if (fixed) save();
}
/* 실측값에서 파생되는 표시만 제자리에서 갱신 (재렌더 없음 → 포커스·스크롤 유지) */
function calcBoxHtml(A, isH) {
  return `바닥·천장 <b>${m2(A.floor)}㎡</b> (${A.pyeong.toFixed(1)}평) ·
          둘레 <b>${m2(A.perim)}m</b> ·
          벽 시공길이 <b>${m2(A.len)}m</b> →
          벽면적 <b>${m2(A.wallGross)}㎡</b> − 개구부 <b>${m2(A.open)}㎡</b> =
          <b>${m2(A.wall)}㎡</b>
          ${isH ? ' · 높이 ' + H_LIMIT + 'mm 이상 → <b>-H 단가 자동적용</b>' : ''}`;
}
function roomDerived(r, d, idx) {
  const A = calcArea(r), isH = num(r.H) >= H_LIMIT;
  const q = sel => d.querySelector(sel);
  const nm = q('[data-nm]');    if (nm) nm.textContent = `${idx + 1}. ${r.name}`;
  const sz = q('[data-sz]');    if (sz) sz.textContent = `${m2(A.floor)}㎡ · ${A.pyeong.toFixed(1)}평`;
  const hc = q('[data-hchip]'); if (hc) hc.innerHTML = isH ? '<span class="chip w">고천장 -H</span>' : '';
  const dm = q('[data-dim]');   if (dm) dm.textContent = `${r.W}×${r.D}×${r.H}`;
  const cb = q('[data-calc]');  if (cb) cb.innerHTML = calcBoxHtml(A, isH);
  const ln = q('[data-lenin]'); if (ln) ln.placeholder = `자동: ${m2(A.perim * num(r.wallSides) / 4)}`;
  const wp = q('[data-wallprice]'); if (wp) wp.value = wallPriceLabel(r.wallBase, r.wallPly, r.H);
  const cp = q('[data-ceilprice]'); if (cp) cp.value = wallPriceLabel(r.ceilBase, r.ceilPly, r.H);
}
/* 재렌더가 꼭 필요할 때는 스크롤 위치를 지켜준다 */
function renderRoomsKeepScroll() {
  const y = window.scrollY;
  renderRooms();
  window.scrollTo(0, y);
}
function dedupeBase(mat) { return Array.from(new Set(mat.map(x => x.base))); }
function plyOptions(mat, base) {
  const list = Array.from(new Set(mat.filter(x => x.base === base).map(x => x.ply)));
  return list.length ? list.map(p => ({ v: p, t: p })) : [{ v: '', t: '—' }];
}
function wallPriceLabel(base, ply, H) {
  if (!base || !ply) return '—';
  const w = resolveWall(base, ply, num(H));
  if (!w) return '단가 없음';
  return `${won(w.item.p)}원/㎡${w.fallback ? ' (대체)' : ''}${w.item.n.endsWith('-H') ? ' [H]' : ''}`;
}
/* 사진 리사이즈 */
function shrink(file, max = 1100, q = 0.72) {
  return new Promise((res, rej) => {
    const img = new Image(), url = URL.createObjectURL(file);
    img.onload = () => {
      const sc = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * sc); c.height = Math.round(img.height * sc);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      res(c.toDataURL('image/jpeg', q));
    };
    img.onerror = e => { URL.revokeObjectURL(url); rej(e); };
    img.src = url;
  });
}

/* ══════════════ 10. 렌더 — 견적서 ══════════════ */
let LAST = null;
function renderEst() {
  const out = $('#estOut');
  const E = buildEstimate();
  LAST = E;
  if (!E) { out.innerHTML = '<div class="empty">먼저 현장을 선택하세요.</div>'; return; }
  const st = E.st;
  if (!E.groups.length) { out.innerHTML = '<div class="empty">실측 정보를 입력하면 견적이 생성됩니다.</div>'; return; }

  let h = '';
  if (E.notes.length) h += `<div class="warnbox noprint"><b>확인이 필요합니다</b><br>${E.notes.map(esc).join('<br>')}</div>`;

  /* 표지 */
  h += `<div class="card"><h2>견 적 서 &nbsp;ESTIMATE</h2>
    <table>
      <tr><th style="width:38%">날짜 / DATE</th><td>${esc(st.date)}</td></tr>
      <tr><th>의뢰인 / CLIENT</th><td>${esc(st.client)}</td></tr>
      <tr><th>작업명 / PROJECT</th><td>${esc(st.project)}</td></tr>
      <tr><th>현장 주소</th><td>${esc(st.addr)}</td></tr>
      <tr class="tot"><td>금액 / AMOUNT</td><td>${won(E.total)} 원${num(st.vat) ? ' (VAT 포함)' : ' (VAT 별도)'}</td></tr>
    </table>
    <h3>공급자</h3>
    <table>
      <tr><th style="width:38%">상호</th><td>청 풍</td></tr>
      <tr><th>주소</th><td>경기도 안산시 상록구 오목로11길 10 102호</td></tr>
      <tr><th>연락처</th><td>010-4867-4442</td></tr>
      <tr><th>EMAIL</th><td>chpoong22@gmail.com</td></tr>
    </table>
    <h3>원가 구성</h3>
    <div class="scroll"><table>
      <tr><th style="width:170px">구 분</th><th>구 성 비</th><th class="n" style="width:140px">금 액</th></tr>
      <tr><td>1. 직접 공사비</td><td></td><td class="n">${won(E.direct)}</td></tr>
      <tr><td>2. 공과잡비</td><td>${num(st.gong) ? '직접 공사비의 ' + st.gong + '%' : '—'}</td><td class="n">${won(E.gong)}</td></tr>
      <tr><td>3. 기업이윤</td><td>${(st.yunbase === 'sum' ? '직접+공과잡비의 ' : '직접 공사비의 ') + st.yun + '%'}</td><td class="n">${won(E.yun)}</td></tr>
      <tr><td>4. 부가가치세 (V.A.T)</td><td>${num(st.vat) ? '합계금액의 10%' : '별도'}</td><td class="n">${num(st.vat) ? won(E.vat) : '별도'}</td></tr>
      <tr class="tot"><td>5. 총 공사비</td><td></td><td class="n">${won(E.total)}</td></tr>
    </table></div>
    ${st.remark ? `<h3>REMARK</h3><div class="muted" style="white-space:pre-wrap">${esc(st.remark)}</div>` : ''}
  </div>`;

  /* 집계표 */
  h += `<div class="card"><h2>집계표</h2><div class="scroll"><table>
    <tr><th class="n" style="width:50px">번호</th><th>품 명</th><th class="n" style="width:60px">단위</th><th class="n" style="width:60px">수량</th><th class="n" style="width:130px">금 액</th></tr>`;
  E.groups.forEach((g, i) => {
    h += `<tr><td class="n">${i + 1}</td><td>${esc(g.name)}</td><td class="n">식</td><td class="n">1</td><td class="n">${won(g.sum)}</td></tr>`;
  });
  h += `<tr class="tot"><td></td><td>합 계</td><td></td><td></td><td class="n">${won(E.direct)}</td></tr></table></div></div>`;

  /* 상세내역 */
  h += `<div class="card"><h2>상세 내역</h2>`;
  E.groups.forEach((g, i) => {
    h += `<div class="scroll wide" style="margin-bottom:14px"><table>
      <tr><th class="n" style="width:44px">NO</th><th>품 명</th><th style="width:150px">규 격</th><th class="n" style="width:52px">단위</th><th class="n" style="width:76px">수량</th><th class="n" style="width:96px">단가</th><th class="n" style="width:120px">금액</th><th style="width:130px">비고</th></tr>
      <tr class="grp"><td class="n">${i + 1}</td><td colspan="7">${esc(g.name)}</td></tr>`;
    g.items.forEach(it => {
      h += `<tr><td></td><td>${esc(it.n)}</td><td>${esc(it.s)}</td><td class="n">${esc(it.u)}</td>
        <td class="n">${it.qty.toLocaleString('ko-KR')}</td><td class="n">${won(it.p)}</td>
        <td class="n">${won(it.amt)}</td><td class="muted">${esc(it.remark)}</td></tr>`;
    });
    h += `<tr class="sum"><td></td><td>소 계</td><td colspan="4"></td><td class="n">${won(g.sum)}</td><td></td></tr></table></div>`;
  });
  h += `</div>`;

  /* 산출근거 */
  h += `<div class="card"><h2>실별 면적 산출근거</h2><div class="scroll wide"><table>
    <tr><th>실 명</th><th class="n">W×D×H (mm)</th><th class="n">바닥/천장</th><th class="n">평</th><th class="n">둘레</th><th class="n">벽 시공길이</th><th class="n">개구부</th><th class="n">순 벽면적</th></tr>`;
  E.areas.forEach(({ room, A }) => {
    h += `<tr><td>${esc(room.name)}</td><td class="n">${room.W}×${room.D}×${room.H}</td>
      <td class="n">${m2(A.floor)}㎡</td><td class="n">${A.pyeong.toFixed(1)}</td>
      <td class="n">${m2(A.perim)}m</td><td class="n">${m2(A.len)}m</td>
      <td class="n">${m2(A.open)}㎡</td><td class="n">${m2(A.wall)}㎡</td></tr>`;
  });
  h += `</table></div><p class="muted">개구부 공제 기준: 문 ${OPEN_DOOR}㎡/개, 창 ${OPEN_WIN}㎡/개</p></div>`;

  out.innerHTML = h;
}

/* ══════════════ 11. 렌더 — 단가표 ══════════════ */
function renderPrices() {
  const q = ($('#priceSearch').value || '').trim();
  const t = $('#priceTable');
  const eb = $('#priceEmpty');
  if (eb) eb.innerHTML = hasPrices() ? '' :
    `<div class="warnbox" style="background:#fdecea;border-color:#e4a09a">
       <b>이 기기에 단가표가 없습니다.</b><br>
       위 <b>[단가표 불러오기]</b> 를 눌러 <b>청풍-단가표.json</b> 파일을 읽어오세요.
       한 번만 하면 이 기기에 저장되어 계속 쓰입니다.
     </div>`;
  let h = `<tr><th style="width:80px">공종</th><th>품 명</th><th style="width:150px">규 격</th><th class="n" style="width:52px">단위</th><th class="n" style="width:120px">단가</th></tr>`;
  PRICES.forEach((it, i) => {
    if (q && (it.n + it.s + it.g).indexOf(q) < 0) return;
    h += `<tr><td>${esc(it.g)}</td><td>${esc(it.n)}</td><td>${esc(it.s)}</td><td class="n">${esc(it.u)}</td>
      <td class="n"><input type="number" data-i="${i}" value="${it.p}" style="text-align:right;padding:3px 5px;font-size:13px${it.edited ? ';border-color:#a8620a;background:#fff8ee' : ''}"></td></tr>`;
  });
  t.innerHTML = h;
  $$('input[data-i]', t).forEach(el => {
    el.onchange = () => {
      const it = PRICES[+el.dataset.i];
      const v = num(el.value);
      const base = basePrices().find(x => pkey(x) === pkey(it));
      if (base && v === base.p) delete S.priceOverride[pkey(it)];
      else S.priceOverride[pkey(it)] = v;
      buildPrices(); save(); renderPrices(); renderRooms();
    };
  });
}

/* ══════════════ 12. 엑셀 (.xlsx) 내보내기 ══════════════ */
const CRC = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {  // files: [{name, data:Uint8Array}] — 무압축(store)
  const enc = new TextEncoder(); const chunks = []; const dir = []; let off = 0;
  const u32 = v => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
  const u16 = v => [v & 255, (v >> 8) & 255];
  files.forEach(f => {
    const nm = enc.encode(f.name), c = crc32(f.data), n = f.data.length;
    const lh = new Uint8Array([].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(c), u32(n), u32(n), u16(nm.length), u16(0)));
    chunks.push(lh, nm, f.data);
    dir.push({ nm, c, n, off });
    off += lh.length + nm.length + n;
  });
  const cd = []; let cdLen = 0;
  dir.forEach(d => {
    const h = new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0), u32(d.c), u32(d.n), u32(d.n), u16(d.nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(d.off)));
    cd.push(h, d.nm); cdLen += h.length + d.nm.length;
  });
  const end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(dir.length), u16(dir.length), u32(cdLen), u32(off), u16(0)));
  const all = chunks.concat(cd, [end]);
  const total = all.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(total); let p = 0;
  all.forEach(x => { out.set(x, p); p += x.length; });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
const X = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const COL = i => { let s = '', n = i; while (n >= 0) { s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26) - 1; } return s; };

/* 스타일 인덱스: 0 기본 / 1 굵게 / 2 제목 / 3 테두리 / 4 헤더 / 5 숫자 / 6 숫자굵게 */
function sheetXml(rows) {
  let x = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><cols>
<col min="1" max="1" width="6"/><col min="2" max="2" width="30"/><col min="3" max="3" width="20"/>
<col min="4" max="4" width="7"/><col min="5" max="5" width="10"/><col min="6" max="6" width="13"/>
<col min="7" max="7" width="15"/><col min="8" max="8" width="18"/></cols><sheetData>`;
  rows.forEach((row, ri) => {
    x += `<row r="${ri + 1}">`;
    row.forEach((c, ci) => {
      if (c == null || c === '') return;
      const ref = COL(ci) + (ri + 1);
      const v = (typeof c === 'object') ? c.v : c;
      const st = (typeof c === 'object') ? c.s : (typeof c === 'number' ? 5 : 3);
      if (typeof v === 'number') x += `<c r="${ref}" s="${st}"><v>${v}</v></c>`;
      else x += `<c r="${ref}" s="${st}" t="inlineStr"><is><t xml:space="preserve">${X(v)}</t></is></c>`;
    });
    x += `</row>`;
  });
  return x + `</sheetData></worksheet>`;
}
function exportXlsx() {
  const E = LAST || buildEstimate();
  if (!E || !E.groups.length) { alert('먼저 견적을 계산하세요. (실측 정보가 필요합니다)'); return; }
  const st = E.st;
  const T = v => ({ v, s: 2 }), B = v => ({ v, s: 4 }), N = v => ({ v, s: 5 }), NB = v => ({ v, s: 6 }), C = v => ({ v, s: 3 });
  const R = [];
  R.push([T('견 적 서  ESTIMATE')]);
  R.push([]);
  R.push([C('날   짜/DATE'), C(st.date), '', '', '', C('상호'), C('청 풍')]);
  R.push([C('의뢰인/CLIENT'), C(st.client), '', '', '', C('주소'), C('경기도 안산시 상록구 오목로11길 10 102호')]);
  R.push([C('작업명/PROJECT'), C(st.project), '', '', '', C('H.P'), C('010-4867-4442')]);
  R.push([C('현장주소'), C(st.addr), '', '', '', C('EMAIL'), C('chpoong22@gmail.com')]);
  R.push([C('금   액/AMOUNT'), NB(E.total)]);
  R.push([]);
  R.push([B('구  분'), B('구  성  비'), '', '', '', '', B('금  액')]);
  R.push([C('1.직접 공사비'), C(''), '', '', '', '', N(E.direct)]);
  R.push([C('2.공과잡비'), C(num(st.gong) ? `직접 공사비의 ${st.gong}%` : ''), '', '', '', '', N(E.gong)]);
  R.push([C('3.기업이윤'), C((st.yunbase === 'sum' ? '직접+공과잡비의 ' : '직접 공사비의 ') + st.yun + '%'), '', '', '', '', N(E.yun)]);
  R.push([C('4.부가가치세(V.A.T)'), C(num(st.vat) ? '합계금액의 10%' : '별도'), '', '', '', '', num(st.vat) ? N(E.vat) : C('별도')]);
  R.push([B('5.총 공사비'), C(''), '', '', '', '', NB(E.total)]);
  if (st.remark) { R.push([]); R.push([B('REMARK')]); st.remark.split('\n').forEach(l => R.push(['', C(l)])); }

  R.push([]); R.push([B('집계표')]);
  const HD = [B('번호 NO.'), B('품     명 DESCRIPTION'), B('규 격  SIZE'), B('단위UNIT'), B("수량 Q`TY"), B('단  가 UNIT PRICE'), B('금   액 AMOUNT'), B('비 고 REMARK')];
  R.push(HD.slice());
  E.groups.forEach((g, i) => R.push([N(i + 1), C(g.name), C(''), C('식'), N(1), C(''), N(g.sum), C('')]));
  R.push([C('-'), B('합              계'), C(''), C(''), C(''), C(''), NB(E.direct), C('')]);

  R.push([]); R.push([B('상세 내역')]);
  E.groups.forEach((g, i) => {
    R.push([]); R.push(HD.slice());
    R.push([N(i + 1), B(g.name), C(''), C(''), C(''), C(''), C(''), C('')]);
    g.items.forEach(it => R.push([C(''), C(it.n), C(it.s), C(it.u), N(it.qty), N(it.p), N(it.amt), C(it.remark)]));
    R.push([C(''), B('소  계'), C(''), C(''), C(''), C(''), NB(g.sum), C('')]);
  });

  R.push([]); R.push([B('실별 면적 산출근거')]);
  R.push([B('실 명'), B('W×D×H (mm)'), B('바닥/천장(㎡)'), B('평'), B('둘레(m)'), B('벽 시공길이(m)'), B('개구부(㎡)'), B('순 벽면적(㎡)')]);
  E.areas.forEach(({ room, A }) => R.push([C(room.name), C(`${room.W}×${room.D}×${room.H}`),
    N(+m2(A.floor)), N(+A.pyeong.toFixed(1)), N(+m2(A.perim)), N(+m2(A.len)), N(+m2(A.open)), N(+m2(A.wall))]));

  const enc = new TextEncoder(), U = s => enc.encode(s);
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="3"><font><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="10"/><name val="맑은 고딕"/></font><font><b/><sz val="15"/><name val="맑은 고딕"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEEF3F7"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"/><right style="thin"/><top style="thin"/><bottom style="thin"/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyBorder="1" applyFill="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="3" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyNumberFormat="1"><alignment horizontal="right" vertical="center"/></xf>
<xf numFmtId="3" fontId="1" fillId="2" borderId="1" xfId="0" applyBorder="1" applyFill="1" applyNumberFormat="1"><alignment horizontal="right" vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
  const files = [
    { name: '[Content_Types].xml', data: U(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`) },
    { name: '_rels/.rels', data: U(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`) },
    { name: 'xl/workbook.xml', data: U(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="견적서" sheetId="1" r:id="rId1"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: U(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`) },
    { name: 'xl/styles.xml', data: U(styles) },
    { name: 'xl/worksheets/sheet1.xml', data: U(sheetXml(R)) }
  ];
  const d = (st.date || today()).replace(/-/g, '').slice(2);
  dl(zip(files), `${d}청풍-${(st.name || '현장').replace(/[\\/:*?"<>|]/g, '')} 견적서.xlsx`);
}
function dl(blob, name) {
  const a = document.createElement('a'), u = URL.createObjectURL(blob);
  a.href = u; a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(u); a.remove(); }, 1500);
}

/* ══════════════ 13. 탭 / 초기화 ══════════════ */
function go(p) {
  $$('nav button').forEach(b => b.classList.toggle('on', b.dataset.p === p));
  $$('.page').forEach(s => s.classList.toggle('on', s.id === 'p-' + p));
  if (p === 'est') renderEst();
  if (p === 'prices') renderPrices();
  if (p === 'rooms') renderRooms();
  if (p === 'info') renderInfo();
  window.scrollTo(0, 0);
}
function updHeader() {
  const st = cur();
  $('#hdSub').innerHTML = st
    ? `${esc(st.name)}<br>방 ${st.rooms.length}개`
    : '현장을 선택하세요';
}
function renderAll() { buildPrices(); renderSites(); renderInfo(); renderRooms(); updHeader(); }

document.addEventListener('DOMContentLoaded', async () => {
  try { const saved = await DB.get('state'); if (saved) S = Object.assign(S, saved); } catch (e) { console.error(e); }
  S.priceOverride = S.priceOverride || {};
  if (!S.sites.length) { const s = newSite('새 현장'); S.sites.push(s); S.curId = s.id; }
  if (!S.curId) S.curId = S.sites[0].id;

  $$('nav button').forEach(b => b.onclick = () => go(b.dataset.p));
  $('#btnNewSite').onclick = () => {
    const n = ($('#newSiteName').value || '').trim() || '새 현장';
    const s = newSite(n); S.sites.unshift(s); S.curId = s.id;
    $('#newSiteName').value = ''; save(true); renderAll(); go('info');
  };
  $('#btnAddRoom').onclick = () => {
    const st = cur(); if (!st) { alert('먼저 현장을 선택하세요.'); return; }
    const n = ($('#newRoomName').value || '').trim() || `실 ${st.rooms.length + 1}`;
    st.rooms.push(newRoom(n)); $('#newRoomName').value = '';
    save(); renderRooms(); updHeader(); renderSites();
  };
  $('#btnExpandAll').onclick = () => {
    const st = cur(); if (!st) return;
    const anyOpen = $$('#roomList details').some(d => d.open);
    $$('#roomList details').forEach((d, i) => { d.open = !anyOpen; if (st.rooms[i]) st.rooms[i]._open = !anyOpen; });
    $('#btnExpandAll').textContent = anyOpen ? '전체 펼치기' : '전체 접기';
    save();
  };
  $('#btnCalc').onclick = renderEst;
  $('#btnPrint').onclick = () => { renderEst(); setTimeout(() => window.print(), 120); };
  $('#btnXlsx').onclick = () => { renderEst(); setTimeout(exportXlsx, 60); };
  $('#priceSearch').oninput = renderPrices;
  $('#btnPriceReset').onclick = () => {
    if (!confirm('수정한 단가를 모두 원본으로 되돌릴까요?')) return;
    S.priceOverride = {}; buildPrices(); save(true); renderPrices(); renderRooms();
  };
  /* ── 단가표 파일 불러오기 / 내보내기 ── */
  $('#btnPriceLoad').onclick = () => $('#filePrice').click();
  $('#filePrice').onchange = async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      const items = Array.isArray(d) ? d : d.items;
      if (!Array.isArray(items) || !items.length) throw new Error('단가표 파일이 아닙니다');
      const bad = items.find(x => !x || typeof x.p !== 'number' || !x.g || !x.n);
      if (bad) throw new Error('형식이 올바르지 않습니다');
      if (hasPrices() && !confirm(`현재 단가표(${basePrices().length}품목)를 불러온 것(${items.length}품목)으로 바꿉니다. 계속할까요?`)) return;
      S.priceTable = items;
      buildPrices(); save(true); renderPrices(); renderRooms();
      alert(`단가표 ${items.length}품목을 불러왔습니다.
이 기기에 저장되어 다음부터는 바로 쓸 수 있습니다.`);
    } catch (err) { alert('단가표 불러오기 실패: ' + err.message); }
  };
  $('#btnPriceSave').onclick = () => {
    if (!hasPrices()) { alert('먼저 단가표를 불러오세요.'); return; }
    const items = basePrices().map(it => {
      const ov = S.priceOverride[pkey(it)];
      return Object.assign({}, it, typeof ov === 'number' ? { p: ov } : {});
    });
    dl(new Blob([JSON.stringify({ type: 'cheongpung-prices', v: 1, made: today(), items }, null, 1)],
      { type: 'application/json' }), `청풍-단가표_${today().replace(/-/g, '')}.json`);
  };

  $('#btnExportAll').onclick = () => {
    dl(new Blob([JSON.stringify(S, null, 1)], { type: 'application/json' }),
      `청풍견적_백업_${today().replace(/-/g, '')}.json`);
  };
  $('#btnImportAll').onclick = () => $('#fileImport').click();
  $('#fileImport').onchange = async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const d = JSON.parse(await f.text());
      if (!d.sites) throw new Error('형식이 다릅니다');
      // 기본은 "합치기". 폰에서 딴 현장을 노트북으로 옮길 때 기존 현장이 날아가면 안 된다.
      const merge = confirm(
        `현장 ${d.sites.length}개를 불러옵니다.\n\n` +
        `[확인] 기존 현장은 그대로 두고 합치기 (권장)\n` +
        `[취소] 전부 대체 (기존 현장 ${S.sites.length}개가 지워집니다)`);
      if (merge) {
        let add = 0, upd = 0;
        d.sites.forEach(ns => {
          const i = S.sites.findIndex(x => x.id === ns.id);
          if (i >= 0) {
            if (confirm(`"${ns.name}" 은 이미 있습니다. 불러온 것으로 덮어쓸까요?\n[취소] 하면 별도 현장으로 추가합니다.`)) { S.sites[i] = ns; upd++; }
            else { ns.id = uid(); ns.name = ns.name + ' (불러옴)'; S.sites.unshift(ns); add++; }
          } else { S.sites.unshift(ns); add++; }
        });
        S.curId = S.sites.length ? S.sites[0].id : null;
        save(true); renderAll(); go('sites');
        alert(`불러왔습니다. 추가 ${add}개, 덮어쓰기 ${upd}개.`);
      } else {
        if (!confirm('정말 전부 대체할까요? 되돌릴 수 없습니다.')) return;
        S = Object.assign({ sites: [], curId: null, priceOverride: {} }, d);
        save(true); renderAll(); go('sites');
        alert('대체했습니다.');
      }
    } catch (err) { alert('불러오기 실패: ' + err.message); }
    e.target.value = '';
  };

  renderAll(); go('sites');
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
});
