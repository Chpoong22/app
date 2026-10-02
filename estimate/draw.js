/* 청풍 현장견적 — draw.js
   실측값으로 평면 배치도 / 벽·천장 단면 상세도를 자동 생성합니다.
   app.js 는 건드리지 않고 이 파일만으로 [도면] 탭이 동작합니다. */
'use strict';

/* ══════════ 자재 두께(mm) — 단면도용 ══════════ */
const T_STUD = 75;    // 경량 스터드
const T_GW   = 50;    // 글라스울 충진
const T_GYP  = 9.5;   // 석고보드 1겹
const T_CHA  = 2;     // 차음시트
const T_SLAB = 150;   // 기존 구조체(참고 표기)

/* 흡음·마감재 두께 추정 */
function finThk(it) {
  if (!it) return 0;
  const m = /(\d+)\s*T/i.exec(it.s || '');
  if (m) return parseInt(m[1], 10);
  const n = it.n || '';
  if (/프리보드/.test(n)) return 30;
  if (/칼라보드/.test(n)) return 25;
  if (/아트보드/.test(n)) return 9;
  if (/타공판/.test(n))   return 9;
  if (/마이톤|천장흡음/.test(n)) return 15;
  if (/흡음재/.test(n))   return 50;
  return 12;
}

/* 벽 사양 문자열 해석 */
function wallSpec(base, ply) {
  const opt = (/\(([^)]+)\)/.exec(base || '') || [, ''])[1];
  return {
    both: /양면/.test(opt),
    cha:  /차음/.test(opt),
    ceil: /천장/.test(base || ''),
    gyp:  Math.max(1, parseInt((/(\d+)\s*p/i.exec(ply || '') || [, 1])[1], 10) || 1)
  };
}

/* 단면 레이어 배열 만들기 (실외 → 실내 순) */
function sectionLayers(r, kind) {
  const base = kind === 'ceil' ? r.ceilBase : r.wallBase;
  const ply  = kind === 'ceil' ? r.ceilPly  : r.wallPly;
  const L = [];
  if (!base) return L;
  const sp = wallSpec(base, ply);

  L.push({ t: T_SLAB, n: kind === 'ceil' ? '기존 슬래브' : '기존 벽체 / 인접실', c: '#c9ced6', h: 'concrete', ghost: true });

  if (sp.both) {
    if (sp.cha) L.push({ t: T_CHA, n: '차음시트 2T', c: '#5b6672' });
    for (let i = 0; i < sp.gyp; i++) L.push({ t: T_GYP, n: '석고보드 9.5T', c: '#eae4d8', h: 'gyp' });
  }
  L.push({ t: T_STUD, n: `경량스터드 ${T_STUD}T + 글라스울 ${T_GW}T 충진`, c: '#f6e9b6', h: 'gw' });
  if (sp.cha) L.push({ t: T_CHA, n: '차음시트 2T', c: '#5b6672' });
  for (let i = 0; i < sp.gyp; i++) L.push({ t: T_GYP, n: '석고보드 9.5T', c: '#eae4d8', h: 'gyp' });

  const finKey = kind === 'ceil' ? r.absCeil : r.absWall;
  if (finKey) {
    const it = (typeof PRICES !== 'undefined') ? PRICES.find(x => (x.g + '|' + x.n + '|' + x.s) === finKey) : null;
    if (it) L.push({ t: finThk(it), n: `${it.n}${it.s ? ' ' + it.s : ''}`, c: '#bcd9ee', h: 'abs' });
  }
  return L;
}
function layersThk(L) { return L.filter(x => !x.ghost).reduce((a, x) => a + x.t, 0); }

/* 평면도용 벽 두께 */
function planWallThk(r) {
  const L = sectionLayers(r, 'wall');
  const t = layersThk(L);
  return t > 0 ? t : 100;
}

/* ══════════ 자동 배치 ══════════ */
function autoLayout(st) {
  st.layout = st.layout || {};
  const rooms = st.rooms.filter(r => num(r.W) > 0 && num(r.D) > 0);
  if (!rooms.length) return;
  const totalW = rooms.reduce((a, r) => a + num(r.W), 0);
  const maxRow = Math.max(...rooms.map(r => num(r.W)), Math.sqrt(totalW * Math.max(...rooms.map(r => num(r.D)))) * 1.6);
  let x = 0, y = 0, rowH = 0;
  rooms.forEach(r => {
    const W = num(r.W), D = num(r.D);
    if (x > 0 && x + W > maxRow) { x = 0; y += rowH; rowH = 0; }
    const cfg = st.layout[r.id] || {};
    st.layout[r.id] = { x: x, y: y, door: cfg.door || 'S', win: cfg.win || 'N' };
    x += W; rowH = Math.max(rowH, D);
  });
}

/* ══════════ 평면 배치도 SVG ══════════ */
function planSvg(st, opts) {
  opts = opts || {};
  const showDim = opts.dim !== false, showOpen = opts.open !== false;
  const rooms = st.rooms.filter(r => num(r.W) > 0 && num(r.D) > 0);
  if (!rooms.length) return '<p class="empty">실측 탭에서 방 치수를 먼저 입력하세요.</p>';
  st.layout = st.layout || {};
  rooms.forEach(r => { if (!st.layout[r.id]) autoLayout(st); });

  let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
  rooms.forEach(r => {
    const L = st.layout[r.id];
    minX = Math.min(minX, L.x); minY = Math.min(minY, L.y);
    maxX = Math.max(maxX, L.x + num(r.W)); maxY = Math.max(maxY, L.y + num(r.D));
  });
  const PAD = 1400;                     // 치수선 여백(mm)
  const bw = maxX - minX, bh = maxY - minY;
  const VW = bw + PAD * 2, VH = bh + PAD * 2;
  const ox = PAD - minX, oy = PAD - minY;

  const TINT = ['#e8f1f8', '#eaf5ec', '#fdf1e3', '#f2ecf8', '#e9f4f6', '#fbecec'];
  let g = '';

  rooms.forEach((r, i) => {
    const L = st.layout[r.id];
    const W = num(r.W), D = num(r.D), H = num(r.H);
    const X = L.x + ox, Y = L.y + oy;
    const t = planWallThk(r);
    const A = calcArea(r);

    /* 벽체(두께 있는 테두리) */
    g += `<g class="rm" data-id="${r.id}">`;
    g += `<rect class="wall" x="${X - t}" y="${Y - t}" width="${W + t * 2}" height="${D + t * 2}"/>`;
    g += `<rect class="inner" x="${X}" y="${Y}" width="${W}" height="${D}" fill="${TINT[i % TINT.length]}"/>`;

    /* 개구부 */
    if (showOpen) {
      const nD = r.doors.reduce((a, d) => a + num(d.qty), 0);
      const nW = r.wins.reduce((a, d) => a + num(d.qty), 0);
      const put = (side, w, cls, idx, cnt) => {
        const step = (s) => ((idx + 1) / (cnt + 1)) * s;
        if (side === 'S') { const cx = X + step(W); return { x: cx - w / 2, y: Y + D - t / 2, w: w, h: t, cx: cx, cy: Y + D, dir: 1, horiz: 1 }; }
        if (side === 'N') { const cx = X + step(W); return { x: cx - w / 2, y: Y - t / 2, w: w, h: t, cx: cx, cy: Y, dir: -1, horiz: 1 }; }
        if (side === 'W') { const cy = Y + step(D); return { x: X - t / 2, y: cy - w / 2, w: t, h: w, cx: X, cy: cy, dir: -1, horiz: 0 }; }
        const cy = Y + step(D); return { x: X + W - t / 2, y: cy - w / 2, w: t, h: w, cx: X + W, cy: cy, dir: 1, horiz: 0 };
      };
      for (let k = 0; k < nD; k++) {
        const o = put(L.door || 'S', 900, 'door', k, nD);
        g += `<rect class="open" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}"/>`;
        const s = 900;
        g += o.horiz
          ? `<path class="swing" d="M ${o.cx - s / 2} ${o.cy} l 0 ${s * o.dir} M ${o.cx - s / 2} ${o.cy} a ${s} ${s} 0 0 ${o.dir > 0 ? 0 : 1} ${s} ${s * o.dir}"/>`
          : `<path class="swing" d="M ${o.cx} ${o.cy - s / 2} l ${s * o.dir} 0 M ${o.cx} ${o.cy - s / 2} a ${s} ${s} 0 0 ${o.dir > 0 ? 1 : 0} ${s * o.dir} ${s}"/>`;
      }
      for (let k = 0; k < nW; k++) {
        const o = put(L.win || 'N', 1200, 'win', k, nW);
        g += `<rect class="open win" x="${o.x}" y="${o.y}" width="${o.w}" height="${o.h}"/>`;
      }
    }

    /* 실명 / 면적 */
    const fs = Math.max(150, Math.min(W, D) / 9);
    const cx = X + W / 2, cy = Y + D / 2;
    const inner = W * 0.92;
    // 글자가 방 폭을 넘지 않도록 자동 축소 (한글 1자 ≈ 폰트크기, 숫자·영문 ≈ 0.58)
    const wid = (txt, size) => size * Array.from(String(txt)).reduce((a, c) => a + (/[\u3131-\uD79D]/.test(c) ? 1 : 0.58), 0);
    const fit = (txt, size) => Math.min(size, size * inner / Math.max(1, wid(txt, size)));
    const line = (txt, cls, size, dy) => {
      const f = fit(txt, size);
      if (f < 90) return '';
      return `<text class="${cls}" x="${cx}" y="${cy + dy}" font-size="${f.toFixed(0)}">${esc(txt)}</text>`;
    };
    g += line(r.name, 'nm', fs, -fs * 0.9);
    g += line(`${W}×${D} (H${H})`, 'sz', fs * .72, fs * 0.15);
    g += line(`${m2(A.floor)}㎡ · ${A.pyeong.toFixed(1)}평`, 'sz', fs * .72, fs * 1.15);
    if (r.wallBase) g += line(shortSpec(r), 'sp', fs * .62, fs * 2.15);

    g += `</g>`;
  });

  /* 치수 체인 — 방 경계선을 모아 한 줄로 (실별 치수선은 서로 겹치므로 쓰지 않습니다) */
  if (showDim) {
    // 윗줄 방들로 가로 치수, 왼쪽 열 방들로 세로 치수를 잡습니다 (전체를 섞으면 칸이 잘게 쪼개집니다)
    const xs = new Set(), ys = new Set();
    rooms.forEach(r => {
      const L = st.layout[r.id];
      if (L.y === minY) { xs.add(L.x); xs.add(L.x + num(r.W)); }
      if (L.x === minX) { ys.add(L.y); ys.add(L.y + num(r.D)); }
    });
    if (xs.size < 2) rooms.forEach(r => { const L = st.layout[r.id]; xs.add(L.x); xs.add(L.x + num(r.W)); });
    if (ys.size < 2) rooms.forEach(r => { const L = st.layout[r.id]; ys.add(L.y); ys.add(L.y + num(r.D)); });
    const ax = Array.from(xs).sort((a, b) => a - b), ay = Array.from(ys).sort((a, b) => a - b);
    const yTop = oy + minY - 520, xLeft = ox + minX - 520;
    for (let i = 0; i < ax.length - 1; i++) g += dimLine(ax[i] + ox, yTop, ax[i + 1] + ox, yTop, String(ax[i + 1] - ax[i]), 'h');
    for (let i = 0; i < ay.length - 1; i++) g += dimLine(xLeft, ay[i] + oy, xLeft, ay[i + 1] + oy, String(ay[i + 1] - ay[i]), 'v');
    g += dimLine(ox + minX, oy + maxY + 800, ox + maxX, oy + maxY + 800, `전체 ${bw}`, 'h');
    g += dimLine(ox + maxX + 800, oy + minY, ox + maxX + 800, oy + maxY, `전체 ${bh}`, 'v');
  }

  return `<svg id="planSvg" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet">
    <style>${PLAN_CSS}</style>
    <rect x="0" y="0" width="${VW}" height="${VH}" fill="#fff"/>
    ${g}
  </svg>`;
}

function shortSpec(r) {
  const s = [];
  if (r.wallBase) {
    const o = (/\(([^)]+)\)/.exec(r.wallBase) || [, ''])[1];
    s.push('벽 ' + o.replace(',', '+') + ' ' + (r.wallPly || ''));
  }
  if (r.ceilBase) s.push('천장 ' + (r.ceilPly || ''));
  return s.join(' / ');
}

/* 치수선 */
function dimLine(x1, y1, x2, y2, label, dir) {
  const e = 140;
  const tick = dir === 'h'
    ? `<path class="dtick" d="M ${x1} ${y1 - e} L ${x1} ${y1 + e} M ${x2} ${y2 - e} L ${x2} ${y2 + e}"/>`
    : `<path class="dtick" d="M ${x1 - e} ${y1} L ${x1 + e} ${y1} M ${x2 - e} ${y2} L ${x2 + e} ${y2}"/>`;
  const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const txt = dir === 'h'
    ? `<text class="dim" x="${mx}" y="${my - 90}">${label}</text>`
    : `<text class="dim" x="${mx}" y="${my}" transform="rotate(-90 ${mx} ${my})" dy="-90">${label}</text>`;
  return `<g class="dimg"><path class="dline" d="M ${x1} ${y1} L ${x2} ${y2}"/>${tick}${txt}</g>`;
}

const PLAN_CSS = `
 .wall{fill:#2b3542}
 .inner{stroke:none}
 .open{fill:#fff;stroke:#2b3542;stroke-width:14}
 .open.win{fill:#cfe6f5}
 .swing{fill:none;stroke:#8a949f;stroke-width:12;stroke-dasharray:60 40}
 text{font-family:"Malgun Gothic","맑은 고딕",sans-serif;text-anchor:middle;fill:#1c2430}
 .nm{font-weight:700}
 .sz{fill:#54606d}
 .sp{fill:#1f5f8b;font-weight:700}
 .dline{stroke:#1f5f8b;stroke-width:12}
 .dtick{stroke:#1f5f8b;stroke-width:12}
 .dim{fill:#1f5f8b;font-size:230px;font-weight:700}
 .rm{cursor:move}
`;

/* ══════════ 단면 상세도 SVG ══════════ */
function sectionSvg(r, kind) {
  const L = sectionLayers(r, kind);
  if (!L.length) return `<p class="empty">${kind === 'ceil' ? '천장 방음' : '방음벽'} 사양이 선택되지 않았습니다. [실측] 탭에서 지정하세요.</p>`;

  /* 얇은 층도 보이도록 최소 폭을 준 표현용 스케일 */
  const MINW = 16;
  const px = L.map(x => Math.max(MINW, x.t * 3.0));
  const Wpx = px.reduce((a, b) => a + b, 0);
  const Hpx = 300, PADL = 56, PADT = 118, PADR = 56;
  const rowH = 26, legTop = PADT + Hpx + 58;
  const VW = Math.max(Wpx + PADL + PADR, 560);
  const VH = legTop + L.length * rowH + 26;

  let x = PADL, g = '', ticks = '', leg = '';
  L.forEach((ly, i) => {
    const w = px[i], no = i + 1;
    g += `<rect x="${x}" y="${PADT}" width="${w}" height="${Hpx}" fill="${ly.c}" stroke="#2b3542" stroke-width="${ly.ghost ? 1 : 1.4}" ${ly.ghost ? 'stroke-dasharray="6 4"' : ''}/>`;
    if (ly.h === 'gw') for (let k = 0; k < 9; k++) g += `<path d="M ${x} ${PADT + k * 34} q ${w / 2} 18 ${w} 0" fill="none" stroke="#c9a227" stroke-width="1.2"/>`;
    if (ly.h === 'concrete') for (let k = -Hpx; k < w; k += 14) g += `<path d="M ${x + k} ${PADT + Hpx} L ${x + k + Hpx} ${PADT}" stroke="#9aa2ac" stroke-width="1" opacity=".8"/>`;
    if (ly.h === 'abs') for (let k = 4; k < w; k += 7) g += `<path d="M ${x + k} ${PADT} L ${x + k} ${PADT + Hpx}" stroke="#7fb2d6" stroke-width="1"/>`;

    /* 층 위에 번호표 — 라벨은 아래 범례로 빼서 겹치지 않습니다 */
    const cxx = x + w / 2;
    g += `<circle cx="${cxx}" cy="${PADT + Hpx - 20}" r="10" fill="#fff" stroke="#2b3542" stroke-width="1.2"/>`;
    g += `<text x="${cxx}" y="${PADT + Hpx - 16}" font-size="12" font-weight="700" text-anchor="middle" fill="#1c2430">${no}</text>`;

    /* 범례 한 줄 */
    const ly0 = legTop + i * rowH;
    leg += `<circle cx="${PADL + 11}" cy="${ly0 - 4}" r="10" fill="#fff" stroke="#2b3542" stroke-width="1.2"/>`;
    leg += `<text x="${PADL + 11}" y="${ly0}" font-size="12" font-weight="700" text-anchor="middle" fill="#1c2430">${no}</text>`;
    leg += `<rect x="${PADL + 28}" y="${ly0 - 13}" width="18" height="18" fill="${ly.c}" stroke="#2b3542" stroke-width="1"/>`;
    leg += `<text x="${PADL + 54}" y="${ly0}" font-size="13" text-anchor="start" fill="#1c2430">${esc(ly.n)}${ly.ghost ? '  (기존 · 시공범위 아님)' : ''}</text>`;

    if (!ly.ghost) ticks += `<path d="M ${x} ${PADT - 36} L ${x} ${PADT - 12}" stroke="#1f5f8b" stroke-width="1"/>`;
    x += w;
  });
  ticks += `<path d="M ${x} ${PADT - 36} L ${x} ${PADT - 12}" stroke="#1f5f8b" stroke-width="1"/>`;

  const netT = layersThk(L);
  const gx = PADL + px[0];
  g += ticks;
  g += `<path d="M ${gx} ${PADT - 24} L ${x} ${PADT - 24}" stroke="#1f5f8b" stroke-width="1.4"/>`;
  g += `<text x="${(gx + x) / 2}" y="${PADT - 40}" font-size="15" font-weight="700" fill="#1f5f8b" text-anchor="middle">신설 두께 ${netT.toFixed(1)}mm</text>`;
  g += `<text x="${PADL - 12}" y="${PADT + Hpx / 2}" font-size="12" fill="#6b7684" text-anchor="middle" transform="rotate(-90 ${PADL - 12} ${PADT + Hpx / 2})">${kind === 'ceil' ? '슬래브·윗층' : '인접실·외부'}</text>`;
  g += `<text x="${x + 16}" y="${PADT + Hpx / 2}" font-size="13" font-weight="700" fill="#1f5f8b" text-anchor="middle" transform="rotate(-90 ${x + 16} ${PADT + Hpx / 2})">실내측</text>`;
  g += `<text x="${PADL}" y="${legTop - 26}" font-size="12" font-weight="700" fill="#6b7684" text-anchor="start">구성 (실외 → 실내 순)</text>`;
  g += `<text x="${VW - PADR}" y="${VH - 8}" font-size="11" fill="#98a1ab" text-anchor="end">※ 층 두께는 보기 쉽도록 과장 표현됨</text>`;

  return `<svg class="secSvg" viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet">
    <style>text{font-family:"Malgun Gothic","맑은 고딕",sans-serif}</style>
    <rect width="${VW}" height="${VH}" fill="#fff"/>${g}${leg}</svg>`;
}

/* 자재 수량표 */
function secTable(r, kind) {
  const L = sectionLayers(r, kind).filter(x => !x.ghost);
  if (!L.length) return '';
  const A = calcArea(r);
  const area = kind === 'ceil' ? A.ceil : A.wall;
  const rows = L.map(x => `<tr><td>${esc(x.n)}</td><td class="r">${x.t}</td><td class="r">${m2(area)}</td></tr>`).join('');
  return `<table class="sectbl"><thead><tr><th>구성 자재</th><th class="r">두께(mm)</th><th class="r">시공면적(㎡)</th></tr></thead>
  <tbody>${rows}</tbody>
  <tfoot><tr><th>합계 두께</th><th class="r">${layersThk(sectionLayers(r, kind)).toFixed(1)}</th><th class="r">${m2(area)}</th></tr></tfoot></table>`;
}

/* ══════════ 렌더 ══════════ */
let DRAW = { mode: 'plan', room: null, dim: true, open: true, zoom: 1 };

function renderDraw() {
  const st = (typeof cur === 'function') ? cur() : null;
  const box = document.getElementById('drawOut');
  const ctl = document.getElementById('drawCtl');
  if (!box) return;
  if (!st || !st.rooms.length) {
    ctl.innerHTML = ''; box.innerHTML = '<div class="empty">먼저 [실측] 탭에서 방을 추가하고 치수를 입력하세요.</div>';
    return;
  }
  if (!st.rooms.some(r => r.id === DRAW.room)) DRAW.room = st.rooms[0].id;

  ctl.innerHTML = `
    <div class="row">
      <button class="btn sm ${DRAW.mode === 'plan' ? '' : 'ghost'}" data-mode="plan">평면 배치도</button>
      <button class="btn sm ${DRAW.mode === 'sec' ? '' : 'ghost'}" data-mode="sec">단면 상세도</button>
      <span style="flex:1"></span>
      <button class="btn ghost sm" id="dSvg">SVG 저장</button>
      <button class="btn ghost sm" id="dPng">PNG 저장</button>
      <button class="btn ghost sm" id="dPrint">인쇄 / PDF</button>
    </div>
    ${DRAW.mode === 'plan' ? `
    <div class="row" style="margin-top:8px">
      <button class="btn ghost sm" id="dAuto">자동 배치</button>
      <label class="ck"><input type="checkbox" id="dDim" ${DRAW.dim ? 'checked' : ''}> 치수선</label>
      <label class="ck"><input type="checkbox" id="dOpen" ${DRAW.open ? 'checked' : ''}> 문·창</label>
      <span class="zoomer">
        <button class="btn ghost sm" id="dZoomOut" title="축소">−</button>
        <b id="dZoomLbl">${Math.round(DRAW.zoom * 100)}%</b>
        <button class="btn ghost sm" id="dZoomIn" title="확대">＋</button>
      </span>
    </div>
    <p class="muted sm" style="margin:6px 0 0">방을 손가락으로 끌어 위치를 옮깁니다 (100mm 단위). 도면 위를 그냥 쓸어넘기면 화면이 스크롤됩니다.</p>
    <details class="doorbox" style="margin-top:8px"><summary>문 위치 조정 (${drawable(st).length}개 실)</summary>
      <div class="grid g4" style="margin-top:8px" id="doorSides"></div>
    </details>
    ` : `
    <div class="row" style="margin-top:8px">
      <select id="dRoom" style="max-width:260px">${st.rooms.map(r => `<option value="${r.id}" ${r.id === DRAW.room ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select>
    </div>`}`;

  ctl.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => { DRAW.mode = b.dataset.mode; renderDraw(); });

  if (DRAW.mode === 'plan') {
    autoLayoutMissing(st);
    box.innerHTML = `<div class="card"><div class="dwrap${DRAW.zoom > 1 ? ' zoomed' : ''}" style="--z:${DRAW.zoom}">${planSvg(st, DRAW)}</div>
      <div class="dtitle">${esc(st.name)} — 평면 배치도 <span class="muted">축척 없음 · 실측 기준</span></div></div>`;
    const ds = document.getElementById('doorSides');
    const SIDE = [{ v: 'N', t: '위' }, { v: 'S', t: '아래' }, { v: 'W', t: '왼쪽' }, { v: 'E', t: '오른쪽' }];
    ds.innerHTML = drawable(st).map(r => {
      const L = st.layout[r.id] || {};
      return `<div><label>${esc(r.name)} 문 위치</label>
        <select data-door="${r.id}">${SIDE.map(s => `<option value="${s.v}" ${((L.door || 'S') === s.v) ? 'selected' : ''}>${s.t}</option>`).join('')}</select></div>`;
    }).join('');
    ds.querySelectorAll('[data-door]').forEach(s => s.onchange = () => {
      const L = st.layout[s.dataset.door]; if (!L) return;
      L.door = s.value; save(); renderDraw();
    });
    document.getElementById('dAuto').onclick = () => { st.layout = {}; autoLayout(st); save(); renderDraw(); };
    document.getElementById('dDim').onchange = e => { DRAW.dim = e.target.checked; renderDraw(); };
    document.getElementById('dOpen').onchange = e => { DRAW.open = e.target.checked; renderDraw(); };
    const ZS = [1, 1.5, 2, 3, 4];
    const setZoom = d => {
      let i = ZS.indexOf(DRAW.zoom); if (i < 0) i = 0;
      DRAW.zoom = ZS[Math.min(ZS.length - 1, Math.max(0, i + d))];
      renderDraw();
    };
    document.getElementById('dZoomIn').onclick = () => setZoom(1);
    document.getElementById('dZoomOut').onclick = () => setZoom(-1);
    enableDrag(st);
  } else {
    const r = st.rooms.find(x => x.id === DRAW.room);
    box.innerHTML = `
      <div class="card"><h2>${esc(r.name)} — 방음벽 단면 상세</h2>
        <div class="dwrap sec">${sectionSvg(r, 'wall')}</div>${secTable(r, 'wall')}</div>
      <div class="card"><h2>${esc(r.name)} — 천장 단면 상세</h2>
        <div class="dwrap sec">${sectionSvg(r, 'ceil')}</div>${secTable(r, 'ceil')}</div>`;
    document.getElementById('dRoom').onchange = e => { DRAW.room = e.target.value; renderDraw(); };
  }

  document.getElementById('dPrint').onclick = () => window.print();
  document.getElementById('dSvg').onclick = () => {
    const s = box.querySelector('svg'); if (!s) return;
    dl(new Blob([svgSrc(s)], { type: 'image/svg+xml' }), `${st.name}_${DRAW.mode === 'plan' ? '평면배치도' : '단면상세도'}.svg`);
  };
  document.getElementById('dPng').onclick = () => {
    const s = box.querySelector('svg'); if (!s) return;
    const vb = s.viewBox.baseVal, sc = Math.min(3, 2400 / vb.width);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = vb.width * sc; c.height = vb.height * sc;
      const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
      g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => dl(b, `${st.name}_${DRAW.mode === 'plan' ? '평면배치도' : '단면상세도'}.png`), 'image/png');
    };
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgSrc(s));
  };
}
function svgSrc(s) {
  const c = s.cloneNode(true);
  c.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return '<?xml version="1.0" encoding="UTF-8"?>' + c.outerHTML;
}
const drawable = st => st.rooms.filter(r => num(r.W) > 0 && num(r.D) > 0);
function autoLayoutMissing(st) {
  st.layout = st.layout || {};
  if (drawable(st).some(r => !st.layout[r.id])) autoLayout(st);
}

/* 드래그로 배치 이동 */
function enableDrag(st) {
  const svg = document.getElementById('planSvg'); if (!svg) return;
  let drag = null;
  const toMm = e => {
    const b = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    const k = Math.min(b.width / vb.width, b.height / vb.height);
    return { x: (e.clientX - b.left - (b.width - vb.width * k) / 2) / k,
             y: (e.clientY - b.top - (b.height - vb.height * k) / 2) / k };
  };
  svg.querySelectorAll('.rm').forEach(g => {
    g.addEventListener('pointerdown', e => {
      const p = toMm(e), L = st.layout[g.dataset.id];
      drag = { id: g.dataset.id, dx: p.x - L.x, dy: p.y - L.y };
      g.setPointerCapture(e.pointerId); e.preventDefault();
    });
    g.addEventListener('pointermove', e => {
      if (!drag || drag.id !== g.dataset.id) return;
      const p = toMm(e), L = st.layout[drag.id];
      drag.nx = Math.round((p.x - drag.dx) / 100) * 100;
      drag.ny = Math.round((p.y - drag.dy) / 100) * 100;
      // 드래그 중에는 그룹만 이동(재렌더 금지 — 포인터 캡처가 끊깁니다)
      g.setAttribute('transform', `translate(${drag.nx - L.x} ${drag.ny - L.y})`);
    });
    const drop = () => {
      if (!drag) return;
      const L = st.layout[drag.id];
      if (drag.nx != null) { L.x = drag.nx; L.y = drag.ny; }
      drag = null; save(); renderDraw();
    };
    g.addEventListener('pointerup', drop);
    g.addEventListener('pointercancel', drop);
  });
}

/* ══════════ 탭 등록 ══════════ */
document.addEventListener('DOMContentLoaded', () => {
  const b = document.querySelector('nav button[data-p="draw"]');
  if (b) b.addEventListener('click', () => setTimeout(renderDraw, 0));

  // 폰에서는 탭 이름을 짧게 — 6개가 한 화면에 다 들어와야 손이 헤매지 않는다
  const fitTabs = () => {
    const narrow = window.matchMedia('(max-width:620px)').matches;
    document.querySelectorAll('nav button[data-short]').forEach(btn => {
      if (!btn.dataset.long) btn.dataset.long = btn.textContent.trim();
      btn.textContent = narrow ? btn.dataset.short : btn.dataset.long;
    });
  };
  fitTabs();
  window.addEventListener('resize', fitTabs);
});
