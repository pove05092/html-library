// app.js : 入口。画面の切り替え（#/ ライブラリ、#/item/<id>?v=<N> ビューア、#/settings 設定、#/welcome 歓迎）と全体の配線。仕様 §4.1。
// 論文リーダー site_v3 の app.js の構造を踏襲。
import { SyncEngine } from './sync.js';
import { h, clear, toast } from './ui.js';
import { createSyncPill } from './syncpill.js';
import { renderLibrary } from './library.js';
import { renderSettings, renderWelcome } from './settings.js';
import { initInstall } from './install.js';
import { startUpload } from './upload.js';
import { Viewer } from './viewer.js';
import * as L from './logic.js';

initInstall();   // beforeinstallprompt を取りこぼさないよう最初に聞き耳を立てる
const engine = new SyncEngine();
const appEl = document.getElementById('app');
let current = null, navCount = 0, currentHash = null, routeSeq = 0;
const TOLD_NO_PROGRESS = 'hl.toldNoProgress';

// ---------- この端末の表示の好み（localStorage）----------
const prefs = {
  get() { try { return JSON.parse(localStorage.getItem('hl.ui') || '{}') || {}; } catch (e) { return {}; } },
  set(patch) { try { localStorage.setItem('hl.ui', JSON.stringify({ ...prefs.get(), ...patch })); } catch (e) { /* 保存できなくても動く */ } },
};

// ---------- 画面遷移 ----------
function go(hash, { replace = false } = {}) {
  if (replace) history.replaceState(history.state, '', hash);
  else { navCount++; history.pushState({ n: navCount }, '', hash); }
  route();
}
/** 戻る：履歴が無ければ #/ */
function back() { if (history.state && history.state.n > 0) history.back(); else go('#/', { replace: true }); }
/** 画面を作り直さずに URL だけ変える（ビューアの版の切り替え） */
function setHash(hash) { history.replaceState(history.state, '', hash); currentHash = hash; }

/** #/item/<id>?v=<N> → { id, v } */
export function parseItemHash(hash) {
  const m = /^#\/item\/([^?]+)(?:\?(.*))?$/.exec(hash);
  if (!m) return null;
  const q = new URLSearchParams(m[2] || '');
  const v = q.has('v') && /^\d+$/.test(q.get('v')) ? Number(q.get('v')) : null;
  return { id: decodeURIComponent(m[1]), v };
}

async function route() {
  const hash = location.hash || '#/';
  currentHash = hash;
  const seq = ++routeSeq;
  if (current) { try { current.destroy(); } catch (e) { console.warn('[app] destroy', e); } current = null; }
  clear(appEl);
  document.title = L.STRINGS.appName;

  if (hash === '#/welcome' || (!engine.configured && hash !== '#/settings')) { current = renderWelcome({ host: appEl, go }); return; }
  if (hash === '#/settings') { current = renderSettings({ engine, host: appEl, go, firstRun: !engine.configured }); return; }
  const it = parseItemHash(hash);
  if (it) { await openViewer(it.id, it.v, seq); return; }
  const p = createSyncPill(engine, { onSettings: () => go('#/settings') });
  const lib = renderLibrary({ engine, host: appEl, go, prefs, pill: p, onFiles: files => startUpload({ engine, files }) });
  current = { destroy() { lib.destroy(); p.destroy(); } };
}

async function openViewer(id, v, seq) {
  let item = engine.item(id);
  if (!item && engine.configured) {
    appEl.append(h('div', { class: 'boot', text: '倉庫を確認しています…' }));
    await engine.refresh();
    if (seq !== routeSeq) return;
    clear(appEl);
    item = engine.item(id);
  }
  if (!item) { toast('その作品が見つかりません', { kind: 'warn' }); go('#/', { replace: true }); return; }
  let ver = v != null ? L.versionOf(item, v) : null;
  if (v != null && !ver) toast(`v${v} の版は見つからないので、最新の版を開きます`, { kind: 'warn' });
  if (!ver) ver = L.latestVersion(item);
  if (!ver) { toast('この作品には開ける版がありません', { kind: 'warn' }); go('#/', { replace: true }); return; }
  const viewer = new Viewer({ engine, item, onBack: back, onVersion: nv => setHash(`#/item/${encodeURIComponent(id)}?v=${nv}`) });
  viewer.mount(appEl);
  window.__hl.viewer = viewer;
  document.title = `${item.title} - ${L.STRINGS.appName}`;
  current = {
    destroy() {
      viewer.destroy();
      if (window.__hl.viewer === viewer) window.__hl.viewer = null;
      engine.flushLocal();
      engine.schedule(true);                       // 閉じる時は「最近開いた」の記録をすぐ送る（論文リーダーと同じ）
    },
  };
  // 開いた記録（最近開いた順のため）。送るのは閉じる時にまとめて
  engine.setField(id, 'lastOpenedAt', L.nowIso(), { silent: true });
  // 初めてゲームを開いた時だけ、進捗が保存されないことを知らせる（端末ごとに 1 回）
  if (L.normalizeKind(item.kind) === 'game') {
    let told = false; try { told = !!localStorage.getItem(TOLD_NO_PROGRESS); } catch (e) { /* 読めなければ毎回出す */ }
    if (!told) { toast(L.STRINGS.noProgress, { ms: 6000 }); try { localStorage.setItem(TOLD_NO_PROGRESS, '1'); } catch (e) { /* 無視 */ } }
  }
  await viewer.load(ver.v);
}

// ---------- 起動 ----------
window.__hl = { engine, viewer: null, prefs, go, get hash() { return currentHash; } };   // 画面外からの状態確認用（トークンは持たない）
async function main() {
  engine.addEventListener('upload-failed', e => toast(`「${e.detail.title || e.detail.itemId}」は送れませんでした：${e.detail.message}`, { kind: 'error', ms: 9000 }));
  engine.addEventListener('storage-error', () => toast('この端末に保存できませんでした（空き容量を確かめてください）', { kind: 'error', ms: 7000 }));
  const told = new Set();
  engine.addEventListener('problem', e => {
    const err = e.detail;
    if (err && err.fatal && !told.has(err.kind)) { told.add(err.kind); toast(err.message, { kind: 'error', ms: 9000 }); }
    if (err && err.kind === 'rate') toast(err.message, { kind: 'warn', ms: 6000 });
  });
  engine.addEventListener('committed', e => { if (e.detail.parts.some(p => p.startsWith('upload:'))) toast('アップロードが完了しました'); });
  await engine.init();
  engine.attachWindowEvents();
  window.addEventListener('popstate', () => { navCount = (history.state && history.state.n) || 0; route(); });
  window.addEventListener('hashchange', () => { if ((location.hash || '#/') !== currentHash) route(); });
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('sw.js'); } catch (e) { console.warn('[app] sw の登録に失敗', e && e.message); }
  }
  await route();
  document.documentElement.dataset.ready = '1';
}
main().catch(e => {
  console.error('[app] 起動に失敗', e);
  appEl.textContent = '起動に失敗しました：' + (e && e.message ? e.message : e);
});
