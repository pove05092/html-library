// viewer.js : 殻の側のビューア（仕様 §4.3）。上に細いバー（← 戻る／題名／版の選択／全画面／⋯）＋その下いっぱいに「HTML の箱」（viewer.html）。
//  - 箱とのやりとりは frame.js と同じ取り決め：殻→箱 {hl:1,type:'load',html}／箱→殻 {hl:1,type:'ready'|'loaded'|'error', message, line}。
//  - 受け付けるのは event.source === 箱の contentWindow かつ event.origin === location.origin のものだけ。
//  - 中の HTML のエラーは数えるだけ（画面は邪魔しない。「⋯」の中に件数）。
//  - HTML は端末の保存（IndexedDB）→ 無ければ倉庫の API。倉庫から取った版は端末に保存される（sync.js の getHtml）。
// 論文リーダーの旧 viewer.js（PDF のリーダー）の名前を引き継いだ新しいファイル。
import * as L from './logic.js';
import { h, icon, clear, toast, openMenu, clamp } from './ui.js';

const LOADED_TIMEOUT_MS = 15000;     // 「loaded」が来なくても、この時間で「読み込んでいます…」を外す（中の外部ファイルが遅い時など。中身は動いていることが多い）

export class Viewer {
  /** opts: { engine, item, onBack(), onVersion(v) } */
  constructor(opts) {
    this.opts = opts; this.engine = opts.engine; this.item = opts.item;
    this.v = null; this.html = null; this.boxReady = false; this.loaded = false; this.errors = []; this.others = []; this.from = null;
    this.seq = 0; this.loadTimer = 0; this.fsMode = null; this.destroyed = false; this.listeners = [];
    this.build();
  }

  // ---------- DOM ----------
  build() {
    const p = this.item;
    this.backB = h('button', { class: 'btn plain vw-back', type: 'button', 'aria-label': 'ライブラリへ戻る', dataset: { t: 'back' }, onclick: () => this.opts.onBack() }, icon('back'), h('span', { class: 'vw-back-l', text: '戻る' }));
    this.titleEl = h('div', { class: 'vw-title', title: p.title, text: p.title });
    this.verSel = h('select', { class: 'input vw-ver', 'aria-label': '版', dataset: { t: 'ver-select' } });
    this.verSel.addEventListener('change', () => this.switchVersion(Number(this.verSel.value)));
    this.fsB = h('button', { class: 'btn icon plain', type: 'button', 'aria-label': '全画面', title: '全画面', dataset: { t: 'fullscreen' }, onclick: () => this.enterFullscreen() }, icon('fullscreen'));
    this.moreB = h('button', { class: 'btn icon plain', type: 'button', 'aria-label': 'メニュー', dataset: { t: 'viewer-more' }, onclick: e => this.openMore(e.currentTarget) }, icon('more'));
    this.topEl = h('header', { class: 'vw-top', dataset: { t: 'viewer-bar' } }, this.backB, this.titleEl, this.verSel, this.fsB, this.moreB);

    this.frame = h('iframe', { class: 'vw-frame', src: 'viewer.html', title: p.title || 'HTML', allow: 'fullscreen; autoplay; clipboard-write', dataset: { t: 'box' } });   // allowfullscreen は allow="fullscreen" と重なる（Chrome が警告を出す）ので付けない
    this.exitB = h('button', { class: 'vw-exit', type: 'button', 'aria-label': '全画面を終える', title: '全画面を終える（Esc）', dataset: { t: 'fs-exit' }, onclick: () => this.exitFullscreen() }, icon('close'));
    this.loadingEl = h('div', { class: 'vw-loading', dataset: { t: 'loading' } }, h('div', { class: 'spin' }), h('div', { class: 'msg', text: '' }), h('div', { class: 'bar' }, h('div', { class: 'fill' })));
    this.stage = h('div', { class: 'vw-stage' }, this.frame, this.exitB, this.loadingEl);
    this.root = h('div', { class: 'viewer', dataset: { t: 'viewer', kind: L.normalizeKind(p.kind) } }, this.topEl, this.stage);
    this.fillVersions();
  }
  mount(host) {
    clear(host); host.append(this.root);
    this.on(window, 'message', e => this.onMessage(e));
    this.on(document, 'fullscreenchange', () => { if (!document.fullscreenElement && this.fsMode === 'api') this.leaveFsState(); });
    this.on(document, 'keydown', e => { if (e.key === 'Escape' && this.fsMode === 'css') { e.preventDefault(); this.exitFullscreen(); } });
    this.onLib = () => this.onLibrary();
    this.engine.addEventListener('library', this.onLib);
  }
  on(target, type, fn, opts) { target.addEventListener(type, fn, opts); this.listeners.push(() => target.removeEventListener(type, fn, opts)); }
  /** 版の選択（版が 2 つ以上の時だけ出す）。新しい順に並べ、最新に「最新」の印 */
  fillVersions() {
    const vs = this.item.versions || [], lv = L.latestVersion(this.item);
    clear(this.verSel);
    for (const x of [...vs].reverse()) this.verSel.append(h('option', { value: String(x.v), text: `v${x.v}${lv && x.v === lv.v ? '（最新）' : ''}` }));
    this.verSel.hidden = vs.length < 2;
    if (this.v != null) this.verSel.value = String(this.v);
  }
  onLibrary() {
    const it = this.engine.item(this.item.id);
    if (!it) return;                                       // 別の端末で消された時は、開いている物はそのまま見せる
    const sig = JSON.stringify([it.title, it.versions.map(x => x.v)]);
    this.item = it;
    if (sig === this._sig) return;
    this._sig = sig;
    this.titleEl.textContent = it.title; this.titleEl.title = it.title;
    this.fillVersions();
  }

  // ---------- 読み込み ----------
  setLoading(msg, ratio) {
    clearTimeout(this.loadTimer);
    this.loadingEl.hidden = false; this.loadingEl.classList.remove('err');
    if (!this.loadingEl.querySelector('.spin')) { clear(this.loadingEl); this.loadingEl.append(h('div', { class: 'spin' }), h('div', { class: 'msg' }), h('div', { class: 'bar' }, h('div', { class: 'fill' }))); }
    this.loadingEl.querySelector('.msg').textContent = msg || '';
    const bar = this.loadingEl.querySelector('.bar');
    bar.hidden = ratio == null;
    if (ratio != null) bar.firstChild.style.width = Math.round(clamp(ratio, 0, 1) * 100) + '%';
  }
  hideLoading() { clearTimeout(this.loadTimer); this.loadingEl.hidden = true; }
  showLoadError(e) {
    clearTimeout(this.loadTimer);
    this.loadingEl.hidden = false; this.loadingEl.classList.add('err');
    const kind = e && e.kind;
    const head = kind === 'offline' ? 'オフラインのため開けません' : kind === 'notfound' ? '倉庫に見つかりません' : kind === 'network' ? '通信できませんでした' : '開けませんでした';
    const msg = kind === 'network' ? '電波の状態を確かめて「もう一度」を押してください。（' + (e.message || '') + '）' : (e && e.message ? e.message : String(e));
    clear(this.loadingEl);
    this.loadingEl.append(h('div', { class: 'err-head', text: head }), h('div', { class: 'msg', dataset: { t: 'load-error', kind: kind || 'other' }, text: msg }),
      h('div', { class: 'row' }, h('button', { class: 'btn', type: 'button', dataset: { t: 'load-back' }, onclick: () => this.opts.onBack() }, 'ライブラリへ戻る'),
        h('button', { class: 'btn primary', type: 'button', dataset: { t: 'load-retry' }, onclick: () => this.load(this.v) }, 'もう一度')));
  }
  /** v の版を読み込んで箱へ渡す（同じ画面のまま入れ替わる） */
  async load(v) {
    const seq = ++this.seq;
    this.v = Number(v); this.loaded = false; this.errors = []; this.html = null; this.from = null;
    this.verSel.value = String(this.v);
    this.setLoading('読み込んでいます…', null);
    try {
      const r = await this.engine.getHtml(this.item, this.v, (got, total) => {
        if (seq !== this.seq) return;
        const mb = n => (n / 1048576).toFixed(1);
        this.setLoading(`読み込んでいます… ${mb(got)}${total ? ' / ' + mb(total) : ''} MB`, total ? got / total : null);
      });
      if (seq !== this.seq || this.destroyed) return false;
      const text = L.decodeHtml(new Uint8Array(await r.blob.arrayBuffer()));
      if (seq !== this.seq || this.destroyed) return false;
      this.html = text; this.from = r.from;
      this.setLoading('読み込んでいます…', null);
      this.post();
      return true;
    } catch (e) {
      if (seq !== this.seq || this.destroyed) return false;
      if (!(e && e.kind)) console.warn('[viewer] 読み込みに失敗', e && e.message);
      this.showLoadError(e);
      return false;
    }
  }
  /** 箱に HTML を渡す。箱がまだ「ready」でなければ、ready を待ってから渡す */
  post() {
    if (this.html == null) return;
    if (!this.boxReady) { this.pending = true; return; }
    this.pending = false; this.loaded = false; this.errors = [];
    this.frame.contentWindow.postMessage({ hl: 1, type: 'load', html: this.html }, location.origin);
    clearTimeout(this.loadTimer);
    this.loadTimer = setTimeout(() => { if (!this.loaded) this.hideLoading(); }, LOADED_TIMEOUT_MS);
  }
  onMessage(ev) {
    if (ev.source !== this.frame.contentWindow || ev.origin !== location.origin) return;
    const d = ev.data;
    if (!d || d.hl !== 1) return;
    if (d.type === 'ready') { this.boxReady = true; if (this.pending) this.post(); }
    else if (d.type === 'loaded') { this.loaded = true; this.hideLoading(); }
    else if (d.type === 'error') { if (this.errors.length < 200) this.errors.push({ message: String(d.message || '').slice(0, 300), line: Number(d.line) || 0 }); }
    else if (this.others.length < 50) this.others.push({ type: String(d.type).slice(0, 40), message: String(d.message ?? '').slice(0, 300) });     // 知らない知らせは記録だけ（試験・診断用）
  }
  switchVersion(v) {
    if (!L.versionOf(this.item, v) || v === this.v) return;
    this.opts.onVersion?.(v);
    this.load(v);
  }
  reload() { if (this.html != null) { this.setLoading('読み込んでいます…', null); this.post(); } else this.load(this.v); }

  // ---------- 全画面（箱を含む容器に Fullscreen API。使えない時は画面いっぱいに広げるだけ）----------
  async enterFullscreen() {
    this.root.classList.add('fs');
    this.fsMode = 'css';
    if (this.stage.requestFullscreen && document.fullscreenEnabled !== false) {
      try { await this.stage.requestFullscreen({ navigationUI: 'hide' }); this.fsMode = 'api'; } catch (e) { this.fsMode = 'css'; }
    }
  }
  exitFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    this.leaveFsState();
  }
  leaveFsState() { this.root.classList.remove('fs'); this.fsMode = null; }

  // ---------- 「⋯」 ----------
  async openMore(anchor) {
    const saved = await this.engine.isSaved(this.item, this.v).catch(() => false);
    const n = this.errors.length;
    openMenu(anchor, [
      n ? { heading: `中でエラーが ${n} 件（最初：${this.errors[0].message.slice(0, 60)}）`, id: 'vm-errors' } : { heading: '中のエラー：0 件', id: 'vm-errors' },
      { label: '再読み込み', id: 'vm-reload', onClick: () => this.reload() },
      saved
        ? { label: `この版（v${this.v}）を端末から外す`, id: 'vm-unsave', onClick: async () => { await this.engine.removeFromDevice(this.item, this.v); toast('この端末の保存を外しました（倉庫には残っています）'); } }
        : { label: `この版（v${this.v}）を端末に保存`, id: 'vm-save', onClick: async () => {
          try { await this.engine.saveToDevice(this.item, this.v); toast(`v${this.v} を端末に保存しました（電波が無くても開けます）`); }
          catch (e) { toast('端末に保存できませんでした：' + (e && e.message ? e.message : e), { kind: 'error', ms: 7000 }); }
        } },
    ]);
  }

  /** 画面外からの状態確認用（試験） */
  state() {
    return { id: this.item.id, v: this.v, boxReady: this.boxReady, loaded: this.loaded, errors: this.errors.length, errorMessages: this.errors.slice(0, 5).map(e => e.message),
      others: this.others.slice(-10), from: this.from, fs: this.fsMode, loading: !this.loadingEl.hidden, versions: (this.item.versions || []).map(x => x.v) };
  }
  destroy() {
    this.destroyed = true; this.seq++;
    clearTimeout(this.loadTimer);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    for (const off of this.listeners) off();
    this.engine.removeEventListener('library', this.onLib);
    this.root.remove();
  }
}
