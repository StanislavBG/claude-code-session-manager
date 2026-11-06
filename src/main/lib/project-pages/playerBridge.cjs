// @ts-check
// Inline postMessage bridge injected next to the CSP so Project Home can drive
// a sandboxed (no same-origin) demo video. Replies go to event.source only.
// Must stay clean under validateDemoVideoHtml's NETWORK_CHECKS.

const BRIDGE_JS = `(() => {
  var timer = null;
  var flag = false;
  var muted = false;
  const demo = () => { return window.smDemo || null; }
  const num = (v, d) => { return typeof v === 'number' && isFinite(v) ? v : d; }
  const call = (name, arg) => {
    var d = demo();
    if (d && typeof d[name] === 'function') { d[name](arg); return true; }
    return false;
  }
  const media = () => { return document.querySelectorAll('audio,video'); }
  const duration = () => {
    var d = demo();
    if (d) {
      var v = typeof d.duration === 'function' ? d.duration() : d.duration;
      if (typeof v === 'number' && isFinite(v) && v > 0) return v;
    }
    var m = document.querySelector('meta[name="sm-demo-duration"]');
    if (m) { var n = Number(m.getAttribute('content')); if (isFinite(n) && n > 0) return n; }
    var els = media();
    for (var i = 0; i < els.length; i++) { if (isFinite(els[i].duration) && els[i].duration > 0) return els[i].duration; }
    return 0;
  }
  const now = () => {
    var d = demo();
    if (d) {
      if (typeof d.getTime === 'function') return num(d.getTime(), 0);
      if (typeof d.t === 'number') return d.t;
      if (typeof d.time === 'number') return d.time;
    }
    var el = media()[0];
    return el ? num(el.currentTime, 0) : 0;
  }
  const playing = () => {
    var d = demo();
    if (d) {
      if (typeof d.isPlaying === 'function') return !!d.isPlaying();
      if (typeof d.playing === 'boolean') return d.playing;
    }
    return flag;
  }
  const scenes = () => {
    var d = demo();
    var out = [];
    var src = d && Array.isArray(d.scenes) ? d.scenes : [];
    for (var i = 0; i < src.length; i++) {
      var s = src[i] || {};
      var t = typeof s.t === 'number' ? s.t : s.start;
      var label = s.label != null ? s.label : s.title;
      if (typeof t === 'number' && isFinite(t)) out.push({ t: t, label: label == null ? '' : String(label) });
    }
    return out;
  }
  const snapshot = () => {
    return { smPlayer: 1, type: 'state', duration: duration(), t: now(), playing: playing(), muted: muted, scenes: scenes() };
  }
  const stopTimer = () => { if (timer !== null) { clearInterval(timer); timer = null; } }
  const reply = (src) => {
    if (!src || typeof src.postMessage !== 'function') return;
    var s = snapshot();
    src.postMessage(s, '*');
    if (!s.playing) stopTimer();
  }
  const startTimer = (src) => {
    stopTimer();
    timer = setInterval(() => { reply(src); }, 250);
  }
  const setMuted = (m) => {
    muted = m;
    var els = media();
    for (var i = 0; i < els.length; i++) els[i].muted = m;
    call('setMuted', m);
  }
  window.addEventListener('message', (e) => {
    var data = e && e.data;
    if (!data || typeof data !== 'object' || data.smPlayer !== 1) return;
    var cmd = data.cmd;
    if (cmd === 'play') {
      flag = true;
      if (!call('play')) { var el = media()[0]; if (el && typeof el.play === 'function') el.play(); }
    } else if (cmd === 'pause') {
      flag = false;
      if (!call('pause')) { var el2 = media()[0]; if (el2 && typeof el2.pause === 'function') el2.pause(); }
    } else if (cmd === 'restart') {
      flag = true;
      if (!call('restart')) { call('seek', 0); call('play'); }
    } else if (cmd === 'seek') {
      call('seek', num(data.t, 0));
    } else if (cmd === 'mute') {
      setMuted(true);
    } else if (cmd === 'unmute') {
      setMuted(false);
    } else if (cmd !== 'hello') {
      return;
    }
    reply(e.source);
    if (playing() && e.source) startTimer(e.source);
  });
})();`;

const PLAYER_BRIDGE_SCRIPT = `<script data-sm-player-bridge>${BRIDGE_JS}</script>`;

const CSP_META_RE = /<meta\b[^>]*\bhttp-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i;

/**
 * Inserts the bridge right after the CSP meta. Idempotent. If no CSP meta is
 * present the bridge goes after a leading doctype (or at the very start).
 * @param {string} html
 * @returns {string}
 */
function injectPlayerBridge(html) {
  if (typeof html !== 'string' || html.includes('data-sm-player-bridge')) return html;
  const m = CSP_META_RE.exec(html);
  if (m) {
    const at = m.index + m[0].length;
    return html.slice(0, at) + PLAYER_BRIDGE_SCRIPT + html.slice(at);
  }
  const dt = /^\s*<!DOCTYPE\b[^>]*>/i.exec(html);
  const at = dt ? dt[0].length : 0;
  return html.slice(0, at) + PLAYER_BRIDGE_SCRIPT + html.slice(at);
}

module.exports = { PLAYER_BRIDGE_SCRIPT, injectPlayerBridge };
