// store.js : 端末内の保存（IndexedDB の薄い包み）。ローカル優先：書き込みはまずここに入れ、あとで倉庫へ送る。
//   meta     … 'base'（最後に読んだ倉庫の状態）・'patches'（未送信のライブラリ操作）
//   blobs    … sha をキーにした HTML・サムネイル（blob は sha で不変。ここにある版は電波が無くても開ける＝「端末に保存」）
//   blobmeta … blobs の大きさ・種類（'html'|'thumb'。一覧に blob 本体を読み込まないため）
//   uploads  … 送信待ちのアップロード（HTML 本体つき。キーは「<id>@v<N>」）
// 論文リーダーの store.js から notes（メモ・線）を外した。DB の名前は別（同じ端末で論文リーダーと混ざらない）。
const DB_NAME = 'html-library-v1';
const STORES = ['meta', 'blobs', 'blobmeta', 'uploads'];
let dbp = null;

export function openDb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const s of STORES) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => { db.close(); dbp = null; };
      resolve(db);
    };
    r.onerror = () => { dbp = null; reject(r.error); };
    r.onblocked = () => { dbp = null; reject(new Error('IndexedDB がほかのタブでふさがれています')); };
  });
  return dbp;
}
const req = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = t => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('transaction aborted')); });

async function get(store, key) { const db = await openDb(); return req(db.transaction(store, 'readonly').objectStore(store).get(key)); }
async function getAll(store) { const db = await openDb(); return req(db.transaction(store, 'readonly').objectStore(store).getAll()); }
async function put(store, key, val) { const db = await openDb(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).put(val, key); await done(t); }
async function del(store, key) { const db = await openDb(); const t = db.transaction(store, 'readwrite'); t.objectStore(store).delete(key); await done(t); }
async function keys(store) { const db = await openDb(); return req(db.transaction(store, 'readonly').objectStore(store).getAllKeys()); }

export const kv = {
  get: k => get('meta', k),
  set: (k, v) => put('meta', k, v),
  del: k => del('meta', k),
};

export const blobStore = {
  async has(sha) { return !!(await get('blobmeta', sha)); },
  async get(sha) { return get('blobs', sha); },
  async put(sha, blob, kind = 'blob') {
    const db = await openDb();
    const t = db.transaction(['blobs', 'blobmeta'], 'readwrite');
    t.objectStore('blobs').put(blob, sha);
    t.objectStore('blobmeta').put({ sha, size: blob.size, kind, ts: Date.now() }, sha);
    await done(t);
  },
  async del(sha) {
    const db = await openDb();
    const t = db.transaction(['blobs', 'blobmeta'], 'readwrite');
    t.objectStore('blobs').delete(sha); t.objectStore('blobmeta').delete(sha);
    await done(t);
  },
  async listMeta() { return getAll('blobmeta'); },
  /** 種類ごとの件数と合計 { html:{n,size}, thumb:{n,size}, all:{n,size} } */
  async summary() {
    const out = { html: { n: 0, size: 0 }, thumb: { n: 0, size: 0 }, all: { n: 0, size: 0 } };
    for (const m of await getAll('blobmeta')) {
      const k = m.kind === 'html' ? 'html' : 'thumb';
      out[k].n++; out[k].size += m.size || 0; out.all.n++; out.all.size += m.size || 0;
    }
    return out;
  },
  async clear() {
    const db = await openDb();
    const t = db.transaction(['blobs', 'blobmeta'], 'readwrite');
    t.objectStore('blobs').clear(); t.objectStore('blobmeta').clear();
    await done(t);
  },
};

export const uploadsDb = {
  get: key => get('uploads', key),
  put: job => put('uploads', job.key, job),
  del: key => del('uploads', key),
  all: () => getAll('uploads'),
  keys: () => keys('uploads'),
};

/** この端末の保存をすべて消す（接続先を変えた時など） */
export async function clearAll() {
  const db = await openDb();
  const t = db.transaction(STORES, 'readwrite');
  for (const n of STORES) t.objectStore(n).clear();
  await done(t);
}
export async function storageEstimate() {
  try { const e = await navigator.storage?.estimate?.(); return e ? { usage: e.usage || 0, quota: e.quota || 0 } : null; } catch (e) { return null; }
}
export async function requestPersistence() {
  try { return await navigator.storage?.persist?.(); } catch (e) { return false; }
}
