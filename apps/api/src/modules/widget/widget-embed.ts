/**
 * The chat box a customer pastes on their website with one <script> tag.
 *
 * Plain JS inside a Shadow DOM: no framework, no build step, and the host
 * page's CSS can't leak in (nor ours out). It talks only to the public
 * /widget/:hash routes, polls for replies (every 3 s while open, 20 s while
 * closed so the launcher can show an unread badge), renders flow menus as
 * tappable buttons and flow media inline.
 *
 * Written without template literals, `${` or backslashes so it can live in a
 * String.raw block untouched. `window.Cosmika` stays as the programmatic API.
 */
const CLIENT = String.raw`
  var scriptEl = document.currentScript;
  // The script knows where it was served from, which is the API base behind
  // any proxy prefix (e.g. https://app.cosmobots.io/api). FALLBACK_API is
  // only used when the script was inlined rather than loaded by URL.
  var API = FALLBACK_API;
  try {
    if (scriptEl && scriptEl.src) {
      var marker = '/widget/' + encodeURIComponent(HASH) + '/embed.js';
      var at = scriptEl.src.indexOf(marker);
      if (at < 0) at = scriptEl.src.indexOf('/widget/');
      if (at > 0) API = scriptEl.src.slice(0, at);
    }
  } catch (e) {}
  var KEY = 'cosmika.widget.' + HASH;
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {} }
  function forget() { try { localStorage.removeItem(KEY); } catch (e) {} }
  var configCache = null;
  async function config() {
    if (configCache) return configCache;
    const r = await fetch(API + '/widget/' + HASH + '/config');
    if (!r.ok) throw new Error('widget config failed: ' + r.status);
    configCache = await r.json();
    return configCache;
  }
  async function ensureSession(preChat) {
    const cached = load();
    if (cached && cached.visitorToken && new Date(cached.expiresAt).getTime() > Date.now() + 60000) return cached;
    const r = await fetch(API + '/widget/' + HASH + '/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorId: (cached && cached.visitorId) || null, preChat: preChat || (cached && cached.preChat) || null }),
    });
    if (!r.ok) throw new Error('widget session failed: ' + r.status);
    const s = await r.json();
    s.visitorId = (cached && cached.visitorId) || s.contactId;
    if (preChat) s.preChat = preChat; else if (cached && cached.preChat) s.preChat = cached.preChat;
    if (cached && cached.conversationId === s.conversationId && cached.seen) s.seen = cached.seen;
    save(s);
    return s;
  }
  async function send(content, interactiveReplyId) {
    const s = await ensureSession();
    const r = await fetch(API + '/widget/' + HASH + '/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ visitorToken: s.visitorToken, content: content, interactiveReplyId: interactiveReplyId || null }),
    });
    if (!r.ok) throw new Error('send failed: ' + r.status);
    return r.json();
  }
  async function fetchMessages() {
    const s = await ensureSession();
    const r = await fetch(API + '/widget/' + HASH + '/messages?visitorToken=' + encodeURIComponent(s.visitorToken));
    if (r.status === 400) {
      // Token from another widget or a rotated secret: start over once.
      const c = load();
      forget();
      if (c) save({ visitorId: c.visitorId, preChat: c.preChat, expiresAt: '1970-01-01T00:00:00Z' });
      throw new Error('session reset');
    }
    if (!r.ok) throw new Error('fetch failed: ' + r.status);
    return r.json();
  }

  var LANG = ((navigator.language || 'en').slice(0, 2)).toLowerCase();
  var T = {
    pt: { open: 'Fale conosco', placeholder: 'Escreva sua mensagem', send: 'Enviar', start: 'Iniciar conversa', close: 'Fechar', required: 'Preencha este campo', error: 'Não foi possível enviar. Tente de novo.', file: 'Abrir arquivo' },
    es: { open: 'Contáctenos', placeholder: 'Escriba su mensaje', send: 'Enviar', start: 'Iniciar conversación', close: 'Cerrar', required: 'Complete este campo', error: 'No se pudo enviar. Inténtelo de nuevo.', file: 'Abrir archivo' },
    en: { open: 'Chat with us', placeholder: 'Type your message', send: 'Send', start: 'Start chat', close: 'Close', required: 'Please fill this in', error: 'Could not send. Please try again.', file: 'Open file' },
  }[LANG === 'pt' || LANG === 'es' ? LANG : 'en'];

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') n.textContent = attrs[k];
      else if (k === 'class') n.className = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    }
    (children || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }

  function mount(cfg) {
    var color = cfg.primaryColor || '#4f46e5';
    var host = el('div', { id: 'cosmika-widget' });
    document.body.appendChild(host);
    var root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var css = [
      ':host{all:initial}',
      '*{box-sizing:border-box;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}',
      '.launcher{position:fixed;right:20px;bottom:20px;z-index:2147483000;height:56px;min-width:56px;padding:0 20px;border:0;border-radius:28px;background:' + color + ';color:#fff;font-size:15px;font-weight:600;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.2);display:flex;align-items:center;gap:8px}',
      '.badge{background:#ef4444;color:#fff;border-radius:10px;font-size:12px;padding:1px 7px}',
      '.panel{position:fixed;right:20px;bottom:88px;z-index:2147483001;width:360px;height:540px;max-height:calc(100vh - 110px);background:#fff;color:#111827;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.25);display:none;flex-direction:column;overflow:hidden}',
      '.panel.open{display:flex}',
      '@media (max-width:480px){.panel{right:0;bottom:0;width:100vw;height:100vh;max-height:none;border-radius:0}}',
      '.head{background:' + color + ';color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:600;font-size:16px}',
      '.head button{background:transparent;border:0;color:#fff;font-size:22px;line-height:1;cursor:pointer}',
      '.body{flex:1;overflow-y:auto;padding:12px;background:#f9fafb;display:flex;flex-direction:column;gap:8px}',
      '.msg{max-width:82%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap;word-wrap:break-word}',
      '.them{align-self:flex-start;background:#fff;border:1px solid #e5e7eb}',
      '.me{align-self:flex-end;background:' + color + ';color:#fff}',
      '.msg img,.msg video{display:block;max-width:100%;border-radius:10px;margin-bottom:4px}',
      '.msg audio{display:block;width:240px;max-width:100%;margin-bottom:4px}',
      '.msg a{color:inherit}',
      '.opts{align-self:flex-start;display:flex;flex-wrap:wrap;gap:6px;max-width:90%}',
      '.opts button{border:1px solid ' + color + ';color:' + color + ';background:#fff;border-radius:16px;padding:7px 12px;font-size:13px;cursor:pointer}',
      '.opts button:disabled{opacity:.5;cursor:default}',
      '.foot{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff}',
      '.foot textarea{flex:1;resize:none;border:1px solid #d1d5db;border-radius:10px;padding:9px;font-size:14px;height:42px;max-height:120px}',
      '.foot button,.form button{background:' + color + ';color:#fff;border:0;border-radius:10px;padding:0 14px;font-size:14px;font-weight:600;cursor:pointer}',
      '.form{padding:16px;display:flex;flex-direction:column;gap:10px;overflow-y:auto}',
      '.form label{font-size:13px;color:#374151;display:flex;flex-direction:column;gap:4px}',
      '.form input{border:1px solid #d1d5db;border-radius:8px;padding:9px;font-size:14px}',
      '.form button{height:42px;margin-top:6px}',
      '.err{color:#b91c1c;font-size:12px}',
    ].join('');
    root.appendChild(el('style', { text: css }));

    var badge = el('span', { class: 'badge' });
    badge.style.display = 'none';
    var launcher = el('button', { class: 'launcher', type: 'button', 'aria-label': cfg.launcherText || T.open }, [
      el('span', { text: cfg.launcherText || T.open }), badge,
    ]);
    var body = el('div', { class: 'body', role: 'log', 'aria-live': 'polite' });
    var input = el('textarea', { placeholder: T.placeholder, rows: '1', 'aria-label': T.placeholder });
    var sendBtn = el('button', { type: 'button', text: T.send });
    var foot = el('div', { class: 'foot' }, [input, sendBtn]);
    var form = el('form', { class: 'form' });
    var panel = el('div', { class: 'panel', role: 'dialog', 'aria-label': cfg.title }, [
      el('div', { class: 'head' }, [
        el('span', { text: cfg.title }),
        el('button', { type: 'button', 'aria-label': T.close, text: '×', onclick: function () { toggle(false); } }),
      ]),
      form, body, foot,
    ]);
    root.appendChild(panel);
    root.appendChild(launcher);

    var isOpen = false;
    // Replies the visitor has already seen survive a page reload, so the
    // badge only counts what is really new.
    var lastSeenCount = (load() && load().seen) || 0;
    function markSeen(n) {
      lastSeenCount = n;
      var c = load();
      if (c) { c.seen = n; save(c); }
    }
    var messages = [];
    var timer = null;
    var busy = false;

    var needsPreChat = (cfg.preChatFields || []).length > 0 && !(load() && load().visitorToken);
    function showChat() {
      form.style.display = 'none';
      body.style.display = 'flex';
      foot.style.display = 'flex';
    }
    if (needsPreChat) {
      body.style.display = 'none';
      foot.style.display = 'none';
      var inputs = {};
      (cfg.preChatFields || []).forEach(function (f) {
        var i = el('input', { type: f.type === 'email' ? 'email' : (f.type === 'phone' ? 'tel' : 'text'), name: f.key });
        if (f.required) i.required = true;
        inputs[f.key] = i;
        form.appendChild(el('label', {}, [el('span', { text: f.label + (f.required ? ' *' : '') }), i]));
      });
      var err = el('div', { class: 'err' });
      form.appendChild(err);
      form.appendChild(el('button', { type: 'submit', text: T.start }));
      form.addEventListener('submit', async function (ev) {
        ev.preventDefault();
        var pre = {};
        for (var k in inputs) { var v = inputs[k].value.trim(); if (v) pre[k] = v; }
        try {
          await ensureSession(pre);
          showChat();
          refresh();
          input.focus();
        } catch (e) { err.textContent = T.error; }
      });
    } else {
      showChat();
    }

    function bubble(m) {
      var mine = m.senderType === 'CONTACT';
      var b = el('div', { class: 'msg ' + (mine ? 'me' : 'them') });
      if (m.media) {
        var t = m.media.type;
        if (t === 'IMAGE') b.appendChild(el('img', { src: m.media.url, alt: m.content || '' }));
        else if (t === 'VIDEO') b.appendChild(el('video', { src: m.media.url, controls: '' }));
        else if (t === 'AUDIO') b.appendChild(el('audio', { src: m.media.url, controls: '' }));
        else b.appendChild(el('a', { href: m.media.url, target: '_blank', rel: 'noopener', text: '📄 ' + (m.content || T.file) }));
        if (m.content && t !== 'FILE') b.appendChild(el('div', { text: m.content }));
      } else if (m.interactive) {
        b.textContent = m.interactive.body;
      } else {
        b.textContent = m.content || '';
      }
      return b;
    }

    function options(m, isLast) {
      var it = m.interactive;
      var list = it.kind === 'buttons'
        ? it.buttons.map(function (x) { return { id: x.id, label: x.label }; })
        : [].concat.apply([], it.sections.map(function (s) { return s.rows.map(function (r) { return { id: r.id, label: r.title }; }); }));
      return el('div', { class: 'opts' }, list.map(function (o) {
        var btn = el('button', { type: 'button', text: o.label, onclick: function () { submit(o.label, o.id); } });
        if (!isLast) btn.disabled = true;
        return btn;
      }));
    }

    function render() {
      body.innerHTML = '';
      if (cfg.welcomeMessage) body.appendChild(el('div', { class: 'msg them', text: cfg.welcomeMessage }));
      messages.forEach(function (m, i) {
        if (m.content == null && !m.media && !m.interactive) return;
        body.appendChild(bubble(m));
        if (m.interactive) body.appendChild(options(m, i === messages.length - 1));
      });
      body.scrollTop = body.scrollHeight;
    }

    async function refresh() {
      if (!(load() && load().visitorToken)) return;
      try {
        var list = await fetchMessages();
        var changed = list.length !== messages.length;
        messages = list;
        if (changed && isOpen) render();
        var theirs = list.filter(function (m) { return m.senderType !== 'CONTACT'; }).length;
        if (isOpen && theirs !== lastSeenCount) markSeen(theirs);
        var unread = theirs - lastSeenCount;
        badge.textContent = String(unread);
        badge.style.display = !isOpen && unread > 0 ? 'inline-block' : 'none';
      } catch (e) {}
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(function () { refresh().then(schedule); }, isOpen ? 3000 : 20000);
    }

    async function submit(text, replyId) {
      text = (text || '').trim();
      if (!text || busy) return;
      busy = true;
      sendBtn.disabled = true;
      try {
        await send(text, replyId);
        if (!replyId) input.value = '';
        await refresh();
        render();
      } catch (e) {
        body.appendChild(el('div', { class: 'err', text: T.error }));
      } finally {
        busy = false;
        sendBtn.disabled = false;
      }
    }

    function toggle(open) {
      isOpen = open === undefined ? !isOpen : open;
      panel.classList.toggle('open', isOpen);
      if (isOpen) { render(); refresh().then(render); if (!needsPreChat) input.focus(); }
      schedule();
    }

    launcher.addEventListener('click', function () { toggle(); });
    sendBtn.addEventListener('click', function () { submit(input.value); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); submit(input.value); }
    });
    refresh().then(schedule);
  }

  window.Cosmika = { send, fetchMessages, ensureSession, config };
  function boot() {
    if (window.CosmikaWidgetNoUI) return;
    config().then(mount).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
`

export function buildEmbedScript(hash: string, apiBase: string): string {
  return (
    '(() => {\n' +
    '  const HASH = ' + JSON.stringify(hash) + ';\n' +
    '  const FALLBACK_API = ' + JSON.stringify(apiBase) + ';\n' +
    CLIENT +
    '\n})();'
  )
}
