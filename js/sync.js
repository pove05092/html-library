// sync.js : ローカル優先の同期エンジン（仕様 §3.4。論文リーダー site_v3 の sync.js を写して、メモ・線の同期を外し、版・HTML の取得を足した）。
//  書き込みはまず IndexedDB に入れて「未送信」とし、10 秒静かになったら（コミットの間は 60 秒空けて）1 コミット複数ファイルで送る。
//  競合（fast-forward でない）は、新しい head を読み直して library にパッチを掛け直してやり直す（item ごとに新しい方が勝つ）。
//  HTML 本体は blob の sha をキーに端末へ保存する（開いた版・「端末に保存」した版は電波が無くても開ける）。
import * as L from './logic.js';
import * as S from './store.js';
import { Api, GitHubError } from './github.js';

const SETTINGS_KEY = 'hl.settings', TOKEN_KEY = 'hl.token', DEV_KEY = 'hl.dev';
export const DEFAULT_SETTINGS = { owner: 'pove05092', repo: 'html-library-data', branch: 'main', device: '', apiUrl: 'https://api.github.com' };

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  try { Object.assign(s, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch (e) { /* 壊れていたら既定 */ }
  return s;
}
export function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
export function forgetSettings() { localStorage.removeItem(SETTINGS_KEY); }
export const getToken = () => localStorage.getItem(TOKEN_KEY) || '';
export function setToken(t) { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); }
function loadDev() { try { return JSON.parse(localStorage.getItem(DEV_KEY) || '{}') || {}; } catch (e) { return {}; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const utf8Len = s => new TextEncoder().encode(s).length;
const itemIdOfKey = key => String(key).replace(/@v\d+$/, '');

export class SyncEngine extends EventTarget {
  constructor() {
    super();
    this.settings = loadSettings();
    this.token = getToken();
    this.timing = { ...L.TIMING };
    this.api = null;
    this.base = null;                 // { repoKey, headSha, commitTree, files:{path:{sha,size}}, libSha, library }
    this.patches = [];                // 未送信のライブラリ操作
    this.uploadKeys = new Set();      // 送信待ちのアップロード（「<id>@v<N>」）
    this.library = L.emptyLibrary();  // 画面に出す版（base + patches）
    this.online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    this.err = null;                  // {kind, message, retryAt}
    this.sending = null; this.refreshing = null; this.again = false;
    this.lastChangeAt = null; this.lastCommitAt = null; this.lastRefreshAt = null; this.retryAt = null; this.failures = 0;
    this.timer = null; this.pollTimer = null; this.nextSendAt = null;
    this.progress = null;             // {text}
    this.textCache = new Map();
    this.thumbUrls = new Map(); this.thumbQueue = []; this.thumbActive = 0;
    this._persistQ = Promise.resolve();
    this.status = { kind: 'unconfigured', pending: 0, message: '' };
  }

  // ---------- 状態 ----------
  get configured() { return !!(this.token && this.settings.owner && this.settings.repo); }
  get device() { return this.settings.device || 'web'; }
  repoKey() { const s = this.settings; return `${s.apiUrl}|${s.owner}/${s.repo}@${s.branch}`; }
  pendingCount() { return this.patches.length + this.uploadKeys.size; }
  /** この item に送信待ちのアップロードがあるか（カードの「未送信」） */
  hasPendingUpload(id) { for (const k of this.uploadKeys) if (itemIdOfKey(k) === id) return true; return false; }
  emit(name, detail) { this.dispatchEvent(new CustomEvent(name, { detail })); }
  computeStatus() {
    const pending = this.pendingCount(), now = Date.now();
    let kind;
    if (!this.configured) kind = 'unconfigured';
    else if (this.sending) kind = 'sending';
    else if (this.err && this.err.kind === 'rate') kind = 'waiting';
    else if (this.err && !['offline', 'network'].includes(this.err.kind) && this.err.fatal) kind = 'error';
    else if (!this.online || (this.err && this.err.kind === 'offline')) kind = 'offline';
    else if (this.err) kind = 'error';
    else if (pending > 0) kind = 'pending';
    else kind = 'saved';
    this.status = { kind, pending, message: this.err ? this.err.message : '', retryAt: this.err?.retryAt ?? null, nextSendAt: this.nextSendAt, lastCommitAt: this.lastCommitAt,
      lastRefreshAt: this.lastRefreshAt, head: this.base?.headSha || null, progress: this.progress, now };
    return this.status;
  }
  setStatus() { this.computeStatus(); this.emit('status', this.status); }

  // ---------- 起動 ----------
  async init() {
    this.settings = loadSettings(); this.token = getToken();
    this.timing = { ...L.TIMING };
    const dev = loadDev();
    for (const k of Object.keys(this.timing)) if (Number.isFinite(dev[k])) this.timing[k] = dev[k];   // 試験用の短縮（localStorage hl.dev）。既定は 10 秒・60 秒・1 秒・60 秒
    this.api = this.configured ? new Api({ ...this.settings, token: this.token, writeGapMs: this.timing.writeGapMs }) : null;
    try {
      const base = await S.kv.get('base');
      if (base && base.repoKey === this.repoKey()) this.base = base;
      else if (base) { await S.clearAll(); }               // 別の倉庫のキャッシュは混ぜない
      this.patches = (await S.kv.get('patches')) || [];
      for (const k of await S.uploadsDb.keys()) this.uploadKeys.add(k);
    } catch (e) {
      console.warn('[sync] 端末内の保存を読めませんでした', e && e.name);
      this.err = { kind: 'internal', message: '端末内の保存領域を開けませんでした（プライベートモードなど）。変更は保存されません。', fatal: true };
    }
    this.rebuildView();
    this.setStatus();
    S.requestPersistence();
    if (this.configured) {
      this.startPolling();
      this.refresh().then(() => { if (this.pendingCount()) this.schedule(); });
    }
  }
  attachWindowEvents() {
    window.addEventListener('online', () => { this.online = true; if (this.err && ['offline', 'network'].includes(this.err.kind)) this.err = null; this.setStatus(); this.refresh(); this.schedule(true); });
    window.addEventListener('offline', () => { this.online = false; this.setStatus(); });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') { this.flushLocal(); this.schedule(true); }
      else this.refresh();
    });
    window.addEventListener('pagehide', () => { this.flushLocal(); this.schedule(true); });
  }
  startPolling() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => { if (document.visibilityState === 'visible') this.refresh({ quiet: true }); }, this.timing.pollMs);
  }
  /** 設定を変えた後に作り直す */
  async reconfigure() {
    await this.flushLocal();
    this.epoch = (this.epoch || 0) + 1;
    clearTimeout(this.timer); clearInterval(this.pollTimer);
    this.err = null; this.base = null; this.patches = []; this.uploadKeys.clear(); this.textCache.clear();
    this.revokeThumbs();
    await this.init();
  }

  // ---------- ライブラリ（表示用 = base + 未送信パッチ） ----------
  rebuildView() {
    const lib = this.base ? this.base.library : L.emptyLibrary();
    this.library = L.applyPatches(lib, this.patches);
    const sig = JSON.stringify(this.library);
    if (sig === this._libSig) return;               // 中身が変わっていない時は通知しない（一覧が指の下で描き直されて、押したカードがずれるのを避ける）
    this._libSig = sig;
    this.emit('library', this.library);
  }
  item(id) { return this.library.items.find(p => p.id === id) || null; }
  patch(op, { silent = false } = {}) {
    const p = { pid: L.makeItemId('p'), at: L.nowIso(), ...op };
    this.patches = L.coalescePatches(this.patches, p);
    this.persistPatches();
    this.rebuildView();
    if (!silent) this.noteChange(); else this.setStatus();
  }
  persistPatches() {
    const snap = this.patches;
    this._persistQ = this._persistQ.then(() => S.kv.set('patches', snap)).catch(e => this.storageFailed(e));
  }
  storageFailed(e) {
    console.warn('[sync] 端末内に保存できませんでした', e && e.name);
    this.emit('storage-error', e);
  }
  setField(id, key, value, opts) { this.patch({ op: 'setField', id, key, value }, opts); }
  /** タグ：整えて重複を落として tags 欄に書く。まとめて変える時は applyTagChanges */
  setTags(id, tags, opts) { this.setField(id, 'tags', L.uniqueTags(tags), opts); }
  applyTagChanges(changes) { for (const c of changes) this.setTags(c.id, c.tags); return changes.length; }
  /** 画面を離れる前など：保留中の端末内保存を待つ */
  flushLocal() { return this._persistQ; }

  // ---------- アップロード・削除 ----------
  /** job: { key, itemId, v, mode:'new'|'version', entry?, version?, files:[{path, blob}], shas:{} } */
  async queueUpload(job) {
    await S.uploadsDb.put(job);
    this.uploadKeys.add(job.key);
    if (job.mode === 'new') this.patch({ op: 'addItem', entry: job.entry, job: job.key });
    else this.patch({ op: 'addVersion', id: job.itemId, version: job.version, job: job.key });
  }
  async removeItem(id) {
    const item = this.item(id);
    for (const k of [...this.uploadKeys]) if (itemIdOfKey(k) === id) { await S.uploadsDb.del(k).catch(() => {}); this.uploadKeys.delete(k); }
    if (item) await this.dropCache(item);
    this.patch({ op: 'removeItem', id });
  }
  /** この item の端末内の保存（全部の版の HTML とサムネイル）を消す。倉庫には残る */
  async dropCache(item) {
    for (const path of [...(item.versions || []).map(v => v.file), item.thumb]) {
      const sha = path && this.base?.files[path]?.sha;
      if (sha) { await S.blobStore.del(sha).catch(() => {}); const u = this.thumbUrls.get(sha); if (u) { URL.revokeObjectURL(u); this.thumbUrls.delete(sha); } }
    }
    this.emit('cache');
  }
  async clearCaches() {
    await S.blobStore.clear(); this.revokeThumbs(); this.textCache.clear(); this.emit('cache');
  }
  revokeThumbs() { for (const u of this.thumbUrls.values()) URL.revokeObjectURL(u); this.thumbUrls.clear(); }

  // ---------- 読み込み ----------
  async textBlob(sha) {
    if (this.textCache.has(sha)) return this.textCache.get(sha);
    const t = await this.api.getBlobText(sha);
    this.textCache.set(sha, t);
    if (this.textCache.size > 50) this.textCache.delete(this.textCache.keys().next().value);
    return t;
  }
  async _pull(headSha) {
    const api = this.api;
    const commit = await api.getCommit(headSha);
    const tree = await api.getTree(commit.tree.sha);
    if (tree.truncated) throw new GitHubError('validation', '倉庫のファイルが多すぎて一覧が切り詰められました。', { fatal: true });
    const files = {};
    for (const e of tree.tree) if (e.type === 'blob') files[e.path] = { sha: e.sha, size: e.size };
    const libSha = files['library.json']?.sha || null;
    let library = this.base && this.base.libSha === libSha && this.base.library ? this.base.library : null;
    if (!library) {
      library = libSha ? L.normalizeLibrary(JSON.parse(await this.textBlob(libSha))) : L.emptyLibrary();
      if (library.schema > L.SCHEMA) throw new GitHubError('schema', 'この倉庫の形式は、このアプリより新しい版です。', { fatal: true });
    }
    this.base = { repoKey: this.repoKey(), headSha, commitTree: commit.tree.sha, files, libSha, library, fetchedAt: Date.now() };
    await S.kv.set('base', this.base).catch(e => this.storageFailed(e));
    this.rebuildView();
  }
  /** 起動時・定期・画面に戻った時：head を確かめ、変わっていれば読み直す（読むだけ） */
  refresh() {
    if (!this.configured || !this.online) return Promise.resolve();
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const head = await this.api.getRef();
        if (!this.base || this.base.headSha !== head) await this._pull(head);
        this.lastRefreshAt = Date.now();
        if (this.err && ['network', 'offline', 'server'].includes(this.err.kind)) this.err = null;
        this.setStatus();
      } catch (e) { this.handleError(e, 'read'); }
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }
  /** 版の倉庫での sha（無ければ null） */
  shaOf(item, v) { const ver = L.versionOf(item, v); return (ver && this.base?.files[ver.file]?.sha) || null; }
  /**
   * 版の HTML（Blob）を返す。送信待ち → 端末の保存（sha）→ 倉庫（API）の順。倉庫から取った物は端末に保存する（仕様 §4.3 ①）。
   * 返り値 { blob, from:'upload'|'device'|'network' }。失敗は GitHubError（offline＝端末に無くて電波も無い／notfound＝倉庫に無い／network＝通信の失敗）
   */
  async getHtml(item, v, onProgress) {
    const ver = L.versionOf(item, v);
    if (!ver) throw new GitHubError('notfound', `この作品に v${v} の版はありません。`);
    const key = L.jobKey(item.id, ver.v);
    if (this.uploadKeys.has(key)) {
      const job = await S.uploadsDb.get(key).catch(() => null);
      const f = job && job.files.find(x => x.path === ver.file);
      if (f) return { blob: f.blob, from: 'upload' };
    }
    if (!this.base) {
      if (!this.online) throw new GitHubError('offline', 'オフラインで、この端末はまだ倉庫を一度も読めていません。電波のある所で開き直してください。');
      await this.refresh();
      if (!this.base) throw (this.err ? new GitHubError(this.err.kind, this.err.message) : new GitHubError('network', '倉庫を読めませんでした。'));
    }
    const ent = this.base.files[ver.file];
    if (!ent) throw new GitHubError('notfound', '倉庫にこの版のファイルが見つかりません（取り込みの途中かもしれません。少し待ってから開き直してください）。');
    const cached = await S.blobStore.get(ent.sha).catch(() => null);
    if (cached) return { blob: cached, from: 'device' };
    if (!this.online) throw new GitHubError('offline', 'オフラインで、この版はまだ端末に保存されていません。電波のある所で一度開くか、カードの「⋯」→「端末に保存」を使うと、次からは電波が無くても開けます。');
    const blob = await this.api.getBlobRaw(ent.sha, { onProgress, total: ent.size });
    try { await S.blobStore.put(ent.sha, blob, 'html'); this.emit('cache'); } catch (e) { this.storageFailed(e); }   // 保存できなくても開ける
    return { blob, from: 'network' };
  }
  /** カードの「端末に保存」：開かずに版を取って端末に入れる */
  async saveToDevice(item, v) { return this.getHtml(item, v); }
  /** 版を端末から外す（倉庫には残る） */
  async removeFromDevice(item, v) {
    const sha = this.shaOf(item, v);
    if (sha) { await S.blobStore.del(sha).catch(() => {}); this.emit('cache'); }
  }
  async isSaved(item, v) {
    if (this.uploadKeys.has(L.jobKey(item.id, v))) return true;
    const sha = this.shaOf(item, v);
    return sha ? S.blobStore.has(sha) : false;
  }
  async cachedShaSet() { return new Set((await S.blobStore.listMeta()).map(m => m.sha)); }
  /** サムネイルの URL（無ければ null）。取得は同時 3 本まで */
  thumbUrl(item) {
    return new Promise(async resolve => {
      try {
        const ent = item.thumb && this.base?.files[item.thumb];
        if (!ent) return resolve(null);
        if (this.thumbUrls.has(ent.sha)) return resolve(this.thumbUrls.get(ent.sha));
        const cached = await S.blobStore.get(ent.sha).catch(() => null);
        if (cached) { const u = URL.createObjectURL(cached); this.thumbUrls.set(ent.sha, u); return resolve(u); }
        if (!this.online || !this.api) return resolve(null);
        this.thumbQueue.push({ ent, resolve });
        this.pumpThumbs();
      } catch (e) { resolve(null); }
    });
  }
  pumpThumbs() {
    while (this.thumbActive < 3 && this.thumbQueue.length) {
      const { ent, resolve } = this.thumbQueue.shift();
      if (this.thumbUrls.has(ent.sha)) { resolve(this.thumbUrls.get(ent.sha)); continue; }
      this.thumbActive++;
      this.api.getBlobRaw(ent.sha).then(async b => {
        const img = new Blob([b], { type: 'image/jpeg' });
        await S.blobStore.put(ent.sha, img, 'thumb').catch(() => {});
        const u = URL.createObjectURL(img); this.thumbUrls.set(ent.sha, u); resolve(u);
      }).catch(() => resolve(null)).finally(() => { this.thumbActive--; this.pumpThumbs(); });
    }
  }

  // ---------- 送信のスケジュール ----------
  noteChange() { this.lastChangeAt = Date.now(); this.schedule(false); this.setStatus(); }
  schedule(urgent = false) {
    if (!this.configured) return;
    if (this.pendingCount() === 0) { this.setStatus(); return; }
    const now = Date.now();
    let delay = L.computeSendDelay({ now, lastChangeAt: this.lastChangeAt, lastCommitAt: this.lastCommitAt, urgent, quietMs: this.timing.quietMs, gapMs: this.timing.gapMs });
    if (this.retryAt) delay = Math.max(delay, this.retryAt - now);        // 回数制限・失敗後の待ちは緊急でも守る
    clearTimeout(this.timer);
    this.nextSendAt = now + delay;
    this.timer = setTimeout(() => { this.nextSendAt = null; this.flush(); }, delay);
    this.setStatus();
  }
  /** 今すぐ送る（手動の「今すぐ送信」）。回数制限の待ち中は待つ */
  flushNow() {
    if (!(this.err && this.err.kind === 'rate')) { this.err = null; this.retryAt = null; }
    if (this.pendingCount()) this.schedule(true);
    return this.sending || Promise.resolve();
  }
  /** アップロードなど：静かになるのを待たずに送りたい（ただしコミットの間は 60 秒空ける） */
  requestSoon() { this.lastChangeAt = null; this.schedule(false); }
  async flush() {
    clearTimeout(this.timer); this.nextSendAt = null;
    if (!this.configured || this.pendingCount() === 0) { this.setStatus(); return; }
    if (this.sending) { this.again = true; return this.sending; }
    if (!this.online) { this.setStatus(); return; }
    this.sending = (async () => { await this.flushLocal(); await this._sendLoop(); })().finally(() => {
      this.sending = null; this.progress = null;
      if ((this.again || this.pendingCount() > 0) && !this.err) { this.again = false; this.schedule(false); }
      this.setStatus();
    });
    this.setStatus();
    return this.sending;
  }
  async _sendLoop() {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        await this._sendOnce();
        this.err = null; this.retryAt = null; this.failures = 0;
        return;
      } catch (e) {
        if (e instanceof GitHubError && e.kind === 'conflict' && attempt < 3) { await sleep(600 * (attempt + 1)); continue; }
        if (e instanceof GitHubError && e.kind === 'retry') continue;
        this.handleError(e, 'write');
        return;
      }
    }
  }
  handleError(e, mode) {
    if (!(e instanceof GitHubError)) { console.error('[sync] 想定外のエラー', e && e.message); e = new GitHubError('internal', '想定外のエラーが起きました：' + (e && e.message ? e.message : e)); }
    const now = Date.now();
    const err = { kind: e.kind, message: e.message, retryAt: null, fatal: ['auth', 'forbidden', 'notfound', 'schema', 'toolarge'].includes(e.kind) || !!e.fatal };
    if (e.kind === 'rate') { err.retryAt = now + e.waitSec * 1000; this.retryAt = err.retryAt; }
    else if (!err.fatal && ['network', 'offline', 'server', 'conflict', 'internal', 'validation'].includes(e.kind)) {
      this.failures++;
      const wait = e.kind === 'offline' ? 0 : Math.min(120, 10 * 2 ** (this.failures - 1)) * 1000;
      if (wait) { err.retryAt = now + wait; this.retryAt = err.retryAt; }
    }
    this.err = err;
    if (mode === 'write' && err.retryAt && this.pendingCount()) {
      clearTimeout(this.timer); this.nextSendAt = err.retryAt;
      this.timer = setTimeout(() => { this.err = null; this.retryAt = null; this.nextSendAt = null; this.flush(); }, Math.max(0, err.retryAt - now));
    }
    if (mode === 'read' && err.retryAt) { /* 読み取りの失敗は次の定期読み込みで直る */ err.retryAt = null; }
    this.setStatus();
    this.emit('problem', err);
  }

  // ---------- 1 回の送信（1 コミット・複数ファイル）----------
  async _sendOnce() {
    const api = this.api, epoch = this.epoch || 0;
    const patches = [...this.patches];
    const jobs = (await Promise.all([...this.uploadKeys].map(k => S.uploadsDb.get(k)))).filter(Boolean);
    if (!patches.length && !jobs.length) return;
    this.progress = { text: '最新の状態を確認中…' }; this.setStatus();

    // 1) 最新の head（古ければ library と tree を読み直す）
    const headSha = await api.getRef();
    if (!this.base || this.base.headSha !== headSha) await this._pull(headSha);
    const base = this.base;

    // 2) library：パッチを最新の library に掛け直す。消えた item・版のファイルは倉庫からも消す
    const files = [];                                   // {path, text|blob, job?}
    const deletes = [];
    const parts = [];
    const renamed = await this._resolveUploadCollisions(base, jobs);
    const work = patches.map(p => (p.job && renamed.has(p.job) ? renamed.get(p.job)(p) : p));   // id を付け替えたアップロードのパッチも直す（最初に取った分だけ送る）
    let newLib = null;
    if (work.length || jobs.length) {
      newLib = L.applyPatches(base.library, work);
      const after = new Map(newLib.items.map(i => [i.id, i]));
      const keep = new Set();
      for (const it of newLib.items) { for (const v of it.versions || []) keep.add(v.file); if (it.thumb) keep.add(it.thumb); }
      for (const it of base.library.items) {
        if (!after.has(it.id)) {                        // 倉庫から消す item：フォルダ内の全ファイルを削除
          for (const path of Object.keys(base.files)) if (path.startsWith(L.itemFolder(it.id))) deletes.push(path);
          parts.push(`delete: ${it.id}`);
          continue;
        }
        for (const v of it.versions || []) if (!keep.has(v.file) && base.files[v.file]) { deletes.push(v.file); parts.push(`delete: ${it.id}@v${v.v}`); }
      }
      newLib.updatedAt = L.nowIso();
      files.push({ path: 'library.json', text: L.stringifyJson(newLib) });
    }
    const live = new Map((newLib || base.library).items.map(i => [i.id, i]));
    const jobLive = job => { const it = live.get(job.itemId); return !!it && (it.versions || []).some(v => job.files.some(f => f.path === v.file)); };
    for (const job of jobs) if (jobLive(job)) parts.push(`upload: ${job.itemId}@v${job.v}`);
    const libraryOnly = work.filter(p => !p.job && p.op !== 'removeItem');
    if (libraryOnly.length) parts.push(`library: ${libraryOnly.length}件`);
    for (const job of jobs) {
      if (!jobLive(job)) continue;
      for (const f of job.files) files.push({ path: f.path, blob: f.blob, job });
    }
    const written = new Set(files.map(f => f.path));

    // 3) blob を作る（直列・書き込みの間は 1 秒）
    const entries = [], sizes = {};
    let i = 0;
    for (const f of files) {
      i++;
      this.progress = { text: `ファイルを送信中… ${i}/${files.length}${f.blob ? `（${f.path.split('/').slice(-2).join('/')} ${(f.blob.size / 1048576).toFixed(1)}MB）` : ''}` }; this.setStatus();
      let sha = f.job?.shas?.[f.path];
      if (!sha) {
        try {
          sha = f.blob ? await api.createBlobBase64(f.blob) : await api.createBlobText(f.text);
        } catch (e) {
          if (e instanceof GitHubError && e.kind === 'toolarge' && f.job) {      // 大きすぎて断られたアップロードは取り消して、ほかの変更は送り続ける
            await this._failUpload(f.job, e);
            throw new GitHubError('retry', 'アップロードを取り消して続けます');
          }
          throw e;
        }
        if (f.job) { (f.job.shas ||= {})[f.path] = sha; await S.uploadsDb.put(f.job).catch(() => {}); }
      }
      f.sha = sha; f.size = f.blob ? f.blob.size : utf8Len(f.text);
      if (base.files[f.path]?.sha === sha) continue;                  // 倉庫と同じ中身は送らない
      entries.push({ path: f.path, mode: '100644', type: 'blob', sha });
      sizes[f.path] = f.size;
    }
    for (const path of new Set(deletes)) if (base.files[path] && !written.has(path)) entries.push({ path, mode: '100644', type: 'blob', sha: null });

    // 4) tree → commit → ref
    let commitSha = headSha, treeSha = base.commitTree;
    if (entries.length) {
      this.progress = { text: 'コミットを作成中…' }; this.setStatus();
      treeSha = await api.createTree(base.commitTree, entries);
      const message = (parts.length ? parts.join(' / ') : 'sync') + `（${this.device}）`;
      commitSha = await api.createCommit(message, treeSha, [headSha]);
      await api.updateRef(commitSha);                                // 競合なら GitHubError('conflict') → 呼び出し側が最初からやり直す
    }

    // 5) 後始末：base を新しい状態に、送った分を未送信から外す（途中で設定が変わっていたら、新しい設定の状態を壊さないよう何もしない）
    if ((this.epoch || 0) !== epoch) return;
    const newFiles = { ...base.files };
    for (const e of entries) { if (e.sha === null) delete newFiles[e.path]; else newFiles[e.path] = { sha: e.sha, size: sizes[e.path] }; }
    const libEntry = files.find(f => f.path === 'library.json');
    this.base = { ...base, headSha: commitSha, commitTree: treeSha, files: newFiles, libSha: libEntry ? libEntry.sha : base.libSha, library: newLib || base.library, fetchedAt: Date.now() };
    await S.kv.set('base', this.base).catch(e => this.storageFailed(e));
    const sent = new Set(work.map(p => p.pid));
    this.patches = this.patches.filter(p => !sent.has(p.pid));
    this.persistPatches();
    for (const job of jobs) {
      if (jobLive(job)) for (const f of files.filter(x => x.job === job && x.blob)) await S.blobStore.put(f.sha, f.blob, 'html').catch(() => {});   // 自分で足した HTML は、そのまま「端末に保存」済みにする
      await S.uploadsDb.del(job.key).catch(() => {});
      this.uploadKeys.delete(job.key);
    }
    this.lastCommitAt = Date.now();
    this.rebuildView();
    this.emit('cache');
    this.emit('committed', { head: commitSha, parts });
  }

  /** 送れなかったアップロードを取り消す（ライブラリからも外す） */
  async _failUpload(job, e) {
    await S.uploadsDb.del(job.key).catch(() => {}); this.uploadKeys.delete(job.key);
    this.patches = this.patches.filter(p => p.job !== job.key);
    this.persistPatches(); this.rebuildView();
    this.emit('upload-failed', { itemId: job.itemId, title: (job.entry && job.entry.title) || (this.item(job.itemId) || {}).title, message: e.message });
  }

  /** 別の端末が同じ id で別の作品を先に入れていたら、新しい作品のアップロードの id を付け替える（上書き事故を防ぐ） */
  async _resolveUploadCollisions(base, jobs) {
    const renamed = new Map();                          // 元のキー → パッチを直す関数
    const taken = new Set([...base.library.items.map(p => p.id), ...jobs.map(j => j.itemId)]);
    for (const job of jobs) {
      if (job.mode !== 'new') continue;
      const remote = base.library.items.find(p => p.id === job.itemId);
      if (!remote) continue;
      if (remote.source === job.entry.source && (remote.versions || []).some(v => v.file === job.files[0].path)) continue;   // 自分の前回の送信が通っていた
      const others = new Set([...taken]); others.delete(job.itemId);
      const newId = L.uniqueId(job.itemId.replace(/-\d+$/, ''), new Set([...others, ...base.library.items.map(p => p.id)]));
      if (newId === job.itemId) continue;
      const oldId = job.itemId, oldKey = job.key;
      await S.uploadsDb.del(oldKey); this.uploadKeys.delete(oldKey);
      job.itemId = newId; job.key = L.jobKey(newId, job.v); job.shas = {};
      job.files = job.files.map(f => ({ ...f, path: f.path.replace(L.itemFolder(oldId), L.itemFolder(newId)) }));
      job.entry = { ...job.entry, id: newId, versions: job.entry.versions.map(v => ({ ...v, file: v.file.replace(L.itemFolder(oldId), L.itemFolder(newId)) })) };
      await S.uploadsDb.put(job); this.uploadKeys.add(job.key);
      const fix = p => ({ ...p, entry: job.entry, job: job.key });
      renamed.set(oldKey, fix);
      this.patches = this.patches.map(p => (p.job === oldKey ? fix(p) : p));
      for (const vj of jobs) {                          // 同じ回に足した「その作品の別の版」も付け替える
        if (vj.mode !== 'version' || vj.itemId !== oldId) continue;
        const vOld = vj.key;
        await S.uploadsDb.del(vOld); this.uploadKeys.delete(vOld);
        vj.itemId = newId; vj.key = L.jobKey(newId, vj.v); vj.shas = {};
        vj.files = vj.files.map(f => ({ ...f, path: f.path.replace(L.itemFolder(oldId), L.itemFolder(newId)) }));
        vj.version = { ...vj.version, file: L.versionFile(newId, vj.v) };
        await S.uploadsDb.put(vj); this.uploadKeys.add(vj.key);
        const vfix = p => ({ ...p, id: newId, version: vj.version, job: vj.key });
        renamed.set(vOld, vfix);
        this.patches = this.patches.map(p => (p.job === vOld ? vfix(p) : p));
      }
      this.persistPatches();
      taken.add(newId);
    }
    return renamed;
  }
}
