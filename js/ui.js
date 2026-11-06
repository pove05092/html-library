// ui.js : DOM 組み立て・ダイアログ・メニュー・トースト。本人の入力は必ず textContent 経由（HTML を通さない）。
// 論文リーダー site_v3 の ui.js の写し。要約用の簡易 Markdown・マーカーの色は外し、狭い画面ではメニューを「下から出る板」にした（仕様 §4.6）。
import { randomString } from './logic.js';
export const randomId = (n = 5) => randomString(n);

/** h('div', {class:'a', onclick:fn, dataset:{t:'x'}}, '文字', node, [..]) */
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}
export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
export const clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export function debounce(fn, ms) {
  let t = null;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => { t = null; fn(...a); }, ms); };
  d.flush = (...a) => { if (t) { clearTimeout(t); t = null; fn(...a); } };
  d.cancel = () => { clearTimeout(t); t = null; };
  return d;
}
/** 狭い画面（スマホの縦）か。メニュー・ヘッダの出し方を変える境目（css の @media (max-width: 599px) と同じ） */
export const isNarrow = () => window.matchMedia('(max-width: 599px)').matches;

// ---------- アイコン（自作の簡単な図柄・静的文字列のみ） ----------
const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>', settings: '<path d="M4 7h8M18 7h2M4 12h2M12 12h8M4 17h9M19 17h1"/><circle cx="15" cy="7" r="2.2"/><circle cx="9" cy="12" r="2.2"/><circle cx="16" cy="17" r="2.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>', more: '<circle cx="5" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="19" cy="12" r="1.4"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', check: '<path d="M5 12l5 5 9-10"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>',
  cloud: '<path d="M7 18a4 4 0 010-8 5 5 0 019.6-1A4.5 4.5 0 0117 18z"/>', folder: '<path d="M3 7h6l2 2h10v10H3z"/>', upload: '<path d="M12 16V4M7 9l5-5 5 5M5 20h14"/>',
  download: '<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>', trash: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13"/>',
  pages: '<path d="M8 3h9l3 3v12H8z"/><path d="M5 6v15h11"/><path d="M11 9h6M11 12h6M11 15h4"/>',
  fullscreen: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>', reload: '<path d="M20 11a8 8 0 10-2.3 5.7"/><path d="M20 4v7h-7"/>',
  tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="8.5" r="1.5"/>', edit: '<path d="M4 20l1-4L17 4l3 3L8 19l-4 1z"/><path d="M14 7l3 3"/>',
  game: '<rect x="3" y="7" width="18" height="11" rx="4"/><path d="M8 11v4M6 13h4"/><circle cx="15.5" cy="12" r="1"/><circle cx="17.5" cy="14.5" r="1"/>',
};
export function icon(name, cls = '') {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', 'ic ' + cls); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name] || '';   // 静的な自作文字列だけ（利用者の入力は通さない）
  return s;
}

// ---------- トースト ----------
export function toast(msg, { kind = 'info', ms = 3200 } = {}) {
  const layer = document.getElementById('layer');
  let box = layer.querySelector('.toasts');
  if (!box) { box = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); layer.append(box); }
  const t = h('div', { class: 'toast ' + kind, text: msg });
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
  return t;
}

// ---------- ダイアログ ----------
/** body は Node。actions: [{label, primary, danger, onClick(close)->void|false}] */
export function openDialog({ title, body, actions = [], wide = false, onClose, sheet = false }) {
  const layer = document.getElementById('layer');
  const back = h('div', { class: 'backdrop' });
  const titleEl = h('h2', { class: 'dlg-title', text: title || '' });
  const bodyEl = h('div', { class: 'dlg-body' }, body);
  const foot = h('div', { class: 'dlg-foot' });
  const dlg = h('div', { class: 'dialog' + (wide ? ' wide' : '') + (sheet ? ' sheet' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-label': title || '' }, title ? titleEl : null, bodyEl, actions.length ? foot : null);
  let closed = false;
  const close = (result) => {
    if (closed) return; closed = true;
    document.removeEventListener('keydown', onKey, true);
    back.remove(); dlg.remove();
    if (onClose) onClose(result);
  };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close('esc'); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('click', () => close('backdrop'));
  for (const a of actions) {
    const b = h('button', { class: 'btn' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : ''), type: 'button', dataset: { t: a.id || '' }, text: a.label });
    b.addEventListener('click', async () => { const r = a.onClick ? await a.onClick(close, b) : undefined; if (r !== false && !a.keepOpen) close(a.label); });
    foot.append(b);
  }
  layer.append(back, dlg);
  const first = dlg.querySelector('input:not([type=radio]), textarea, select, button.primary');
  if (first && !sheet && !isNarrow()) setTimeout(() => first.focus?.(), 30);     // スマホは開いた途端にキーボードが出ないようにする
  return { close, el: dlg, bodyEl, foot };
}
export function confirmDialog(message, { okLabel = 'OK', cancelLabel = 'キャンセル', danger = false, title = '確認' } = {}) {
  return new Promise(res => {
    let v = false;
    openDialog({ title, body: h('p', { class: 'dlg-msg', text: message }),
      actions: [{ label: cancelLabel, id: 'cancel' }, { label: okLabel, primary: !danger, danger, id: 'ok', onClick: () => { v = true; } }], onClose: () => res(v) });
  });
}
export function alertDialog(message, { title = 'お知らせ', okLabel = '閉じる' } = {}) {
  return new Promise(res => openDialog({ title, body: h('p', { class: 'dlg-msg', text: message }), actions: [{ label: okLabel, primary: true, id: 'ok' }], onClose: () => res() }));
}
/** 1 行の入力（multiline:true で複数行） */
export function promptDialog({ title, label, value = '', placeholder = '', okLabel = 'OK', multiline = false }) {
  return new Promise(res => {
    const input = multiline
      ? h('textarea', { class: 'input', rows: 4, placeholder, 'aria-label': label || title, dataset: { t: 'prompt-input' } })
      : h('input', { type: 'text', class: 'input', value, placeholder, 'aria-label': label || title, dataset: { t: 'prompt-input' } });
    if (multiline) input.value = value;
    let v = null;
    const d = openDialog({ title, body: h('label', { class: 'field' }, label ? h('span', { class: 'lbl', text: label }) : null, input),
      actions: [{ label: 'キャンセル', id: 'cancel' }, { label: okLabel, primary: true, id: 'ok', onClick: () => { v = input.value.trim(); } }], onClose: () => res(v) });
    if (!multiline) input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { v = input.value.trim(); d.close(); } });
  });
}
/** 選択肢から 1 つ選ぶ（種類の変更など）。返り値は選んだ value（取り消しは undefined） */
export function pickDialog({ title, options, current, sub }) {
  return new Promise(res => {
    let chosen;
    const list = h('div', { class: 'pick-list', role: 'listbox' }, options.map(o => h('button', { class: 'pick' + (o.value === current ? ' cur' : ''), type: 'button', role: 'option', 'aria-selected': String(o.value === current),
      dataset: { t: 'pick', v: String(o.value) }, onclick: () => { chosen = o.value; d.close(); } },
      o.color ? h('span', { class: 'kind-dot', style: { background: o.color } }) : null, h('span', { class: 'pick-label', text: o.label }), o.note ? h('span', { class: 'pick-note', text: o.note }) : null)));
    const d = openDialog({ title, body: h('div', null, sub ? h('p', { class: 'dlg-sub', text: sub }) : null, list), actions: [{ label: 'キャンセル', id: 'cancel' }], onClose: () => res(chosen) });
  });
}

// ---------- メニュー（⋯ ボタンの下に出す。狭い画面では下から出る板）----------
export function openMenu(anchor, items, { align = 'right' } = {}) {
  closeMenus();
  const layer = document.getElementById('layer');
  const sheet = isNarrow();
  const menu = h('div', { class: 'menu' + (sheet ? ' sheet' : ''), role: 'menu' });
  const back = h('div', { class: 'menu-back' + (sheet ? ' dim' : '') });
  const close = () => { back.remove(); menu.remove(); document.removeEventListener('keydown', onKey, true); };
  const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { menu.append(h('div', { class: 'menu-sep' })); continue; }
    if (it.heading) { menu.append(h('div', { class: 'menu-heading', dataset: { t: it.id || '' }, text: it.heading })); continue; }
    const b = h('button', { class: 'menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' checked' : ''), type: 'button', role: 'menuitem', disabled: it.disabled, dataset: { t: it.id || '' } },
      it.checked ? icon('check', 'mi-check') : h('span', { class: 'mi-gap' }), h('span', { class: 'mi-label', text: it.label }), it.note ? h('span', { class: 'mi-note', text: it.note }) : null);
    b.addEventListener('click', () => { close(); it.onClick?.(); });
    menu.append(b);
  }
  back.addEventListener('click', close);
  layer.append(back, menu);
  if (!sheet) {
    const r = anchor.getBoundingClientRect(), mw = menu.offsetWidth, mh = menu.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
    let left = align === 'right' ? r.right - mw : r.left;
    left = clamp(left, 8, Math.max(8, vw - mw - 8));
    let top = r.bottom + 4;
    if (top + mh > vh - 8) top = Math.max(8, r.top - mh - 4);
    menu.style.left = left + 'px'; menu.style.top = top + 'px';
    menu.querySelector('button:not([disabled])')?.focus?.();
  }
  return { close };
}
export function closeMenus() { document.querySelectorAll('#layer .menu, #layer .menu-back').forEach(n => n.remove()); }

// ---------- 小物 ----------
const p2 = n => String(n).padStart(2, '0');
export function fmtDateTime(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}
export function fmtDate(iso) {
  const d = new Date(iso); if (isNaN(d)) return '';
  return `${d.getFullYear()}/${p2(d.getMonth() + 1)}/${p2(d.getDate())}`;
}
export function fmtAgo(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 5) return 'たった今';
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.floor(s / 60)} 分前`;
  return `${Math.floor(s / 3600)} 時間前`;
}
