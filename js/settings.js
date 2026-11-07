// settings.js : 設定（接続・トークン案内・端末に保存した HTML）と、初回の歓迎画面。仕様 §4.4。
// 論文リーダー site_v3 の settings.js を写して、倉庫の既定を html-library-data にし、「表示」の節を外し、端末に保存した HTML の合計＋「すべて消す」を足した。
import * as S from './store.js';
import { h, icon, toast, confirmDialog } from './ui.js';
import { saveSettings, forgetSettings, setToken, getToken, DEFAULT_SETTINGS, loadSettings } from './sync.js';
import { testConnection, GitHubError } from './github.js';
import { formatBytes, STRINGS } from './logic.js';
import { installSection, installChip } from './install.js';

const TOKEN_NEW_URL = 'https://github.com/settings/personal-access-tokens/new';
/** 新規作成ページの事前入力（公式ドキュメントに載っている引数だけ：name・description・expires_in・<permission>）。倉庫の選択は事前入力できないので手順に書く */
export function tokenUrl(device, repoName = DEFAULT_SETTINGS.repo) {
  const q = new URLSearchParams({ name: `${STRINGS.appName}（${device || 'この端末'}）`.slice(0, 40), description: `${STRINGS.appName}用。${repoName} だけに使います。`, expires_in: '365', contents: 'write' });
  return `${TOKEN_NEW_URL}?${q.toString()}`;
}

function guide(device, repoName) {
  const a = h('a', { class: 'btn primary link-btn', href: tokenUrl(device, repoName), target: '_blank', rel: 'noopener noreferrer', dataset: { t: 'token-link' } }, icon('upload'), 'トークンの作成ページを開く（GitHub）');
  return h('details', { class: 'guide', open: true, dataset: { t: 'token-guide' } },
    h('summary', { text: 'トークン（合い言葉）の作り方' }),
    h('p', { class: 'hint', text: 'この端末から倉庫に読み書きするための、倉庫専用の「合い言葉」です。端末ごとに1本ずつ作ります（スマホとPCで別々）。' }),
    h('ol', null,
      h('li', null, 'GitHub にログインした状態で、下のボタンから作成ページを開く（Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token と同じ画面です）。名前と期限（1年）は入力済みです。'),
      h('li', null, h('b', { text: 'Repository access' }), ' で ', h('b', { text: 'Only select repositories' }), ' を選び、', h('b', { text: repoName }), ' だけを選ぶ。'),
      h('li', null, h('b', { text: 'Permissions → Repository permissions → Contents' }), ' を ', h('b', { text: 'Read and write' }), ' にする（Metadata: Read は自動で付きます。ほかは触らない）。'),
      h('li', null, h('b', { text: 'Generate token' }), ' を押し、表示された ', h('code', { text: 'github_pat_…' }), ' をコピーして、下の「トークン」欄に貼り付ける。'),
      h('li', null, '「接続テスト」で「書き込みできます」と出れば完了。')),
    a,
    h('p', { class: 'hint', text: 'トークンはこの端末のブラウザの中だけに保存され、ほかには送られません（送り先は GitHub の API だけ）。開いた HTML（ゲーム・指南書）の中からは読めない作りです。画面を人に見せる時は欄を隠してください。' }));
}

export function renderWelcome({ host, go }) {
  const chip = installChip(STRINGS.appName);
  const root = h('div', { class: 'welcome', dataset: { t: 'welcome' } },
    h('div', { class: 'wl-card' },
      h('div', { class: 'wl-logo' }, icon('pages')),
      h('h1', { text: STRINGS.appName }),
      h('p', { class: 'lead', text: STRINGS.lead }),
      h('ul', { class: 'points' },
        h('li', null, h('b', { text: '開く：' }), 'カードを押すと、この画面の中で全画面に開きます（上に細い「戻る」の帯）。'),
        h('li', null, h('b', { text: '分ける：' }), '種類（ゲーム・指南書・ドリル…）と、自由に付けるタグで探せます。古い版もカードから開けます。'),
        h('li', null, h('b', { text: '持ち歩く：' }), '一度開いた物・「端末に保存」した物は、電波が無くても開けます。ゲームの進捗は保存しません。'),
        h('li', null, h('b', { text: '残る：' }), '自分だけの非公開の倉庫（GitHub）に保存。PC とスマホで同じものが見えます。')),
      h('p', { class: 'hint', text: 'はじめに、この端末用のトークン（倉庫専用の合い言葉）を設定します。5 分ほどです。' }),
      h('button', { class: 'btn primary big', type: 'button', dataset: { t: 'welcome-start' }, onclick: () => go('#/settings') }, 'はじめる（トークンを設定）'),
      chip.el));
  host.append(root);
  return { destroy() { chip.destroy(); root.remove(); } };
}

export function renderSettings({ engine, host, go, firstRun }) {
  const cur = loadSettings();
  const txt = (key, extra = {}) => h('input', { class: 'input', type: 'text', value: cur[key], autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', ...extra });
  const fields = {
    owner: txt('owner', { dataset: { t: 'set-owner' } }),
    repo: txt('repo', { dataset: { t: 'set-repo' } }),
    branch: txt('branch', { dataset: { t: 'set-branch' } }),
    device: h('input', { class: 'input', type: 'text', value: cur.device, placeholder: '例：Pixel／自宅PC', autocomplete: 'off', dataset: { t: 'set-device' } }),
    token: h('input', { class: 'input', type: 'password', value: getToken(), autocomplete: 'off', autocapitalize: 'none', spellcheck: 'false', placeholder: 'github_pat_…', dataset: { t: 'set-token' } }),
    apiUrl: txt('apiUrl', { dataset: { t: 'set-api' } }),
  };
  const field = (label, el, note) => h('label', { class: 'field' }, h('span', { class: 'lbl', text: label }), el, note ? h('span', { class: 'note', text: note }) : null);
  const showTok = h('button', { class: 'btn small', type: 'button', dataset: { t: 'token-show' }, onclick: () => { const on = fields.token.type === 'password'; fields.token.type = on ? 'text' : 'password'; showTok.textContent = on ? '隠す' : '表示'; } }, '表示');
  const result = h('div', { class: 'test-result', role: 'status', dataset: { t: 'test-result' }, hidden: true });
  const current = () => ({ owner: fields.owner.value.trim(), repo: fields.repo.value.trim(), branch: fields.branch.value.trim() || 'main', device: fields.device.value.trim(),
    apiUrl: fields.apiUrl.value.trim().replace(/\/+$/, '') || DEFAULT_SETTINGS.apiUrl, token: fields.token.value.trim() });

  async function runTest() {
    const c = current();
    result.hidden = false; result.className = 'test-result'; result.textContent = '確かめています…';
    if (!c.token) { result.className = 'test-result bad'; result.textContent = 'トークンが空です。'; return false; }
    try {
      const r = await testConnection(c);
      if (!r.push) { result.className = 'test-result warn'; result.textContent = `${r.fullName} に接続できましたが、読み取りだけです。トークンの Permissions → Contents を「Read and write」にして作り直してください。`; return false; }
      if (!r.branchOk) { result.className = 'test-result warn'; result.textContent = `${r.fullName} に接続できましたが、ブランチ「${c.branch}」が見つかりません。`; return false; }
      result.className = 'test-result ok'; result.textContent = `接続できました。${r.fullName}（${r.private ? '非公開' : '公開'}）に書き込みできます。`;
      return true;
    } catch (e) {
      result.className = 'test-result bad';
      result.textContent = e instanceof GitHubError ? e.message : '接続テストに失敗しました：' + (e && e.message ? e.message : e);
      return false;
    }
  }
  async function save() {
    const c = current();
    const prevKey = engine.repoKey();
    const next = { ...cur, owner: c.owner, repo: c.repo, branch: c.branch, device: c.device, apiUrl: c.apiUrl };
    const nextKey = `${next.apiUrl}|${next.owner}/${next.repo}@${next.branch}`;
    if (!c.token) { toast('トークンを入れてください', { kind: 'warn' }); return; }
    if (engine.configured && nextKey !== prevKey && engine.pendingCount()) {
      const ok = await confirmDialog(`接続先を変えると、この端末の未送信の変更 ${engine.pendingCount()} 件は破棄されます。続けますか？`, { okLabel: '破棄して切り替える', danger: true });
      if (!ok) return;
    }
    saveSettings(next); setToken(c.token);
    await engine.reconfigure();
    toast('設定を保存しました');
    go('#/', { replace: true });
  }

  // 端末に保存した HTML（仕様 §4.4：合計サイズ＋すべて消す）
  const cacheInfo = h('div', { class: 'cache-info', dataset: { t: 'cache-info' }, text: '計算中…' });
  async function refreshCache() {
    try {
      const s = await S.blobStore.summary(), est = await S.storageEstimate();
      cacheInfo.textContent = `端末に保存した HTML：${s.html.n} 件・${formatBytes(s.html.size)}（サムネイル ${s.thumb.n} 件・${formatBytes(s.thumb.size)}）`
        + (est ? `。この端末の使用量 ${formatBytes(est.usage)} ／ 上限の目安 ${formatBytes(est.quota)}` : '');
    } catch (e) { cacheInfo.textContent = '調べられませんでした'; }
  }
  refreshCache();

  const inst = installSection(STRINGS.appName);
  const root = h('div', { class: 'settings', dataset: { t: 'settings' } },
    h('header', { class: 'set-top' },
      h('button', { class: 'btn icon plain', type: 'button', 'aria-label': '戻る', dataset: { t: 'settings-back' }, onclick: () => (engine.configured ? go('#/', { replace: true }) : go('#/welcome', { replace: true })) }, icon('back')),
      h('h1', { text: '設定' })),
    h('div', { class: 'set-body' },
      firstRun ? h('p', { class: 'hint', text: 'はじめに、この端末用のトークンを設定してください。' }) : null,
      inst.el,
      guide(fields.device.value, cur.repo || DEFAULT_SETTINGS.repo),
      h('section', { class: 'set-sec' }, h('h2', { text: '接続' }),
        field('持ち主', fields.owner), field('倉庫', fields.repo), field('ブランチ', fields.branch),
        field('この端末の名前', fields.device, '保存の記録（コミットの説明）に付きます。'),
        h('label', { class: 'field' }, h('span', { class: 'lbl', text: 'トークン' }), h('div', { class: 'with-btn' }, fields.token, showTok)),
        h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', dataset: { t: 'test-conn' }, onclick: runTest }, '接続テスト'), h('button', { class: 'btn primary', type: 'button', dataset: { t: 'save-settings' }, onclick: save }, '保存して使いはじめる')),
        result),
      h('section', { class: 'set-sec' }, h('h2', { text: 'この端末に保存した HTML' }), cacheInfo,
        h('p', { class: 'hint', text: '開いた版と「端末に保存」した版はこの端末に保存され、電波が無くても開けます。消しても倉庫には残ります（次に開く時にまた取りに行きます）。未送信の変更は消えません。' }),
        h('button', { class: 'btn danger small', type: 'button', dataset: { t: 'clear-cache' }, onclick: async () => {
          if (await confirmDialog('この端末に保存した HTML とサムネイルをすべて消します。倉庫のデータと未送信の変更は消えません。', { okLabel: 'すべて消す', danger: true })) { await engine.clearCaches(); toast('消しました'); refreshCache(); }
        } }, icon('trash'), 'すべて消す')),
      h('section', { class: 'set-sec' }, h('h2', { text: '詳細' }), field('API の URL', fields.apiUrl, '通常は変えません（試験用にモックへ向ける時だけ）。'),
        h('button', { class: 'btn danger small', type: 'button', dataset: { t: 'forget' }, onclick: async () => {
          const msg = engine.pendingCount() ? `この端末の接続情報（トークン・設定）を消します。未送信の変更 ${engine.pendingCount()} 件は端末に残りますが、再接続するまで送れません。` : 'この端末の接続情報（トークン・設定）を消します。倉庫のデータは消えません。';
          if (await confirmDialog(msg, { okLabel: '接続情報を消す', danger: true })) {
            setToken(''); forgetSettings(); localStorage.removeItem('hl.ui');
            await engine.reconfigure(); toast('接続情報を消しました'); go('#/welcome', { replace: true });
          }
        } }, icon('trash'), 'この端末から接続情報を消す'),
        h('p', { class: 'hint', text: `${STRINGS.appName} v3` }))));
  host.append(root);
  return { destroy() { inst.destroy(); root.remove(); } };
}
