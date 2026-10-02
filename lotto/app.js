// DRAWS 행: [회차, 날짜, n1..n6(오름차순), 보너스]
const $ = id => document.getElementById(id);
const PERIODS = { all: ['전체', 1, 9999], kb: ['국민은행 1~261회', 1, 261], nh: ['농협은행 262회~', 262, 9999] };
const ls = { get: (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }, set: (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
const st = { tab: 1, per: ls.get('per', 'all'), mode: 'balanced', sets: [], q: '' };
const past = new Set(DRAWS.map(r => r.slice(2, 8).join(',')));
const ball = (n, s) => `<span class="b ${s ? 's ' : ''}${n <= 10 ? 'y' : n <= 20 ? 'u' : n <= 30 ? 'r' : n <= 40 ? 'g' : 'n'}">${n}</span>`;
const rows = () => { const [, a, b] = PERIODS[st.per]; return DRAWS.filter(r => r[0] >= a && r[0] <= b); };

function stats(R) {
  const f = Array(46).fill(0), last = Array(46).fill(0), odd = Array(7).fill(0); let sum = 0;
  for (const r of R) {
    let o = 0;
    for (let i = 2; i < 8; i++) { f[r[i]]++; last[r[i]] = r[0]; sum += r[i]; o += r[i] % 2; }
    odd[o]++;
  }
  const end = R[R.length - 1][0];
  const omit = last.map(l => end - l); // 마지막 회차 기준 몇 회 연속 미출현
  return { f, omit, odd, avgSum: sum / R.length, n: R.length };
}

function pickWeighted(w) {
  const chosen = [], pool = w.map((x, i) => [i, x]).filter(p => p[0] >= 1);
  while (chosen.length < 6) {
    const tot = pool.reduce((s, p) => s + p[1], 0); let r = Math.random() * tot, k = 0;
    while (k < pool.length - 1 && (r -= pool[k][1]) > 0) k++;
    chosen.push(pool.splice(k, 1)[0][0]);
  }
  return chosen.sort((a, b) => a - b);
}

function recommend(mode, S) {
  const w = Array(46).fill(1);
  for (let i = 1; i <= 45; i++) {
    if (mode === 'hot') w[i] = S.f[i] ** 2;            // 많이 나온 번호 쪽으로 쏠리게
    if (mode === 'cold') w[i] = (S.omit[i] + 1) ** 1.5; // 오래 안 나온 번호 쪽으로
  }
  for (let t = 0; t < 5000; t++) {
    const c = pickWeighted(w);
    if (past.has(c.join(','))) continue; // 이미 1등이 나온 조합은 제외
    if (mode === 'balanced') {
      const odd = c.filter(x => x % 2).length, sum = c.reduce((a, b) => a + b, 0);
      const cons = c.filter((x, i) => i && x - c[i - 1] === 1).length;
      if (odd < 2 || odd > 4 || sum < 100 || sum > 175 || cons > 1) continue;
    }
    return c;
  }
}

const MODES = { balanced: '균형형', hot: '많이 나온 번호', cold: '오래 안 나온 번호', random: '완전 랜덤' };
const MODE_DESC = { balanced: '홀짝 2:4~4:2, 합계 100~175, 연속번호 1쌍 이하인 조합만 뽑습니다. 역대 1등 번호 대부분이 이 범위입니다.',
  hot: '선택한 기간에 자주 나온 번호가 더 잘 뽑히게 가중치를 줍니다.', cold: '최근에 안 나온 기간이 긴 번호가 더 잘 뽑히게 가중치를 줍니다.', random: '가중치 없이 그냥 섞습니다.' };

function render() {
  $('per').innerHTML = Object.entries(PERIODS).map(([k, p]) => `<button data-per="${k}" class="${st.per === k ? 'on' : ''}">${p[0]}</button>`).join('');
  ['t1', 't2', 't3'].forEach((id, i) => $(id).className = st.tab === i + 1 ? 'on' : '');
  const R = rows(), S = stats(R), v = $('v');
  if (st.tab === 1) {
    const mx = Math.max(...S.f.slice(1)), top = [...Array(45).keys()].map(i => i + 1).sort((a, b) => S.f[b] - S.f[a]);
    const oddTxt = S.odd.map((c, o) => c ? `홀${o}:짝${6 - o} ${(c / S.n * 100).toFixed(0)}%` : '').filter(Boolean).join(' · ');
    v.innerHTML = `<div class="card"><div class="sub">${PERIODS[st.per][0]} · ${S.n}회차 (${R[0][0]}~${R[R.length - 1][0]}회)</div>
      <p><b>가장 많이 나온 번호</b></p><div class="balls">${top.slice(0, 6).map(n => ball(n) + `<span class="sub">${S.f[n]}회</span>`).join('')}</div>
      <p><b>가장 적게 나온 번호</b></p><div class="balls">${top.slice(-6).reverse().map(n => ball(n) + `<span class="sub">${S.f[n]}회</span>`).join('')}</div>
      <p><b>가장 오래 안 나온 번호</b></p><div class="balls">${[...top].sort((a, b) => S.omit[b] - S.omit[a]).slice(0, 6).map(n => ball(n) + `<span class="sub">${S.omit[n]}회째</span>`).join('')}</div>
      <p class="sub">홀짝 분포: ${oddTxt}<br>당첨번호 6개 합계 평균: ${S.avgSum.toFixed(0)}</p></div>
      <div class="card"><b>번호별 출현 횟수</b>${Array.from({ length: 45 }, (_, i) => i + 1).map(n => `<div class="fr">${ball(n, 1)}<div class="bar" style="width:${S.f[n] / mx * 55}%"></div><span>${S.f[n]}회 · ${S.omit[n]}회 전</span></div>`).join('')}</div>
      <div class="warn">지금까지 ${DRAWS.length}회 중 1등 조합이 겹친 적은 ${DRAWS.length - past.size}번입니다. 조합이 8,145,060개라 거의 겹치지 않습니다.</div>`;
  } else if (st.tab === 2) {
    v.innerHTML = `<div class="warn">⚠ 로또는 매 회차가 완전히 독립된 추첨이라, 어떤 통계로도 다음 1등 번호를 예측할 수 없습니다. 모든 조합의 1등 확률은 똑같이 1/8,145,060입니다. 이 화면은 통계로 번호를 고르는 재미용입니다.</div>
      <div class="modes">${Object.entries(MODES).map(([k, n]) => `<button data-mode="${k}" class="${st.mode === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <p class="sub">${MODE_DESC[st.mode]} (기간: ${PERIODS[st.per][0]})</p>
      <button class="pri" id="go" style="width:100%">🎲 번호 5세트 돌리기</button>
      ${st.sets.map(c => `<div class="card balls">${c.map(n => ball(n)).join('')}</div>`).join('')}`;
  } else {
    const q = st.q.trim(), list = [...R].reverse().filter(r => !q || String(r[0]) === q).slice(0, 60);
    v.innerHTML = `<div class="row"><input id="q" placeholder="회차 검색" inputmode="numeric" value="${st.q}"><span class="sub">최근 60개 표시</span></div>
      ${list.map(r => `<div class="card"><div class="sub">${r[0]}회 · ${r[1]}</div><div class="balls">${r.slice(2, 8).map(n => ball(n)).join('')}<span class="plus">+</span>${ball(r[8])}</div></div>`).join('') || '<p class="sub">없음</p>'}`;
    $('q').oninput = e => { st.q = e.target.value; render(); const q2 = $('q'); q2.focus(); q2.setSelectionRange(q2.value.length, q2.value.length); };
  }
}

function spin() {
  let i = 0;
  const t = setInterval(() => {
    st.sets = Array.from({ length: 5 }, () => pickWeighted(Array(46).fill(1)));
    render();
    if (++i >= 8) { clearInterval(t); st.sets = Array.from({ length: 5 }, () => recommend(st.mode, stats(rows()))); render(); }
  }, 70);
}

document.addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.per) { st.per = b.dataset.per; ls.set('per', st.per); st.sets = []; render(); }
  else if (b.dataset.mode) { st.mode = b.dataset.mode; st.sets = []; render(); }
  else if (b.id === 'go') spin();
});
['t1', 't2', 't3'].forEach((id, i) => $(id).onclick = () => { st.tab = i + 1; render(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
render();
