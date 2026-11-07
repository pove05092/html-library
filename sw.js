// sw.js : アプリの殻だけをキャッシュする Service Worker（仕様 §4.5。論文リーダー site_v3 の sw.js の写しから pdf.js の扱いを外し、箱＝viewer.html・js/frame.js を足した）。
//  - 殻（HTML・CSS・JS・アイコン・箱）はネットワーク優先、つながらなければキャッシュ → オフラインでも起動し、端末に保存した HTML を開ける。更新は次に開いた時に届く。
//  - 同梱の three.js（vendor/three/。箱が算数の工場のゲームの CDN の URL を差し替える先）は不変なのでキャッシュ優先＝オフラインでも 3D のゲームが動く。
//  - api.github.com など別のオリジンは一切触らない（キャッシュしない）。作品の HTML は IndexedDB 側にある。
const VERSION = 'v3-2026-11-07';
const SHELL = `hl-shell-${VERSION}`;
const RUNTIME = `hl-runtime-${VERSION}`;
const CORE = [
  './', 'index.html', 'viewer.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/logic.js', 'js/ui.js', 'js/store.js', 'js/github.js', 'js/sync.js', 'js/syncpill.js',
  'js/library.js', 'js/viewer.js', 'js/frame.js', 'js/upload.js', 'js/settings.js', 'js/tags.js', 'js/install.js',
  'icons/icon-192.png', 'icons/icon-512.png',
  'vendor/three/three.module.min.js',
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    await Promise.all(CORE.map(async u => { try { await c.add(new Request(u, { cache: 'reload' })); } catch (err) { /* 1 つ欠けても残りで起動できるようにする */ } }));
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== RUNTIME) await caches.delete(k);
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    if (url.pathname.includes('/vendor/')) {                 // 不変の同梱ライブラリはキャッシュ優先
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone()).catch(() => {});
      return res;
    }
    try {
      const res = await fetch(req, { cache: 'no-cache' });
      if (res.ok) (await caches.open(SHELL)).put(req, res.clone()).catch(() => {});
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') { const idx = await caches.match('index.html'); if (idx) return idx; }
      throw err;
    }
  })());
});
