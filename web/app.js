// Mobile WhatsApp client. Talks to server/index.mjs over REST + one WebSocket.
// Routes: #/ (chat list), #/chat/<chatId>

const $ = (id) => document.getElementById(id);
const body = document.body;

const state = {
  wa: null,              // WhatsApp status from the server
  chats: new Map(),      // id -> chat summary
  openId: null,          // chat currently shown
  messages: [],          // messages of the open chat (oldest first)
  limit: 50,
  replyTo: null,
  ws: null,
  wsRetry: 0,
  inAppNav: false,       // we pushed the current chat route (so back = history.back)
};

// ---------- API ----------

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: opts.json !== undefined ? { 'Content-Type': 'application/json' } : opts.headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : opts.body,
  });
  if (res.status === 401 && path !== '/login') {
    showAuth();
    throw new Error('Not logged in');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new Error(data?.error || res.statusText);
  return data;
}

// ---------- boot ----------

trackViewport();
wireUI();
boot();

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type === 'open') location.hash = new URL(e.data.url, location.origin).hash;
  });
}

async function boot() {
  const { loggedIn } = await fetch('/api/session').then((r) => r.json());
  if (!loggedIn) return showAuth();
  connect();
}

function showAuth() {
  state.ws?.close();
  state.ws = null;
  body.dataset.screen = 'auth';
  setTimeout(() => $('auth-password').focus(), 50);
}

// ---------- live connection ----------

function connect() {
  if (state.ws) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  state.ws = ws;
  ws.onopen = () => {
    state.wsRetry = 0;
    setConn('on');
    sendVisible();
  };
  ws.onmessage = (e) => onEvent(JSON.parse(e.data));
  ws.onclose = () => {
    if (state.ws !== ws) return;
    state.ws = null;
    setConn('off');
    if (body.dataset.screen === 'auth') return;
    // Cookie may have expired: check before retrying.
    fetch('/api/session')
      .then((r) => r.json())
      .then(({ loggedIn }) => {
        if (!loggedIn) return showAuth();
        const delay = Math.min(1000 * 2 ** state.wsRetry++, 15000);
        setTimeout(connect, delay);
      })
      .catch(() => setTimeout(connect, 5000));
  };
}

function sendVisible() {
  if (state.ws?.readyState === 1) state.ws.send(JSON.stringify({ type: 'visible', visible: !document.hidden }));
}

function setConn(mode) {
  $('conn').className = `conn ${mode}`;
}

function onEvent(ev) {
  switch (ev.type) {
    case 'status':
      return onStatus(ev.state);
    case 'message': {
      state.chats.set(ev.chat.id, ev.chat);
      renderChatsSoon();
      if (ev.message.chatId === state.openId) {
        addMessage(ev.message);
        if (!ev.message.fromMe && !document.hidden) markSeen(state.openId);
      }
      return;
    }
    case 'ack': {
      const m = state.messages.find((x) => x.id === ev.id);
      if (m) {
        m.ack = ev.ack;
        const el = document.querySelector(`.msg[data-id="${CSS.escape(ev.id)}"] .tick`);
        if (el) el.outerHTML = tick(ev.ack);
      }
      const chat = state.chats.get(ev.chatId);
      if (chat?.last?.fromMe) {
        chat.last.ack = ev.ack;
        renderChatsSoon();
      }
      return;
    }
    case 'revoke': {
      const m = state.messages.find((x) => x.id === ev.id);
      if (m) {
        Object.assign(m, { type: 'revoked', body: '', hasMedia: false });
        document.querySelector(`.msg[data-id="${CSS.escape(ev.id)}"]`)?.replaceWith(messageEl(m, null));
      }
    }
  }
}

function onStatus(wa) {
  const wasReady = state.wa?.status === 'ready';
  state.wa = wa;
  if (wa.status === 'ready') {
    if (!wasReady || body.dataset.screen !== 'main') {
      body.dataset.screen = 'main';
      loadChats();
      route();
    }
    return;
  }
  body.dataset.screen = 'link';
  const s = $('link-status');
  $('link-qr').hidden = !wa.qr;
  $('link-pair').hidden = wa.status !== 'qr';
  if (wa.qr) $('link-qr').src = wa.qr;
  if (wa.code) {
    $('pair-code').textContent = wa.code.replace(/^(.{4})(.{4})$/, '$1-$2');
    $('pair-code').hidden = false;
    $('pair-help').hidden = false;
  } else {
    $('pair-code').hidden = true;
    $('pair-help').hidden = true;
  }
  s.textContent = {
    starting: 'Starting WhatsApp…',
    qr: 'Scan with WhatsApp on your phone: Settings → Linked devices → Link a device.',
    authenticated: 'Linked. Loading…',
    loading: `Syncing chats… ${wa.percent ?? ''}%`,
    auth_failure: 'Login failed. Restarting…',
    disconnected: 'Disconnected. Restarting…',
    error: `Error: ${wa.error || 'unknown'}`,
  }[wa.status] || wa.status;
}

// ---------- chat list ----------

async function loadChats() {
  $('chats-empty').hidden = state.chats.size > 0;
  try {
    const chats = await api('/chats');
    state.chats = new Map(chats.map((c) => [c.id, c]));
    renderChats();
  } catch (err) {
    toast(`Couldn't load chats: ${err.message}`);
  }
}

let renderQueued = false;
function renderChatsSoon() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderChats();
  });
}

function renderChats() {
  const q = $('search').value.trim().toLowerCase();
  const list = [...state.chats.values()]
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => b.pinned - a.pinned || b.timestamp - a.timestamp);

  $('chats-empty').hidden = list.length > 0;
  $('chats-empty').textContent = q ? 'No chats found' : 'No chats yet';

  const ul = $('chats');
  const scroll = ul.scrollTop;
  ul.innerHTML = list
    .map((c) => {
      const last = c.last;
      const preview = last ? `${last.fromMe ? tick(last.ack) + ' ' : ''}${esc(last.body)}` : '';
      return `<li class="chat-item${c.unread ? ' unread' : ''}${c.muted ? ' is-muted' : ''}" data-id="${esc(c.id)}">
        ${avatar(c)}
        <div class="chat-main">
          <div class="chat-top"><span class="chat-name">${esc(c.name)}</span><span class="chat-time">${c.timestamp ? listTime(c.timestamp) : ''}</span></div>
          <div class="chat-bottom"><span class="chat-last">${preview}</span>
            ${c.muted ? '<span class="flag" aria-label="Muted">🔕</span>' : ''}
            ${c.pinned ? '<span class="flag" aria-label="Pinned">📌</span>' : ''}
            ${c.unread ? `<span class="badge">${c.unread > 99 ? '99+' : c.unread}</span>` : ''}
          </div>
        </div>
      </li>`;
    })
    .join('');
  ul.scrollTop = scroll;
}

function avatar(c, cls = '') {
  const words = c.name.split(/\s+/).map((w) => w.match(/\p{L}|\d/u)?.[0]).filter(Boolean);
  const initials = c.isGroup ? '👥' : esc((words.length ? words.slice(0, 2).join('') : '?').toUpperCase());
  return `<span class="avatar ${cls}">${initials}<img src="/api/avatar/${encodeURIComponent(c.id)}" alt="" loading="lazy" onerror="this.remove()"></span>`;
}

// ---------- routing ----------

window.addEventListener('hashchange', route);

function route() {
  if (body.dataset.screen !== 'main') return;
  const m = /^#\/chat\/(.+)$/.exec(location.hash);
  if (m) openChat(decodeURIComponent(m[1]));
  else closeChat();
}

function goBack() {
  if (state.inAppNav) history.back();
  else location.replace('#/');
}

// ---------- conversation ----------

async function openChat(id) {
  const switching = id !== state.openId;
  state.openId = id;
  body.dataset.view = 'chat';
  $('chat').setAttribute('aria-hidden', 'false');
  if (!switching) return;

  state.messages = [];
  state.limit = 50;
  setReply(null);
  const chat = state.chats.get(id) || { id, name: id.split('@')[0], isGroup: id.endsWith('@g.us') };
  renderChatHeader(chat);
  $('message-list').innerHTML = '';
  $('load-more').hidden = true;
  $('composer').hidden = !!chat.readOnly;
  await loadMessages();
  markSeen(id);
}

function closeChat() {
  state.openId = null;
  state.inAppNav = false;
  body.dataset.view = 'list';
  $('chat').setAttribute('aria-hidden', 'true');
  document.activeElement?.blur();
}

function renderChatHeader(chat) {
  $('chat-avatar').outerHTML = avatar(chat, 'sm').replace('<span class="avatar sm"', '<span id="chat-avatar" class="avatar sm"');
  $('chat-name').textContent = chat.name;
  $('chat-sub').textContent = chat.isGroup ? 'Group' : chat.id.split('@')[0].replace(/^(\d+)$/, '+$1');
}

async function loadMessages({ older = false } = {}) {
  const id = state.openId;
  const box = $('messages');
  const fromBottom = box.scrollHeight - box.scrollTop;
  try {
    const { chat, messages } = await api(`/chats/${encodeURIComponent(id)}/messages?limit=${state.limit}`);
    if (id !== state.openId) return;
    state.chats.set(chat.id, { ...state.chats.get(chat.id), ...chat });
    renderChatHeader(chat);
    $('composer').hidden = !!chat.readOnly;
    state.messages = messages.sort((a, b) => a.timestamp - b.timestamp);
    renderMessages();
    $('load-more').hidden = messages.length < state.limit;
    // Keep the viewport anchored: at the bottom normally, on the same message when loading older.
    box.scrollTop = older ? box.scrollHeight - fromBottom : box.scrollHeight;
  } catch (err) {
    toast(`Couldn't load messages: ${err.message}`);
  }
}

function renderMessages() {
  const frag = document.createDocumentFragment();
  let prev = null;
  for (const m of state.messages) {
    appendWithSeparators(frag, m, prev);
    prev = m;
  }
  $('message-list').replaceChildren(frag);
}

function appendWithSeparators(parent, m, prev) {
  if (!prev || dayKey(prev.timestamp) !== dayKey(m.timestamp)) {
    const d = document.createElement('div');
    d.className = 'day';
    d.innerHTML = `<span>${dayLabel(m.timestamp)}</span>`;
    parent.appendChild(d);
  }
  parent.appendChild(messageEl(m, prev));
}

function addMessage(m) {
  if (state.messages.some((x) => x.id === m.id)) return;
  // Our own optimistic copy of a sent message is replaced by the real one.
  if (m.fromMe) {
    const pending = state.messages.find((x) => x.pending && x.body === m.body);
    if (pending) removeMessage(pending.id);
  }
  const box = $('messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  const prev = state.messages[state.messages.length - 1];
  state.messages.push(m);
  appendWithSeparators($('message-list'), m, prev);
  if (atBottom || m.fromMe) box.scrollTop = box.scrollHeight;
}

function removeMessage(id) {
  state.messages = state.messages.filter((x) => x.id !== id);
  document.querySelector(`.msg[data-id="${CSS.escape(id)}"]`)?.remove();
}

function messageEl(m, prev) {
  const el = document.createElement('div');
  const first = !prev || prev.fromMe !== m.fromMe || prev.author !== m.author || m.timestamp - prev.timestamp > 600;
  el.className = `msg ${m.fromMe ? 'out' : 'in'}${first ? ' first' : ''}${m.pending ? ' pending' : ''}${m.type === 'sticker' ? ' sticker-msg' : ''}`;
  el.dataset.id = m.id;

  const chat = state.chats.get(m.chatId);
  const src = `/api/media/${encodeURIComponent(m.id)}?inline=1`;
  let html = '';
  if (chat?.isGroup && !m.fromMe && m.author && first) html += `<div class="author">${esc(m.author)}</div>`;
  if (m.isForwarded) html += '<div class="fwd">↪ Forwarded</div>';
  if (m.quoted) html += `<div class="quote">${esc(m.quoted.body || typeLabel(m.quoted.type))}</div>`;

  switch (m.type) {
    case 'image':
      html += m.hasMedia ? `<img class="media" src="${src}" alt="Photo" loading="lazy">` : '<div class="deleted">📷 Photo</div>';
      break;
    case 'sticker':
      html += `<img class="media sticker" src="${src}" alt="Sticker" loading="lazy">`;
      break;
    case 'video':
      html += m.hasMedia ? `<video class="media" src="${src}" controls playsinline preload="none"></video>` : '<div class="deleted">🎥 Video</div>';
      break;
    case 'audio':
    case 'ptt':
      html += `<audio src="${src}" controls preload="none"></audio>`;
      break;
    case 'document':
      html += `<a class="doc" href="${src.replace('?inline=1', '')}" download="${esc(m.filename || 'file')}">📄 <span>${esc(m.filename || 'Document')}</span></a>`;
      break;
    case 'location':
      if (m.location) {
        const q = `${m.location.lat},${m.location.lng}`;
        html += `<a class="loc" href="https://maps.google.com/?q=${q}" target="_blank" rel="noopener">📍 ${esc(m.location.name || q)}</a>`;
      }
      break;
    case 'vcard':
      html += `<div>👤 ${esc(m.body || 'Contact')}</div>`;
      break;
    case 'revoked':
      html += '<div class="deleted">🚫 This message was deleted</div>';
      break;
  }
  const textual = ['chat', 'image', 'video', 'document'].includes(m.type);
  if (textual && m.body) html += `<span class="text">${format(m.body)}</span>`;
  else if (!textual && !['sticker', 'audio', 'ptt', 'location', 'vcard', 'revoked'].includes(m.type)) {
    html += `<span class="text">${m.body ? format(m.body) : `<i class="deleted">${typeLabel(m.type)}</i>`}</span>`;
  }
  html += `<span class="meta">${clock(m.timestamp)}${m.fromMe ? tick(m.pending ? 0 : m.ack) : ''}</span>`;
  el.innerHTML = html;
  return el;
}

async function markSeen(id) {
  const chat = state.chats.get(id);
  if (chat?.unread) {
    chat.unread = 0;
    renderChatsSoon();
  }
  api(`/chats/${encodeURIComponent(id)}/seen`, { method: 'POST' }).catch(() => {});
}

// ---------- composer ----------

async function sendText() {
  const input = $('composer-input');
  const text = input.value.trim();
  if (!text || !state.openId) return;
  const chatId = state.openId;
  const quoted = state.replyTo;
  input.value = '';
  autosize();
  setReply(null);

  const temp = {
    id: `pending-${Date.now()}`,
    chatId,
    fromMe: true,
    type: 'chat',
    body: text,
    timestamp: Math.floor(Date.now() / 1000),
    ack: 0,
    pending: true,
    quoted: quoted ? { body: quoted.body, type: quoted.type } : null,
  };
  addMessage(temp);
  try {
    const sent = await api(`/chats/${encodeURIComponent(chatId)}/messages`, { method: 'POST', json: { text, quotedId: quoted?.id } });
    if (state.openId === chatId) {
      removeMessage(temp.id);
      addMessage(sent);
    }
  } catch (err) {
    removeMessage(temp.id);
    input.value = text;
    autosize();
    toast(`Not sent: ${err.message}`);
  }
}

async function sendFile(file) {
  const chatId = state.openId;
  if (!file || !chatId) return;
  if (file.size > 60 * 1024 * 1024) return toast('File is too large (max 60 MB)');
  const caption = $('composer-input').value.trim();
  const isMedia = /^(image|video|audio)\//.test(file.type);
  const params = new URLSearchParams({ filename: file.name });
  if (caption && isMedia) params.set('caption', caption);
  if (!isMedia) params.set('doc', '1');
  toast(`Sending ${file.name}…`);
  try {
    const sent = await api(`/chats/${encodeURIComponent(chatId)}/media?${params}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    });
    if (caption && isMedia) {
      $('composer-input').value = '';
      autosize();
    }
    if (state.openId === chatId) addMessage(sent);
    toast('Sent');
  } catch (err) {
    toast(`Not sent: ${err.message}`);
  }
}

function autosize() {
  const t = $('composer-input');
  t.style.height = 'auto';
  t.style.height = `${Math.min(t.scrollHeight, 140)}px`;
}

function setReply(m) {
  state.replyTo = m;
  $('reply-bar').hidden = !m;
  if (m) {
    $('reply-text').textContent = m.body || typeLabel(m.type);
    $('composer-input').focus();
  }
}

// ---------- UI wiring ----------

function wireUI() {
  $('auth-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('auth-error').textContent = '';
    try {
      await api('/login', { method: 'POST', json: { password: $('auth-password').value } });
      $('auth-password').value = '';
      body.dataset.screen = 'link';
      connect();
    } catch (err) {
      $('auth-error').textContent = err.message;
    }
  });

  $('pair-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    btn.disabled = true;
    try {
      const { code } = await api('/wa/pair', { method: 'POST', json: { phone: $('pair-phone').value } });
      onStatus({ ...state.wa, code });
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('chats').addEventListener('click', (e) => {
    const li = e.target.closest('.chat-item');
    if (!li) return;
    state.inAppNav = true;
    location.hash = `#/chat/${encodeURIComponent(li.dataset.id)}`;
  });
  $('search').addEventListener('input', renderChatsSoon);
  $('back-btn').addEventListener('click', goBack);

  $('load-more').addEventListener('click', () => {
    state.limit += 50;
    loadMessages({ older: true });
  });

  // Long-press (contextmenu) or double-tap a message to reply to it.
  const replyFrom = (e) => {
    const el = e.target.closest('.msg');
    if (!el || e.target.closest('a, audio, video')) return;
    const m = state.messages.find((x) => x.id === el.dataset.id);
    if (m && !m.pending) {
      e.preventDefault();
      setReply(m);
      el.classList.remove('flash');
      void el.offsetWidth;
      el.classList.add('flash');
    }
  };
  $('message-list').addEventListener('contextmenu', replyFrom);
  $('message-list').addEventListener('dblclick', replyFrom);
  $('reply-cancel').addEventListener('click', () => setReply(null));

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    sendText();
    $('composer-input').focus();
  });
  $('composer-input').addEventListener('input', autosize);
  $('composer-input').addEventListener('keydown', (e) => {
    // Enter sends on devices with a real keyboard; on touch keyboards Enter is a newline.
    if (e.key === 'Enter' && !e.shiftKey && matchMedia('(hover: hover)').matches) {
      e.preventDefault();
      sendText();
    }
  });
  $('attach-btn').addEventListener('click', () => $('attach-input').click());
  $('attach-input').addEventListener('change', (e) => {
    sendFile(e.target.files[0]);
    e.target.value = '';
  });

  $('menu-btn').addEventListener('click', () => {
    $('menu-notify').textContent =
      'Notification' in window && Notification.permission === 'granted' ? 'Notifications on ✓' : 'Enable notifications';
    $('menu').showModal();
  });
  $('menu').addEventListener('click', (e) => e.target === $('menu') && $('menu').close());
  $('menu-notify').addEventListener('click', async () => {
    $('menu').close();
    enableNotifications();
  });
  $('menu-lock').addEventListener('click', async () => {
    $('menu').close();
    await api('/logout', { method: 'POST' }).catch(() => {});
    showAuth();
  });
  $('menu-unlink').addEventListener('click', async () => {
    $('menu').close();
    if (!confirm('Unlink WhatsApp from this server? You will need to link it again.')) return;
    try {
      await api('/wa/logout', { method: 'POST' });
      state.chats.clear();
      renderChats();
    } catch (err) {
      toast(err.message);
    }
  });

  document.addEventListener('visibilitychange', () => {
    sendVisible();
    if (document.hidden || body.dataset.screen !== 'main') return;
    if (!state.ws) connect();
    // Catch up on anything missed while the tab was asleep.
    loadChats();
    if (state.openId) {
      loadMessages();
      markSeen(state.openId);
    }
  });
}

async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    const ios = /iPhone|iPad/.test(navigator.userAgent);
    return toast(ios ? 'On iPhone: Share → Add to Home Screen, then enable notifications from the installed app.' : 'This browser does not support push notifications.');
  }
  try {
    if ((await Notification.requestPermission()) !== 'granted') return toast('Notifications were blocked');
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('/push/key');
    const sub =
      (await reg.pushManager.getSubscription()) ||
      (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64(key) }));
    await api('/push/subscribe', { method: 'POST', json: sub.toJSON() });
    toast('Notifications enabled');
  } catch (err) {
    toast(`Couldn't enable notifications: ${err.message}`);
  }
}

// iOS Safari ignores interactive-widget; size screens to the visible area above the keyboard.
function trackViewport() {
  const vv = window.visualViewport;
  if (!vv) return;
  const sync = () => {
    document.documentElement.style.setProperty('--vh', `${vv.height}px`);
    if (vv.offsetTop > 0) window.scrollTo(0, 0);
  };
  vv.addEventListener('resize', sync);
  vv.addEventListener('scroll', sync);
  sync();
}

// ---------- formatting ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;

// WhatsApp markup: *bold* _italic_ ~strike~ ```mono``` and links. URLs are split out first
// so underscores inside them aren't treated as italics.
function format(text) {
  return String(text)
    .split(URL_RE)
    .map((part, i) => {
      if (i % 2) return `<a href="${esc(part)}" target="_blank" rel="noopener noreferrer">${esc(part)}</a>`;
      return esc(part)
        .replace(/```([\s\S]+?)```/g, '<code>$1</code>')
        .replace(/(^|[\s(])\*(\S(?:.*?\S)?)\*(?=$|[\s).,!?])/gm, '$1<b>$2</b>')
        .replace(/(^|[\s(])_(\S(?:.*?\S)?)_(?=$|[\s).,!?])/gm, '$1<i>$2</i>')
        .replace(/(^|[\s(])~(\S(?:.*?\S)?)~(?=$|[\s).,!?])/gm, '$1<s>$2</s>');
    })
    .join('');
}

function tick(ack) {
  if (ack === -1) return '<span class="tick err" title="Failed">!</span>';
  if (ack === 0 || ack == null) return '<span class="tick" title="Pending">🕓</span>';
  if (ack === 1) return '<span class="tick" title="Sent">✓</span>';
  return `<span class="tick${ack >= 3 ? ' read' : ''}" title="${ack >= 3 ? 'Read' : 'Delivered'}">✓✓</span>`;
}

function typeLabel(type) {
  return (
    {
      image: '📷 Photo', video: '🎥 Video', audio: '🎵 Audio', ptt: '🎤 Voice message', document: '📄 Document',
      sticker: '💟 Sticker', location: '📍 Location', vcard: '👤 Contact', poll_creation: '📊 Poll', call_log: '📞 Call',
    }[type] || `Unsupported message (${type})`
  );
}

const pad = (n) => String(n).padStart(2, '0');
const clock = (ts) => {
  const d = new Date(ts * 1000);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const dayKey = (ts) => new Date(ts * 1000).toDateString();

function dayLabel(ts) {
  const d = new Date(ts * 1000);
  const today = new Date();
  const yesterday = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

function listTime(ts) {
  const d = new Date(ts * 1000);
  const age = Date.now() - d.getTime();
  if (d.toDateString() === new Date().toDateString()) return clock(ts);
  if (d.toDateString() === new Date(Date.now() - 864e5).toDateString()) return 'Yesterday';
  if (age < 6 * 864e5) return d.toLocaleDateString(undefined, { weekday: 'short' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' });
}

function urlB64(b64) {
  const s = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

let toastTimer;
function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3000);
}
