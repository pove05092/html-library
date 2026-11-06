// frame.js : viewer.html（HTML の箱）の中身。殻（親）から HTML の文字列を受け取り、sandbox の iframe に blob: URL で入れて開く。
//  - sandbox に allow-same-origin は付けない＝中の HTML は殻の localStorage・IndexedDB（トークン）に触れない。
//  - 中の HTML は localStorage / sessionStorage を使えない（SecurityError）ので、先頭に「メモリ上だけの代用品」を差し込む（本人の方針：進捗は保存しない）。
//  - blob: URL にするのは、教科書の目次の「#章」リンクを同じページ内の移動として動かすため（srcdoc だと親のページへ飛ぶ恐れ）。
//    ただし sandbox（opaque origin）の blob: 文書では #… への移動そのものが止められる（2026-11-06 実測）ので、SHIM の click 処理がその要素へスクロールして代わりに動かす。
//  - 殻とのやりとり（postMessage）：殻→箱 {hl:1, type:'load', html}／箱→殻 {hl:1, type:'ready'|'loaded'|'error'|'blocked', …}。
const SANDBOX = 'allow-scripts allow-modals allow-forms allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-downloads';

// 中の HTML の先頭に差し込む。中身は文字列として殻から見えるので、ここで完結させる（外部の物に依存しない）。
const SHIM = '<script>(function(){'
  + 'function mk(){var d=Object.create(null);var api={getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},'
  + 'removeItem:function(k){delete d[String(k)]},clear:function(){d=Object.create(null)},key:function(i){var ks=Object.keys(d);return i>=0&&i<ks.length?ks[i]:null}};'
  + 'return new Proxy(api,{get:function(t,p){if(p==="length")return Object.keys(d).length;if(p in t)return t[p];return typeof p==="string"&&p in d?d[p]:undefined},'
  + 'set:function(t,p,v){if(typeof p==="string")d[p]=String(v);return true},deleteProperty:function(t,p){delete d[p];return true},has:function(t,p){return p in t||p in d},'
  + 'ownKeys:function(){return Object.keys(d)},getOwnPropertyDescriptor:function(t,p){return p in d?{value:d[p],writable:true,enumerable:true,configurable:true}:undefined}})}'
  + '["localStorage","sessionStorage"].forEach(function(n){try{Object.defineProperty(window,n,{value:mk(),configurable:true})}catch(e){}});'
  + 'function say(o){try{o.hl=1;parent.postMessage(o,"*")}catch(e){}}'
  + 'window.addEventListener("error",function(e){say({type:"error",message:String(e&&e.message||"error"),line:e&&e.lineno||0})});'
  + 'window.addEventListener("unhandledrejection",function(e){say({type:"error",message:"Promise: "+String(e&&e.reason&&e.reason.message||e.reason||"")})});'
  + 'document.addEventListener("securitypolicyviolation",function(e){say({type:"error",message:"blocked: "+String(e.blockedURI)+" ("+String(e.violatedDirective)+")"})});'
  // 同じページ内のリンク（目次の「#章」）：sandbox（opaque origin）の blob: 文書では #… への移動（リンク・location.hash）が黙って止められる（2026-11-06 E2E で実測。
  // scrollIntoView は動く）。そこで #… のリンクだけ、ページの既定の動きの代わりに、その id（無ければ name）の要素へスクロールする。ページ自身が止めた（preventDefault）クリックには触らない。
  + 'document.addEventListener("click",function(e){if(e.defaultPrevented||e.button!==0||e.metaKey||e.ctrlKey||e.shiftKey||e.altKey)return;'
  + 'var a=e.target&&e.target.closest?e.target.closest("a[href]"):null;if(!a)return;var h=a.getAttribute("href")||"";if(h.charAt(0)!=="#")return;'
  + 'if(a.target&&a.target!=="_self")return;e.preventDefault();var id=h.slice(1);try{id=decodeURIComponent(id)}catch(x){}'
  + 'var t=id?(document.getElementById(id)||document.getElementsByName(id)[0]):null;if(t)t.scrollIntoView();else if(!id||id==="top")window.scrollTo(0,0)});'
  + 'window.addEventListener("load",function(){say({type:"loaded"})});'
  + '})();<\/script>';

// 算数の工場のゲーム 4 本は import map で three.js を外部 CDN（jsdelivr）から読む。箱の CSP は外部のスクリプトを許さない（許すと、中の HTML が
// 何を読み込んでもよくなる）ので、同じ版（r160）の圧縮版を殻に同梱し、HTML の中のその URL だけを同梱版の data: URL に差し替える＝オフラインでも動く。
// blob: URL ではなく data: URL にするのは、sandbox（allow-same-origin なし）の中のゲームは、別オリジンが作った blob: を読めないため（実測 2026-11-06）。
const THREE_URL = 'https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js';
let threeDataUrl = null;
async function threeUrl() {
  if (!threeDataUrl) {
    const r = await fetch('vendor/three/three.module.min.js');
    if (!r.ok) throw new Error(`three.js の同梱版を読めません（HTTP ${r.status}）`);
    const blob = new Blob([await r.arrayBuffer()], { type: 'text/javascript' });
    threeDataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(fr.error); fr.readAsDataURL(blob); });
  }
  return threeDataUrl;
}
/** HTML に含まれる外部ライブラリの URL を、同梱版へ差し替える（対象が無ければ何もしない＝通信もしない） */
export async function rewriteLibs(html) {
  const s = String(html);
  return s.includes(THREE_URL) ? s.split(THREE_URL).join(await threeUrl()) : s;
}

/** HTML の先頭（<head> の直後。無ければ <html> の直後、それも無ければ doctype の直後）に差し込む */
export function injectShim(html) {
  const s = String(html);
  for (const re of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i, /^\s*<!doctype[^>]*>/i]) {
    const m = re.exec(s);
    if (m) { const at = m.index + m[0].length; return s.slice(0, at) + SHIM + s.slice(at); }
  }
  return SHIM + s;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.body) {
  let frame = null, url = null;
  const post = o => { try { parent.postMessage({ hl: 1, ...o }, '*'); } catch (e) { /* 無視 */ } };
  let seq = 0;
  async function open(html) {
    const my = ++seq;
    let doc;
    try { doc = injectShim(await rewriteLibs(html)); }
    catch (e) { post({ type: 'error', message: String(e && e.message || e) }); doc = injectShim(html); }
    if (my !== seq) return;                       // 待っている間に次の load が来ていたら、古い方は捨てる
    if (frame) { frame.remove(); frame = null; }
    if (url) { URL.revokeObjectURL(url); url = null; }
    url = URL.createObjectURL(new Blob([doc], { type: 'text/html;charset=utf-8' }));
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('allow', 'fullscreen; autoplay; clipboard-write');   // allowfullscreen は allow="fullscreen" と重なる（Chrome が警告を出す）ので付けない
    frame.title = 'HTML';
    frame.src = url;
    document.body.append(frame);
  }
  window.addEventListener('message', ev => {
    const d = ev.data;
    if (!d || d.hl !== 1) return;
    if (ev.source === parent && d.type === 'load' && typeof d.html === 'string') open(d.html);
    else if (frame && ev.source === frame.contentWindow) post({ type: d.type, message: d.message, line: d.line });   // 中の HTML の知らせを殻へ中継
  });
  post({ type: 'ready' });
}
