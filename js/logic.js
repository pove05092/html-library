// logic.js : HTMLライブラリの純粋なロジック（DOM も通信も持たない）。ブラウザと Node の単体試験の両方から読む。
// 仕様書 research/spec_v1.md §3（データ形式）・§3.4（同期の規則）に対応。論文リーダー site_v3 の logic.js を写して、PDF・メモ・フォルダの部分を外し、版・種類を足した。

export const SCHEMA = 1;

// ---------- 文言（題名を後から変えやすいよう、名前はここ 1 か所に置く。index.html・manifest の名前は別に直す）----------
export const STRINGS = {
  appName: 'HTMLライブラリ',
  item: '作品',
  lead: 'ゲーム・指南書・ドリルなどの HTML を一か所にためて、PC でもスマホでも開くためのアプリです。',
  noProgress: '進捗は保存されません（このサイトの方針）',
};

// ---------- 種類（仕様 §3.3：5 つ固定。表示名・並び順・色はここだけ）----------
export const KINDS = [
  { key: 'game', label: 'ゲーム', color: '#b8552f' },
  { key: 'guide', label: '指南書', color: '#1f6f6b' },
  { key: 'drill', label: 'ドリル', color: '#6d4f9e' },
  { key: 'tool', label: 'ツール', color: '#8a5a12' },
  { key: 'other', label: 'その他', color: '#6b665b' },
];
const KIND_KEYS = new Set(KINDS.map(k => k.key));
export const normalizeKind = k => (KIND_KEYS.has(k) ? k : 'other');
export const kindInfo = k => KINDS.find(x => x.key === normalizeKind(k));

// ---------- 時刻・乱数 ----------
export const nowIso = () => new Date().toISOString();
/** ISO 文字列 → ミリ秒。null・不正は「最古」扱い */
export function tsOf(s) {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
}
const B36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function randomString(n = 6) {
  const a = new Uint8Array(n);
  globalThis.crypto.getRandomValues(a);
  let s = '';
  for (let i = 0; i < n; i++) s += B36[a[i] % 36];
  return s;
}
/** パッチなどの id（例 p-k3j9x2） */
export function makeItemId(prefix, rand = randomString) { return `${prefix}-${rand(6)}`; }

/** キー順を固定した JSON（比較用） */
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
export const sameJson = (a, b) => canon(a) === canon(b);
/** 倉庫に書く JSON の書式（仕様 §3.3：UTF-8・インデント 1・末尾の改行。母艦の取り込みと揃える） */
export const stringifyJson = obj => JSON.stringify(obj, null, 1) + '\n';

// ---------- id（仕様 §3.2）----------
export const ID_RE = /^[a-z0-9][a-z0-9-]*$/;
export const ID_MAX = 40;
export const isValidId = id => typeof id === 'string' && id.length <= ID_MAX && ID_RE.test(id);
/** 衝突したら -2, -3 … */
export function uniqueId(base, existing) {
  const has = existing instanceof Set ? x => existing.has(x) : x => existing.includes(x);
  if (!has(base)) return base;
  for (let n = 2; ; n++) if (!has(`${base}-${n}`)) return `${base}-${n}`;
}
const fileStem = name => String(name).replace(/^.*[\\/]/, '').normalize('NFC').replace(/\.html?$/i, '');
/** ファイル名 → { base（_vN を除いた名前）, v（版番号。無ければ null）}。版はファイル名末尾の「_vN」（仕様 §4.2） */
export function parseVersionFromName(name) {
  const stem = fileStem(name);
  const m = /^(.*?)_v(\d+)$/i.exec(stem);
  if (m && m[1]) return { base: m[1], v: Number(m[2]) };
  return { base: stem, v: null };
}
/**
 * 画面から足す時の id（仕様 §3.2）：ファイル名（_vN を除く）が ASCII なら slug 化、日本語などなら item-YYYYMMDD-xxxx。衝突したら -2, -3。
 * 40 字に収まるよう、slug は 36 字で切る（-NN の余地）。
 */
export function makeItemIdFromFilename(name, existing, now = new Date(), rand = randomString) {
  const { base } = parseVersionFromName(name);
  let id = '';
  if (/^[\x20-\x7e]+$/.test(base)) id = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/, '');
  if (!id || !ID_RE.test(id)) {
    const d = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    id = `item-${d}-${rand(4)}`;
  }
  return uniqueId(id, existing);
}

// ---------- HTML の中身から ----------
/**
 * HTML らしいか（仕様 §4.2 を 2026-11-06 に緩めた：色彩検定ドリルは冒頭が <meta> の断片で、<html>・<body>・<!doctype> が無いため）。
 * <!doctype・<html・<head・<body・<meta・<div・<script・<style・<p・<h1〜<h6・<table・<canvas のどれかのタグを含めば受け付ける。タグが 1 つも無い物だけ断る。
 * （タグ名の後ろは空白・「>」・「/」に限る＝<pre>・<path> を <p> と取り違えない）
 */
export const looksLikeHtml = text => /<!doctype[\s>]|<(?:html|head|body|meta|div|script|style|p|h[1-6]|table|canvas)(?=[\s>\/])/i.test(String(text || ''));
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); try { return String.fromCodePoint(n); } catch (err) { return m; } }
    return ENT[e.toLowerCase()] ?? m;
  });
}
/** <title> の中身（無ければ ''）。空白はそろえる */
export function extractHtmlTitle(html) {
  const m = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title\s*>/i.exec(String(html || '').slice(0, 200000));
  return m ? decodeEntities(m[1]).replace(/\s+/g, ' ').trim().slice(0, 200) : '';
}
/** バイト列 → 文字列。BOM・<meta charset> を見て、無ければ UTF-8（母艦の HTML はすべて UTF-8） */
export function decodeHtml(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  const head = new TextDecoder('latin1').decode(u8.subarray(0, 4096));
  const m = /<meta[^>]+charset\s*=\s*["']?\s*([a-z0-9_\-]+)/i.exec(head);
  let enc = m ? m[1].toLowerCase() : 'utf-8';
  if (/^(x-)?(sjis|shift[-_]?jis|ms932|windows-31j|cp932)$/.test(enc)) enc = 'shift_jis';
  try { return new TextDecoder(enc).decode(u8); } catch (e) { return new TextDecoder('utf-8').decode(u8); }
}

// ---------- 題名の正規化（仕様 §4.2：同じ題名の既存 item を探す）----------
/** 全角半角・大文字小文字・空白・区切り記号・末尾の版番号の違いを無視する鍵 */
export function normalizeTitle(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[\s_\-]+v\d+\s*$/i, '')
    .replace(/[\s_\-・･:：;；,，、。.．()（）\[\]［］{}「」『』【】〈〉《》'"“”‘’!！?？~〜]/g, '');
}
/** 版の source（例 "mothership:算数の工場_計算ゲーム_v13.html"・"upload:foo_v2.html"）→ ファイル名の基の正規化 */
export function sourceBaseKey(source) {
  const s = String(source || '').replace(/^[a-z]+:/i, '');
  if (!/\.html?$/i.test(s)) return '';
  return normalizeTitle(parseVersionFromName(s).base);
}
/** 足そうとしている HTML に当たる既存の item（題名の一致、または版のファイル名の基の一致）。無ければ null */
export function findSameItem(items, { title, filename }) {
  const t = normalizeTitle(title), f = filename ? normalizeTitle(parseVersionFromName(filename).base) : '';
  if (t) { const hit = items.find(i => normalizeTitle(i.title) === t); if (hit) return hit; }
  if (f) {
    const hit = items.find(i => normalizeTitle(i.title) === f || (i.versions || []).some(v => sourceBaseKey(v.source) === f));
    if (hit) return hit;
  }
  return null;
}

// ---------- 版（仕様 §3.3：versions は v の昇順・最新＝最後の要素）----------
export const itemFolder = id => `items/${id}/`;
export const versionFile = (id, v) => `items/${id}/v${v}.html`;
export const latestVersion = item => { const vs = (item && item.versions) || []; return vs.length ? vs[vs.length - 1] : null; };
export const versionOf = (item, v) => ((item && item.versions) || []).find(x => x.v === Number(v)) || null;
export const nextVersionNumber = item => Math.max(0, ...((item && item.versions) || []).map(x => x.v)) + 1;
/** 版の配列を整える：数値の v だけ・同じ v は後に出た方・昇順 */
export function normalizeVersions(list) {
  const m = new Map();
  for (const x of Array.isArray(list) ? list : []) if (x && Number.isInteger(x.v) && x.v >= 0 && typeof x.file === 'string') m.set(x.v, x);
  return [...m.values()].sort((a, b) => a.v - b.v);
}
/** 版を 1 つ足す（同じ v は上書き）。item を直接変える */
export function insertVersion(item, ver) {
  item.versions = normalizeVersions([...(item.versions || []).filter(x => x.v !== ver.v), structuredClone(ver)]);
  return item;
}
/** 版の大きさの合計（カードの「大きさ」は最新版の大きさ。合計は設定などで使う） */
export const totalSize = item => ((item && item.versions) || []).reduce((a, v) => a + (v.size || 0), 0);

// ---------- library.json（仕様 §3.3）とパッチ（§3.4）----------
export const emptyLibrary = () => ({ schema: SCHEMA, updatedAt: nowIso(), items: [] });
export function normalizeLibrary(raw) {
  const l = raw && typeof raw === 'object' ? { ...raw } : {};
  l.schema = typeof l.schema === 'number' ? l.schema : SCHEMA;
  l.updatedAt = typeof l.updatedAt === 'string' ? l.updatedAt : nowIso();
  l.items = (Array.isArray(l.items) ? l.items : []).filter(p => p && typeof p.id === 'string').map(p => ({
    ...p, kind: normalizeKind(p.kind), tags: Array.isArray(p.tags) ? p.tags.filter(t => typeof t === 'string') : [], versions: normalizeVersions(p.versions),
  }));
  return l;
}
/** 取り込み側（B）・アップロードが既存 id に当たった時に上書きしてよい「機械的な欄」。本人が触る欄（title・kind・description・tags・lastOpenedAt）は守る */
export const MACHINE_FIELDS = ['versions', 'thumb', 'source', 'updatedAt'];
/** updatedAt を進めない欄（開いただけで「更新日」が変わらないように） */
const QUIET_FIELDS = new Set(['lastOpenedAt']);

/** パッチ1件を適用（library は破壊的に変更。呼び出し側で複製しておく） */
export function applyPatch(lib, p) {
  const at = p.at || nowIso();
  const find = id => lib.items.find(x => x.id === id);
  switch (p.op) {
    case 'setField': {
      const it = find(p.id);
      if (it) { it[p.key] = p.key === 'kind' ? normalizeKind(p.value) : p.value; if (!QUIET_FIELDS.has(p.key)) it.updatedAt = at; }
      break;
    }
    case 'addItem': {
      const cur = find(p.entry.id);
      if (cur) { for (const k of MACHINE_FIELDS) if (k in p.entry) cur[k] = k === 'versions' ? normalizeVersions(structuredClone(p.entry.versions)) : structuredClone(p.entry[k]); }
      else { const e = structuredClone(p.entry); e.kind = normalizeKind(e.kind); e.versions = normalizeVersions(e.versions); lib.items.push(e); }
      break;
    }
    case 'removeItem': lib.items = lib.items.filter(x => x.id !== p.id); break;
    case 'addVersion': {
      const it = find(p.id);
      if (it && p.version && Number.isInteger(p.version.v)) { insertVersion(it, p.version); it.updatedAt = at; }
      break;
    }
    case 'removeVersion': {
      const it = find(p.id);
      if (it && (it.versions || []).length > 1 && it.versions.some(x => x.v === p.v)) { it.versions = it.versions.filter(x => x.v !== p.v); it.updatedAt = at; }   // 最後の 1 つは消せない
      break;
    }
    default: break;   // 知らない操作は無視（将来の版が積んだものを壊さない）
  }
  lib.updatedAt = at;
  return lib;
}
export function applyPatches(lib, patches) {
  const out = structuredClone(lib);
  for (const p of patches) applyPatch(out, p);
  return out;
}
/** 積んであるパッチの整理：同じ (id,key) の setField は新しい方だけ残す（間に addItem/removeItem があれば残す） */
export function coalescePatches(patches, next) {
  if (next.op !== 'setField') return [...patches, next];
  const out = [...patches];
  for (let i = out.length - 1; i >= 0; i--) {
    const q = out[i];
    if ((q.op === 'addItem' && q.entry.id === next.id) || (q.op === 'removeItem' && q.id === next.id)) break;
    if (q.op === 'setField' && q.id === next.id && q.key === next.key) { out.splice(i, 1); break; }
  }
  out.push(next);
  return out;
}

// ---------- 一覧の絞り込み・並べ替え ----------
export function searchMatch(p, q) {
  const terms = String(q || '').normalize('NFKC').toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [p.title, p.description, p.id, kindInfo(p.kind).label, ...(p.tags || [])].join('\n').normalize('NFKC').toLowerCase();
  return terms.every(t => hay.includes(t));
}
export function filterItems(items, { kind = 'all', q = '', tags = [] } = {}) {
  return items.filter(p => (kind === 'all' || normalizeKind(p.kind) === kind) && hasAllTags(p, tags) && searchMatch(p, q));
}
/** 種類ごとの件数（0 件の種類も 0 で出す） */
export function kindCounts(items) {
  const c = { all: items.length };
  for (const k of KINDS) c[k.key] = 0;
  for (const p of items) c[normalizeKind(p.kind)]++;
  return c;
}
/** 「更新日」：updatedAt、無ければ最新版の addedAt */
export const updatedOf = p => (p.updatedAt || (latestVersion(p) || {}).addedAt || p.addedAt || null);
export const SORTS = [['recent', '最近開いた順'], ['added', '追加順'], ['updated', '更新順'], ['title', '名前順']];
export function sortItems(items, key = 'recent') {
  const a = [...items];
  const t = s => tsOf(s);
  const title = (x, y) => String(x.title || '').localeCompare(String(y.title || ''), 'ja');
  if (key === 'added') a.sort((x, y) => (t(y.addedAt) - t(x.addedAt)) || title(x, y));
  else if (key === 'updated') a.sort((x, y) => (t(updatedOf(y)) - t(updatedOf(x))) || title(x, y));
  else if (key === 'title') a.sort(title);
  else a.sort((x, y) => {
    const ox = t(x.lastOpenedAt), oy = t(y.lastOpenedAt);
    if (ox !== oy) return oy > ox ? 1 : -1;                // 最近開いた順（未オープンは後ろ）
    return (t(y.addedAt) - t(x.addedAt)) || title(x, y);
  });
  return a;
}

// ---------- タグ（論文リーダー v2 のタグ機能をそのまま。papers → items の読み替えのみ）----------
// 保存の形は item の tags 欄（文字列の配列）。タグという別の台帳は持たない＝名前を変える・消すは「付いている item の tags を書き換える」操作。
export const TAG_MAX_LEN = 30;
/** 付ける名前の整え方：空白をそろえて前後を落とし、30 字まで */
export const cleanTag = s => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, TAG_MAX_LEN);
/** 同じタグとみなす鍵：全角半角・大文字小文字・空白の違いは無視 */
export const tagKey = s => cleanTag(String(s ?? '').normalize('NFKC')).toLowerCase();
/** 入力欄の文字列をタグに割る（カンマ「,」「、」「，」と改行で区切る） */
export const parseTagInput = str => uniqueTags(String(str ?? '').split(/[,、，\n]/));
/** 整えて、同じタグ（tagKey が同じ）の重複を落とす。先に出た表記を残す */
export function uniqueTags(list) {
  const seen = new Set(), out = [];
  for (const t of list || []) { const c = cleanTag(t), k = tagKey(c); if (!k || seen.has(k)) continue; seen.add(k); out.push(c); }
  return out;
}
export const hasTag = (p, name) => (p.tags || []).some(t => tagKey(t) === tagKey(name));
export const hasAllTags = (p, names) => !names || !names.length || names.every(n => hasTag(p, n));
/** 全 item のタグの一覧 [{ name, count }]。表記ゆれは一つにまとめ、名前は一番多い表記（同数なら先に出た方）。多い順→五十音順 */
export function tagList(items) {
  const m = new Map();
  for (const p of items) {
    for (const t of uniqueTags(p.tags)) {
      const k = tagKey(t); let e = m.get(k);
      if (!e) { e = { count: 0, forms: new Map() }; m.set(k, e); }
      e.count++; e.forms.set(t, (e.forms.get(t) || 0) + 1);
    }
  }
  const out = [];
  for (const e of m.values()) {
    let best = null, bn = -1;
    for (const [f, n] of e.forms) if (n > bn) { best = f; bn = n; }
    out.push({ name: best, count: e.count });
  }
  return out.sort((a, b) => (b.count - a.count) || a.name.localeCompare(b.name, 'ja'));
}
/** 既にある同じタグの表記があればそれに合わせる。無ければ整えた名前 */
export function canonicalTag(items, name) {
  const c = cleanTag(name), k = tagKey(c);
  const f = tagList(items).find(t => tagKey(t.name) === k);
  return f ? f.name : c;
}
/** 以下は「item ごとの新しい tags」のリスト [{ id, tags }] を返す（変わる item だけ）。適用は engine.setTags で1件ずつ */
export function addTagChanges(items, ids, name) {
  const n = canonicalTag(items, name); if (!tagKey(n)) return [];
  const want = new Set(ids), out = [];
  for (const p of items) if (want.has(p.id) && !hasTag(p, n)) out.push({ id: p.id, tags: uniqueTags([...(p.tags || []), n]) });
  return out;
}
export function removeTagChanges(items, ids, name) {
  const want = ids ? new Set(ids) : null, out = [];
  for (const p of items) if ((!want || want.has(p.id)) && hasTag(p, name)) out.push({ id: p.id, tags: uniqueTags((p.tags || []).filter(t => tagKey(t) !== tagKey(name))) });
  return out;
}
/** 名前の変更。変更先が別の既存タグと同じなら統合（その表記に合わせる）。大文字小文字だけの変更は、打った表記にする */
export function renameTagChanges(items, from, to) {
  const fk = tagKey(from), c = cleanTag(to); if (!tagKey(c)) return [];
  const toName = tagKey(c) === fk ? c : canonicalTag(items, c), out = [];
  for (const p of items) {
    if (!hasTag(p, from)) continue;
    const next = uniqueTags((p.tags || []).map(t => (tagKey(t) === fk ? toName : t)));
    if (JSON.stringify(next) !== JSON.stringify(p.tags || [])) out.push({ id: p.id, tags: next });
  }
  return out;
}
export const deleteTagChanges = (items, name) => removeTagChanges(items, null, name);

// ---------- 送信のタイミング（論文リーダーと同じ：10 秒静かに／コミットの間は 60 秒）----------
export const TIMING = { quietMs: 10000, gapMs: 60000, writeGapMs: 1000, pollMs: 60000 };
/** 次に送るまでの待ち時間(ms)。urgent（画面を離れる・閉じる・手動）は待たない */
export function computeSendDelay({ now, lastChangeAt, lastCommitAt, urgent = false, quietMs = TIMING.quietMs, gapMs = TIMING.gapMs }) {
  if (urgent) return 0;
  const q = lastChangeAt == null ? 0 : lastChangeAt + quietMs - now;
  const g = lastCommitAt == null ? 0 : lastCommitAt + gapMs - now;
  return Math.max(0, q, g);
}

// ---------- 表示用 ----------
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
}
/** アップロードの待ち行列のキー（同じ item に複数の版を同時に足せるよう、版ごと） */
export const jobKey = (id, v) => `${id}@v${v}`;
/** base64 を 3 バイト単位で分割するときの 1 片の大きさ（3 の倍数なので連結して正しい base64 になる） */
export const B64_CHUNK = 3 * 1024 * 1024;
