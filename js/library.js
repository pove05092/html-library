// library.js : ライブラリ（ホーム）。種類・タグ・検索・並べ替え・カード・複数選択・追加。仕様 §4.2。
// 論文リーダー site_v3 の library.js を写して、フォルダを「種類」に、論文の情報を「版・大きさ・更新日・端末に保存済みの印」に置き換えた。
import * as L from './logic.js';
import { h, icon, clear, debounce, openMenu, confirmDialog, promptDialog, pickDialog, toast, fmtDate } from './ui.js';
import * as T from './tags.js';

const TAGS_ON_CARD = 3;

export function renderLibrary({ engine, host, go, prefs, pill, onFiles }) {
  const saved = prefs.get().lib || {};
  const sortKeys = new Set(L.SORTS.map(s => s[0]));
  const ui = { kind: saved.kind && (saved.kind === 'all' || L.KINDS.some(k => k.key === saved.kind)) ? saved.kind : 'all', sort: sortKeys.has(saved.sort) ? saved.sort : 'recent',
    tags: Array.isArray(saved.tags) ? saved.tags : [], q: '', selecting: false, selected: new Set() };
  const persist = () => prefs.set({ lib: { kind: ui.kind, sort: ui.sort, tags: ui.tags } });      // 選んだ種類・並べ替え・タグは端末ごとに覚える
  const filterOpts = () => ({ kind: ui.kind, q: ui.q, tags: ui.tags });
  let destroyed = false, cached = new Set(), gridSig = '';
  const cardEls = new Map();                                                   // id → { sig, el }（作り置きのカード）

  // ---------- 骨組み ----------
  const search = h('input', { class: 'input search', type: 'search', placeholder: '題名・説明・タグで検索', 'aria-label': '検索', enterkeyhint: 'search', dataset: { t: 'search' } });
  search.addEventListener('input', debounce(() => { ui.q = search.value; renderGrid(); }, 120));
  const pickFiles = () => fileInput.click();
  const addB = h('button', { class: 'btn primary small add-btn', type: 'button', dataset: { t: 'add-html' }, onclick: pickFiles }, icon('plus'), '追加');
  const settingsB = h('button', { class: 'btn icon plain set-btn', type: 'button', 'aria-label': '設定', dataset: { t: 'open-settings' }, onclick: () => go('#/settings') }, icon('settings'));
  const moreB = h('button', { class: 'btn icon plain top-more', type: 'button', 'aria-label': 'メニュー', dataset: { t: 'top-more' }, onclick: e => openMenu(e.currentTarget, [
    { label: 'HTML を追加（ファイルを選ぶ）', id: 'tm-add', onClick: pickFiles },
    { label: ui.selecting ? '選択を終える' : '選択する', id: 'tm-select', onClick: () => toggleSelecting() },
    { label: '設定', id: 'tm-settings', onClick: () => go('#/settings') }]) }, icon('more'));
  const topEl = h('header', { class: 'lib-top' }, h('h1', { class: 'app-name', text: L.STRINGS.appName }), h('div', { class: 'search-wrap' }, icon('search'), search), pill.el, addB, settingsB, moreB);
  const kindsEl = h('nav', { class: 'kinds', 'aria-label': '種類', dataset: { t: 'kinds' } });
  const toolsEl = h('div', { class: 'lib-tools' });
  const tagbarEl = h('div', { class: 'tagbar', role: 'group', 'aria-label': 'タグで絞り込み', dataset: { t: 'tagbar' } });
  const bannerEl = h('div', { class: 'banner', hidden: true, dataset: { t: 'banner' } });
  const gridEl = h('div', { class: 'grid', dataset: { t: 'grid' } });
  const selBar = h('div', { class: 'selbar', hidden: true, dataset: { t: 'selbar' } });
  const fileInput = h('input', { type: 'file', accept: '.html,.htm,text/html', multiple: true, hidden: true, dataset: { t: 'file-input' } });
  fileInput.addEventListener('change', () => { const f = [...fileInput.files]; fileInput.value = ''; if (f.length) onFiles(f); });
  const fab = h('button', { class: 'fab', type: 'button', 'aria-label': 'HTML を追加', dataset: { t: 'add-fab' }, onclick: pickFiles }, icon('plus'), h('span', { text: '追加' }));
  const dropHint = h('div', { class: 'drop-hint', 'aria-hidden': 'true' }, h('div', null, icon('upload'), h('span', { text: 'ここに HTML を落とすと追加します' })));
  const mainEl = h('main', { class: 'lib-main' }, toolsEl, tagbarEl, bannerEl, gridEl);
  const root = h('div', { class: 'library' }, topEl, h('div', { class: 'lib-body' }, kindsEl, mainEl), selBar, fab, fileInput, dropHint);
  host.append(root);

  // ---------- ドラッグ＆ドロップで追加 ----------
  let dragDepth = 0;
  const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
  root.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; root.classList.add('dropping'); });
  root.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  root.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) root.classList.remove('dropping'); });
  root.addEventListener('drop', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; root.classList.remove('dropping'); const f = [...e.dataTransfer.files]; if (f.length) onFiles(f); });

  // ---------- 種類（すべて｜ゲーム｜指南書｜ドリル｜ツール｜その他＋件数。0 件も薄く出す）----------
  function renderKinds() {
    const counts = L.kindCounts(engine.library.items);
    clear(kindsEl);
    const item = (key, label, n, color) => h('button', { class: 'kind' + (ui.kind === key ? ' on' : '') + (n ? '' : ' zero'), type: 'button', dataset: { t: 'kind', k: key }, 'aria-pressed': String(ui.kind === key),
      onclick: () => { ui.kind = key; persist(); renderKinds(); renderGrid(); } },
      color ? h('span', { class: 'kind-dot', style: { background: color } }) : null, h('span', { class: 'k-name', text: label }), h('span', { class: 'f-n', text: String(n) }));
    kindsEl.append(item('all', 'すべて', counts.all, null), ...L.KINDS.map(k => item(k.key, k.label, counts[k.key], k.color)));
  }

  // ---------- タグの絞り込み帯：押すとそのタグの作品だけ。複数押すと、全部に当てはまるものだけ ----------
  function renderTagBar() {
    const tags = L.tagList(engine.library.items), keys = new Set(tags.map(t => L.tagKey(t.name)));
    const kept = ui.tags.filter(t => keys.has(L.tagKey(t)));
    if (kept.length !== ui.tags.length) { ui.tags = kept; persist(); }                          // 消えたタグで絞り込んだままにしない
    T.fillTagBar(tagbarEl, { tags, selected: ui.tags,
      onToggle: name => { ui.tags = ui.tags.some(t => L.tagKey(t) === L.tagKey(name)) ? ui.tags.filter(t => L.tagKey(t) !== L.tagKey(name)) : [...ui.tags, name]; persist(); renderTagBar(); renderGrid(); },
      onClear: () => { ui.tags = []; persist(); renderTagBar(); renderGrid(); },
      onManage: () => T.openTagManager({ engine }) });
  }

  // ---------- 道具（並べ替え・選択） ----------
  function toggleSelecting() { ui.selecting = !ui.selecting; ui.selected.clear(); renderSelBar(); renderTools(); renderGrid(); }
  function renderTools() {
    clear(toolsEl);
    const sort = h('select', { class: 'input sort', 'aria-label': '並べ替え', dataset: { t: 'sort' } }, L.SORTS.map(([v, l]) => h('option', { value: v, text: '並べ替え：' + l })));
    sort.value = ui.sort;
    sort.addEventListener('change', () => { ui.sort = sort.value; persist(); renderGrid(); });
    const selB = h('button', { class: 'btn small' + (ui.selecting ? ' primary' : ''), type: 'button', dataset: { t: 'select-toggle' }, 'aria-pressed': String(ui.selecting), onclick: toggleSelecting },
      icon('check'), ui.selecting ? '選択を終える' : '選択');
    toolsEl.append(h('span', { class: 'sp' }), sort, selB);
  }

  // ---------- カード ----------
  const savedOf = p => { const lv = L.latestVersion(p); return !!lv && (engine.uploadKeys.has(L.jobKey(p.id, lv.v)) || cached.has(engine.shaOf(p, lv.v))); };
  function makeCard(p) {
    const k = L.kindInfo(p.kind), lv = L.latestVersion(p), nv = (p.versions || []).length;
    const img = h('img', { class: 'thumb-img', alt: '', decoding: 'async', draggable: 'false' });
    img.hidden = true;
    const ph = h('div', { class: 'thumb-ph', style: { background: k.color } }, h('span', { text: Array.from(String(p.title || '?').trim())[0] || '?' }));     // サムネが無い時：種類の色の面＋題名の頭文字
    engine.thumbUrl(p).then(u => { if (u && !destroyed) { img.src = u; img.hidden = false; ph.hidden = true; } }).catch(() => {});
    const pending = engine.hasPendingUpload(p.id);
    const tags = p.tags || [];
    const main = h('button', { class: 'card-main', type: 'button', dataset: { t: 'card', id: p.id }, 'aria-label': p.title, title: p.description || '',
      onclick: () => { if (ui.selecting) toggleSel(p.id); else go('#/item/' + encodeURIComponent(p.id)); } },
      h('div', { class: 'thumb' }, ph, img),
      h('div', { class: 'info' },
        h('div', { class: 'c-title', text: p.title || '(題名なし)' }),
        h('div', { class: 'c-row' },
          h('span', { class: 'badge kind-badge', style: { background: k.color }, dataset: { t: 'kind-badge' }, text: k.label }),
          nv > 1 && lv ? h('span', { class: 'badge ver', dataset: { t: 'ver-badge' }, title: `版が ${nv} つあります（最新 v${lv.v}）`, text: `v${lv.v}` }) : null,
          pending ? h('span', { class: 'badge pend', text: '未送信' }) : null,
          h('span', { class: 'badge saved', hidden: !savedOf(p), dataset: { saved: p.id }, title: '端末に保存済み（電波が無くても開けます）', text: '✓ 端末' })),
        tags.length ? h('div', { class: 'c-tags' }, tags.slice(0, TAGS_ON_CARD).map(t => h('span', { class: 'tag', text: t })), tags.length > TAGS_ON_CARD ? h('span', { class: 'tag more', text: `+${tags.length - TAGS_ON_CARD}` }) : null) : null,
        h('div', { class: 'c-meta', dataset: { t: 'card-meta' }, text: [lv ? L.formatBytes(lv.size) : '', fmtDate(L.updatedOf(p))].filter(Boolean).join('・') })));
    const menuB = h('button', { class: 'card-menu', type: 'button', 'aria-label': 'メニュー', dataset: { t: 'card-menu', id: p.id }, onclick: e => { e.stopPropagation(); cardMenu(e.currentTarget, p); } }, icon('more'));
    const check = h('span', { class: 'card-check', 'aria-hidden': 'true' }, icon('check'));
    return h('article', { class: 'card' + (ui.selected.has(p.id) ? ' sel' : ''), dataset: { id: p.id } }, main, menuB, check);      // 選択中の見た目（✓ の丸・⋯ を隠す）は .library.selecting で切り替える＝カードを作り直さずにすぐ変わる
  }
  async function renderGrid() {
    if (destroyed) return;
    const lib = engine.library;
    try { cached = await engine.cachedShaSet(); } catch (e) { cached = new Set(); }
    if (destroyed) return;
    const list = L.sortItems(L.filterItems(lib.items, filterOpts()), ui.sort);
    // 見える内容が前回と同じなら描き直さない（描き直すと、押そうとしたカードが指の下で入れ替わりうる）
    const sig = JSON.stringify([engine.configured, !!engine.base, engine.err ? engine.err.message : null, ui.selecting, [...ui.selected].sort(), lib.items.length,
      list.map(p => [p, savedOf(p), engine.hasPendingUpload(p.id)])]);
    if (sig === gridSig && gridEl.childElementCount) { renderSelBar(); return; }
    gridSig = sig;
    if (list.length) {
      // カードは id ごとに作り置きし、中身が変わったカードだけ作り直す。並びが同じなら DOM に触らない
      // （同期の知らせのたびに全部を作り直すと、押している最中のカードやボタンが入れ替わってタップが消え、一覧も上端へ戻ってしまう）
      const els = list.map(p => {
        const s = JSON.stringify([p, savedOf(p), engine.hasPendingUpload(p.id), ui.selected.has(p.id)]), cur = cardEls.get(p.id);
        if (cur && cur.sig === s) return cur.el;
        const el = makeCard(p); cardEls.set(p.id, { sig: s, el }); return el;
      });
      const keep = new Set(els);
      for (const ch of [...gridEl.children]) if (!keep.has(ch)) ch.remove();
      els.forEach((el, i) => { if (gridEl.children[i] !== el) gridEl.insertBefore(el, gridEl.children[i] || null); });
      for (const id of [...cardEls.keys()]) if (!list.some(p => p.id === id)) cardEls.delete(id);
      renderSelBar();
      return;
    }
    clear(gridEl); cardEls.clear();
    if (engine.configured && !engine.base && engine.err) {            // 倉庫を一度も読めていない：理由と「もう一度」を出す
      gridEl.append(h('div', { class: 'empty-state', dataset: { t: 'empty' } },
        h('p', { class: 'big', text: '倉庫に接続できませんでした' }),
        h('p', { dataset: { t: 'empty-reason' }, text: engine.err.message }),
        h('div', { class: 'row', style: { justifyContent: 'center' } },
          h('button', { class: 'btn primary', type: 'button', dataset: { t: 'retry-load' }, onclick: () => { engine.err = null; engine.setStatus(); engine.refresh(); renderGrid(); } }, 'もう一度'),
          h('button', { class: 'btn', type: 'button', onclick: () => go('#/settings') }, '設定を開く'))));
    } else {
      const loading = engine.configured && !engine.base && !engine.err;
      gridEl.append(h('div', { class: 'empty-state', dataset: { t: 'empty' } },
        h('p', { class: 'big', text: loading ? '倉庫を読み込み中…' : lib.items.length ? '条件に合う作品がありません' : 'まだ何もありません。「追加」から HTML を選ぶか、ここへ落としてください。' })));
    }
    renderSelBar();
  }
  function toggleSel(id) {
    if (ui.selected.has(id)) ui.selected.delete(id); else ui.selected.add(id);
    const el = gridEl.querySelector(`.card[data-id="${CSS.escape(id)}"]`); if (el) el.classList.toggle('sel', ui.selected.has(id));
    renderSelBar();
  }

  // ---------- 選択バー（一度だけ作り、件数とボタンの押せる／押せないだけを書き換える）----------
  const selDone = () => { ui.selected.clear(); ui.selecting = false; renderSelBar(); renderTools(); renderGrid(); };
  const selN = h('span', { class: 'sel-n', dataset: { t: 'sel-count' } });
  const selAll = h('button', { class: 'btn small', type: 'button', dataset: { t: 'sel-all' }, onclick: () => { for (const p of L.filterItems(engine.library.items, filterOpts())) ui.selected.add(p.id); renderGrid(); } }, '全部');
  const selTags = h('button', { class: 'btn small', type: 'button', dataset: { t: 'sel-tags' }, onclick: () => T.openBulkTagDialog({ engine, ids: [...ui.selected] }) }, icon('tag'), 'タグ');
  const selKind = h('button', { class: 'btn small', type: 'button', dataset: { t: 'sel-kind' }, onclick: async () => {
    const ids = [...ui.selected], n = ids.length;
    const k = await pickKind({ title: `${n} 件の種類を変える` });
    if (k === undefined) return;
    for (const id of ids) engine.setField(id, 'kind', k);
    toast(`${n} 件を「${L.kindInfo(k).label}」にしました`); selDone();
  } }, '種類');
  const selDel = h('button', { class: 'btn small danger', type: 'button', dataset: { t: 'sel-delete' }, onclick: async () => {
    const ids = [...ui.selected], n = ids.length;
    const ok = await confirmDialog(`選んだ ${n} 件を倉庫から削除します。すべての版の HTML とサムネイルが消えます。この操作は元に戻せません。`, { okLabel: `${n} 件を削除`, danger: true, title: '倉庫から削除' });
    if (!ok) return;
    for (const id of ids) await engine.removeItem(id);
    toast(`${n} 件の削除を予約しました（次の送信で倉庫から消えます）`); selDone();
  } }, icon('trash'), '削除');
  selBar.append(selN, selAll, h('span', { class: 'sp' }), selTags, selKind, selDel);
  function renderSelBar() {
    selBar.hidden = !ui.selecting;
    root.classList.toggle('selecting', ui.selecting);
    if (!ui.selecting) return;
    const n = ui.selected.size;
    selN.textContent = `${n} 件選択`;
    for (const b of [selTags, selKind, selDel]) b.disabled = !n;
  }

  // ---------- カードのメニュー ----------
  const pickKind = ({ title, current, sub }) => pickDialog({ title, sub, current, options: L.KINDS.map(k => ({ value: k.key, label: k.label, color: k.color })) });
  function pickVersion(p) {
    const lv = L.latestVersion(p);
    return pickDialog({ title: '版を選んで開く', sub: p.title, current: null,
      options: [...p.versions].reverse().map(v => ({ value: v.v, label: `v${v.v}${lv && v.v === lv.v ? '（最新）' : ''}`, note: [L.formatBytes(v.size), fmtDate(v.addedAt)].filter(Boolean).join('・') })) });
  }
  function cardMenu(anchor, p) {
    const lv = L.latestVersion(p), isSaved = savedOf(p);
    openMenu(anchor, [
      { heading: p.title, id: 'm-heading' },
      { label: '題名を編集…', id: 'm-title', onClick: async () => { const t = await promptDialog({ title: '題名を編集', label: '題名', value: p.title || '' }); if (t && t !== p.title) engine.setField(p.id, 'title', t); } },
      { label: '種類を変える…', id: 'm-kind', onClick: async () => { const k = await pickKind({ title: '種類を変える', sub: p.title, current: L.normalizeKind(p.kind) }); if (k !== undefined && k !== p.kind) engine.setField(p.id, 'kind', k); } },
      { label: 'タグを編集…', id: 'm-tags', onClick: () => T.openTagDialog({ engine, itemId: p.id }) },
      { label: '説明を編集…', id: 'm-desc', onClick: async () => { const d = await promptDialog({ title: '説明を編集', label: '説明（カードに触れると出ます）', value: p.description || '', multiline: true }); if (d !== null && d !== (p.description || '')) engine.setField(p.id, 'description', d); } },
      (p.versions || []).length >= 2 ? { label: `版を選んで開く…（${p.versions.length} つ）`, id: 'm-versions', onClick: async () => { const v = await pickVersion(p); if (v !== undefined) go(`#/item/${encodeURIComponent(p.id)}?v=${v}`); } } : null,
      { sep: true },
      isSaved
        ? { label: '端末から外す', id: 'm-unsave', onClick: async () => { for (const v of p.versions || []) await engine.removeFromDevice(p, v.v); toast('この端末の保存を外しました（倉庫には残っています）'); renderGrid(); } }
        : { label: lv ? `端末に保存（今の最新版 v${lv.v}）` : '端末に保存', id: 'm-save', disabled: !lv, onClick: async () => {
          try { await engine.saveToDevice(p, lv.v); toast(`v${lv.v} を端末に保存しました（電波が無くても開けます）`); renderGrid(); }
          catch (e) { toast('端末に保存できませんでした：' + (e && e.message ? e.message : e), { kind: 'error', ms: 7000 }); }
        } },
      { sep: true },
      { label: '削除…', id: 'm-delete', danger: true, onClick: async () => {
        const ok = await confirmDialog(`「${p.title}」を倉庫から削除します。すべての版（${(p.versions || []).length} つ）の HTML とサムネイルが消えます。この操作は元に戻せません。`, { okLabel: '倉庫から削除', danger: true, title: '倉庫から削除' });
        if (ok) { await engine.removeItem(p.id); toast('削除を予約しました（次の送信で倉庫から消えます）'); }
      } },
    ]);
  }

  // ---------- 通知（アップロード中などの帯）----------
  function renderBanner() {
    const s = engine.status;
    const txt = s.kind === 'sending' && s.progress ? s.progress.text : null;
    bannerEl.hidden = !txt; bannerEl.textContent = txt || '';
  }

  // ---------- イベント ----------
  const rerender = debounce(() => { renderKinds(); renderTagBar(); renderGrid(); }, 60);
  const onLib = () => rerender();
  const onStatus = () => { renderBanner(); if (!engine.base) rerender(); };      // 倉庫をまだ読めていない間は、状態の変化（読み込み中→エラー）に合わせて描き直す
  const onCache = () => { rerender(); };
  engine.addEventListener('library', onLib); engine.addEventListener('status', onStatus); engine.addEventListener('cache', onCache);
  renderKinds(); renderTools(); renderTagBar(); renderGrid(); renderBanner();
  return {
    destroy() { destroyed = true; engine.removeEventListener('library', onLib); engine.removeEventListener('status', onStatus); engine.removeEventListener('cache', onCache); rerender.cancel(); root.remove(); },
  };
}
