/* 오프라인 캐시
   앱 파일을 수정했으면 아래 V의 숫자를 1 올리세요 (cp-v2 → cp-v3).
   그래야 폰/노트북이 새 버전을 확실히 내려받습니다. */
const V = 'cp-v14';
const ASSETS = ['./', './index.html', './style.css', './app.js', './draw.js', './data/prices.js', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(V);
    // no-store: 브라우저 디스크 캐시를 건너뛰고 항상 최신 파일을 받음
    await Promise.all(ASSETS.map(u =>
      fetch(u, { cache: 'no-store' }).then(r => r.ok && c.put(u, r)).catch(() => {})));
    self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== V).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

/* 네트워크 우선 → 실패하면 캐시 (현장에서 인터넷이 없어도 동작) */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith((async () => {
    try {
      const r = await fetch(e.request);
      if (r && r.ok) { const c = await caches.open(V); c.put(e.request, r.clone()).catch(() => {}); }
      return r;
    } catch (_) {
      return (await caches.match(e.request)) || (await caches.match('./index.html'));
    }
  })());
});
