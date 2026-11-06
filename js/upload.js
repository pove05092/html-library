// upload.js : HTML の追加（画面から）。ファイルを検査 → 確認画面（種類・題名・同じ作品の新しい版にするか）→ 端末内に積んで送信。仕様 §4.2「追加」。
// 送信の仕組み（uploads に積む・再送・失敗の知らせ）は論文リーダー site_v3 の upload.js と同じ。HTML の中身は変えずにそのまま送る（バイト単位で同一）。
import * as L from './logic.js';
import { h, openDialog, toast } from './ui.js';

export const MAX_BYTES = 30 * 1024 * 1024;          // 仕様 §4.2：30 MB を超えるファイルは断る
export const WARN_BYTES = 10 * 1024 * 1024;         // 10 MB 超は「スマホ回線だと重い」と注意

/** files: File[]。断る物は理由つきのトーストで知らせ、残りを確認画面へ */
export async function startUpload({ engine, files }) {
  const ok = [], skipped = [];
  for (const f of files) {
    if (!/\.html?$/i.test(f.name)) { skipped.push(`${f.name}（.html のファイルではありません）`); continue; }
    if (f.size > MAX_BYTES) { skipped.push(`${f.name}（${L.formatBytes(f.size)}：30 MB を超えるため追加できません）`); continue; }
    if (f.size === 0) { skipped.push(`${f.name}（空のファイルです）`); continue; }
    let text;
    try { text = L.decodeHtml(new Uint8Array(await f.arrayBuffer())); }
    catch (e) { skipped.push(`${f.name}（読めませんでした）`); continue; }
    if (!L.looksLikeHtml(text)) { skipped.push(`${f.name}（HTML ではないようです：<html>・<body>・<div> などのタグが 1 つもありません）`); continue; }
    ok.push({ file: f, text });
  }
  if (skipped.length) toast('追加できなかったファイル：' + skipped.join(' / '), { kind: 'warn', ms: 9000 });
  if (!ok.length) return null;

  // 同じ作品の判定：既存の item（題名の一致・版のファイル名の基の一致）→ 無ければ、同じ回に選んだ先のファイル
  const items = engine.library.items;
  const cands = [];
  for (const { file, text } of ok) {
    const parsed = L.parseVersionFromName(file.name);
    const title = L.extractHtmlTitle(text) || parsed.base;
    const match = L.findSameItem(items, { title, filename: file.name });
    let sibling = null;
    if (!match) sibling = cands.find(c => !c.match && !c.sibling && (L.normalizeTitle(c.title) === L.normalizeTitle(title) || L.normalizeTitle(c.parsed.base) === L.normalizeTitle(parsed.base))) || null;
    cands.push({ file, parsed, title, htmlTitle: L.extractHtmlTitle(text), match, sibling, mode: match || sibling ? 'version' : 'new', kind: 'other' });
  }
  return confirmScreen(engine, cands);
}

function confirmScreen(engine, cands) {
  const blocks = cands.map((c, idx) => {
    const kind = h('select', { class: 'input', dataset: { t: 'up-kind' }, 'aria-label': '種類' }, L.KINDS.map(k => h('option', { value: k.key, text: k.label })));
    kind.value = c.kind;
    kind.addEventListener('change', () => { c.kind = kind.value; });
    const title = h('input', { class: 'input', type: 'text', value: c.title, dataset: { t: 'up-title' }, 'aria-label': '題名' });
    title.addEventListener('input', () => { c.title = title.value; });
    const own = h('div', { class: 'up-own' }, h('label', { class: 'field' }, h('span', { class: 'lbl', text: '種類' }), kind), h('label', { class: 'field' }, h('span', { class: 'lbl', text: '題名' }), title));
    let choice = null;
    const target = c.match ? c.match : c.sibling;
    if (target) {
      const tTitle = c.match ? c.match.title : `（この回に足す）${c.sibling.title}`;
      const vNote = c.parsed.v != null ? `v${c.parsed.v}` : '次の版番号';
      const exists = c.match && c.parsed.v != null && L.versionOf(c.match, c.parsed.v);
      const radio = (value, label, note) => {
        const r = h('input', { type: 'radio', name: 'up-mode-' + idx, value, checked: c.mode === value, dataset: { t: 'up-mode-' + value } });
        r.addEventListener('change', () => { if (r.checked) { c.mode = value; sync(); } });
        return h('label', { class: 'up-choice' }, r, h('span', null, h('span', { class: 'up-choice-l', text: label }), note ? h('span', { class: 'up-choice-n', text: note }) : null));
      };
      choice = h('div', { class: 'up-choices', role: 'radiogroup', 'aria-label': '足し方', dataset: { t: 'up-same' } },
        h('p', { class: 'up-same-msg', text: `同じ題名の作品「${tTitle}」があります。` }),
        radio('version', 'その作品の新しい版として足す', `${vNote}${exists ? '（同じ番号の版を置き換えます）' : ''}`),
        radio('new', '別の作品として足す', null));
    }
    const sync = () => { const off = c.mode === 'version'; own.classList.toggle('off', off); kind.disabled = off; title.disabled = off; };
    sync();
    const warn = c.file.size > WARN_BYTES ? h('p', { class: 'warn', text: `${L.formatBytes(c.file.size)} あります。スマホ回線だと送信に時間がかかります（Wi-Fi 推奨）。` }) : null;
    return h('section', { class: 'up-item', dataset: { n: idx } },
      h('div', { class: 'up-head' },
        h('div', { class: 'up-facts' },
          h('div', { class: 'up-file', text: c.file.name }),
          h('div', { class: 'up-sub', dataset: { t: 'up-facts' }, text: `${L.formatBytes(c.file.size)}${c.parsed.v != null ? `・ファイル名の版 v${c.parsed.v}` : ''}${c.htmlTitle ? `・<title>：${c.htmlTitle}` : ''}` }),
          warn)),
      choice, own);
  });
  const body = h('div', { class: 'up-confirm', dataset: { t: 'upload-confirm' } }, blocks);
  let sending = false;
  return openDialog({
    title: `${cands.length} 件を追加`, body, wide: true,
    actions: [
      { label: 'キャンセル', id: 'up-cancel' },
      { label: `追加する（${cands.length} 件）`, primary: true, id: 'up-ok', onClick: async (close, btn) => {
        if (sending) return false; sending = true; btn.disabled = true;
        try {
          const taken = new Set([...engine.library.items.map(p => p.id), ...[...engine.uploadKeys].map(k => k.replace(/@v\d+$/, ''))]);
          const usedKeys = new Set(engine.uploadKeys);
          let n = 0;
          for (const c of cands) {
            const now = L.nowIso(), source = 'upload:' + c.file.name;
            let id, v, mode = c.mode;
            if (mode === 'version' && c.sibling && c.sibling.mode !== 'new') mode = 'new';     // 相手（同じ回の先のファイル）が新しい作品にならなかった
            if (mode === 'version') {
              id = c.match ? c.match.id : c.sibling.assignedId;
              const cur = engine.item(id) || c.match;
              const batchMax = Math.max(0, ...cands.filter(x => x.assignedId === id && x.assignedV != null).map(x => x.assignedV));
              v = c.parsed.v ?? Math.max(L.nextVersionNumber(cur), batchMax + 1);
            } else {
              id = L.makeItemIdFromFilename(c.file.name, taken); taken.add(id);
              v = c.parsed.v ?? 1;
            }
            while (usedKeys.has(L.jobKey(id, v))) v++;                     // 同じ回で同じ版番号になったら次の番号へ
            usedKeys.add(L.jobKey(id, v));
            c.assignedId = id; c.assignedV = v;
            const ver = { v, file: L.versionFile(id, v), size: c.file.size, addedAt: now, source };
            const job = { key: L.jobKey(id, v), itemId: id, v, mode, createdAt: now, shas: {}, files: [{ path: ver.file, blob: c.file }] };
            if (mode === 'new') {
              job.entry = { id, title: (c.title || '').trim() || c.parsed.base, kind: L.normalizeKind(c.kind), description: '', tags: [], versions: [ver], thumb: null,
                addedAt: now, updatedAt: now, lastOpenedAt: null, source };
            } else job.version = ver;
            try { await engine.queueUpload(job); n++; }
            catch (err) { toast(`「${c.file.name}」を端末に保存できませんでした（空き容量を確かめてください）`, { kind: 'error', ms: 7000 }); }
          }
          if (n) { toast(`${n} 件を追加しました。まもなく倉庫へ送ります。`); engine.requestSoon(); }
        } finally { sending = false; }
      } },
    ],
  });
}
