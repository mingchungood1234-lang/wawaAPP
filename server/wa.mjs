// WhatsApp session: real WhatsApp Web running in headless Chromium (whatsapp-web.js).
// Exposes plain JSON shapes for the API and emits 'event' for live updates.
import { EventEmitter } from 'node:events';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer from 'puppeteer';
import QRCode from 'qrcode';
import wweb from 'whatsapp-web.js';

const { Client, LocalAuth, MessageMedia } = wweb;

// WhatsApp rejects "HeadlessChrome" and may reject stale versions, so present the
// real engine version as a regular desktop Chrome.
let userAgent;
async function desktopUserAgent() {
  if (!userAgent) {
    const browser = await puppeteer.launch({ headless: true, args: chromiumArgs() });
    const major = (await browser.version()).split('/')[1].split('.')[0];
    await browser.close();
    userAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
    if (process.platform === 'win32') userAgent = userAgent.replace('X11; Linux x86_64', 'Windows NT 10.0; Win64; x64');
  }
  return userAgent;
}

function chromiumArgs() {
  // Trim what a headless server doesn't need; matters on 1 GB VPSes.
  const args = [
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--mute-audio',
    '--no-first-run',
    '--disable-software-rasterizer',
    // One renderer process for everything instead of one per site/frame.
    '--renderer-process-limit=1',
    '--process-per-site',
    '--disable-site-isolation-trials',
    '--disable-features=site-per-process,IsolateOrigins,Translate,MediaRouter,OptimizationHints,BackForwardCache,AutofillServerCommunication',
    // WhatsApp Web never needs to paint avatars or thumbnails here: the API serves media
    // through downloadMedia() and avatar URLs, neither of which depends on <img> loading.
    '--blink-settings=imagesEnabled=false',
  ];
  if (process.env.WA_NO_SANDBOX === '1') {
    // Without the sandbox the zygote process is just overhead.
    args.push('--no-sandbox', '--disable-setuid-sandbox', '--no-zygote');
  }
  return args;
}

export class WhatsApp extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.state = { status: 'starting', qr: null, code: null, me: null };
    this.avatarCache = new Map(); // chatId -> { url, at }
    this.mediaCache = new Map(); // msgId -> { mimetype, data, filename }
    this.mediaCacheBytes = 0;
    this.mediaCacheMax = Number(process.env.MEDIA_CACHE_MB || 24) * 1024 * 1024;
  }

  async start() {
    // If Chromium was killed (OOM, container restart) it leaves Singleton* lock files in
    // the profile and every later launch refuses with "profile in use". Only this process
    // uses the profile, so any lock present now is stale.
    for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      rmSync(join(this.dataDir, 'session', f), { force: true });
    }

    this.client = new Client({
      // Browser profile lands in <dataDir>/session. Keep dataDir short on Windows:
      // Chrome's IndexedDB paths inside it break past MAX_PATH (260 chars).
      authStrategy: new LocalAuth({ dataPath: this.dataDir }),
      puppeteer: { headless: true, args: chromiumArgs() },
      userAgent: await desktopUserAgent(),
    });
    const c = this.client;

    c.on('qr', async (qr) => {
      this.setState({ status: 'qr', qr: await QRCode.toDataURL(qr, { margin: 1, width: 320 }) });
    });
    c.on('code', (code) => this.setState({ status: 'qr', code }));
    c.on('authenticated', () => this.setState({ status: 'authenticated', qr: null, code: null }));
    c.on('auth_failure', (msg) => this.setState({ status: 'auth_failure', error: String(msg) }));
    // Also fires after 'ready' while offline messages sync; the client is usable by then,
    // so don't drop back to 'loading' (and block the API) once ready.
    c.on('loading_screen', (percent) => {
      if (this.state.status !== 'ready') this.setState({ status: 'loading', percent });
    });
    c.on('ready', () => {
      this.setState({ status: 'ready', qr: null, code: null, me: c.info?.wid?._serialized ?? null });
    });
    c.on('disconnected', (reason) => {
      this.setState({ status: 'disconnected', reason: String(reason) });
      // Logged out from the phone (or crashed): start over so a new QR is offered.
      this.restart();
    });

    c.on('message_create', async (msg) => {
      try {
        const chat = await msg.getChat();
        this.emit('event', { type: 'message', message: serializeMessage(msg), chat: serializeChat(chat) });
      } catch (err) {
        console.error('[wa] message_create', err.message);
      }
    });
    c.on('message_ack', (msg, ack) => {
      this.emit('event', { type: 'ack', id: msg.id._serialized, chatId: chatIdOf(msg), ack });
    });
    c.on('message_revoke_everyone', (msg) => {
      this.emit('event', { type: 'revoke', id: msg.id._serialized, chatId: chatIdOf(msg) });
    });

    c.initialize()
      .then(() => (this.failures = 0))
      .catch((err) => this.fail(err));
  }

  // Usually transient (e.g. WhatsApp Web reloading itself mid-injection:
  // "Execution context was destroyed"). Back off and retry.
  fail(err) {
    this.failures = (this.failures || 0) + 1;
    console.error(`[wa] start failed (attempt ${this.failures}):`, err?.message || err);
    this.setState({ status: 'error', error: String(err?.message || err) });
    this.restart(Math.min(2000 * 2 ** (this.failures - 1), 60000));
  }

  async restart(delay = 2000) {
    try {
      await this.client?.destroy();
    } catch {}
    this.setState({ status: 'starting', qr: null, code: null, me: null });
    setTimeout(() => this.start().catch((err) => this.fail(err)), delay);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    if (patch.status !== 'loading') console.log('[wa] status:', this.state.status);
    this.emit('event', { type: 'status', state: this.state });
  }

  requireReady() {
    if (this.state.status !== 'ready') {
      const err = new Error('WhatsApp is not connected');
      err.status = 409;
      throw err;
    }
  }

  async requestPairingCode(phone) {
    if (this.state.status !== 'qr') throw Object.assign(new Error('Not waiting for login'), { status: 409 });
    const code = await this.client.requestPairingCode(phone.replace(/\D/g, ''));
    this.setState({ code });
    return code;
  }

  async logout() {
    this.requireReady();
    await this.client.logout();
    await this.restart();
  }

  async chats() {
    this.requireReady();
    const chats = await this.client.getChats();
    return chats.filter((c) => !c.archived && c.id.server !== 'broadcast').map(serializeChat);
  }

  async messages(chatId, limit) {
    this.requireReady();
    const chat = await this.client.getChatById(chatId);
    const msgs = await chat.fetchMessages({ limit });
    return { chat: serializeChat(chat), messages: msgs.map(serializeMessage) };
  }

  async send(chatId, text, quotedId) {
    this.requireReady();
    const msg = await this.client.sendMessage(chatId, text, quotedId ? { quotedMessageId: quotedId } : {});
    return serializeMessage(msg);
  }

  async sendMedia(chatId, { buffer, mimetype, filename, caption, asDocument }) {
    this.requireReady();
    const media = new MessageMedia(mimetype, buffer.toString('base64'), filename);
    const msg = await this.client.sendMessage(chatId, media, { caption, sendMediaAsDocument: asDocument });
    return serializeMessage(msg);
  }

  async markSeen(chatId) {
    this.requireReady();
    await this.client.sendSeen(chatId);
  }

  async media(msgId) {
    this.requireReady();
    const hit = this.mediaCache.get(msgId);
    if (hit) {
      // Move to the end so eviction drops the least recently used entry.
      this.mediaCache.delete(msgId);
      this.mediaCache.set(msgId, hit);
      return hit;
    }
    const msg = await this.client.getMessageById(msgId);
    if (!msg?.hasMedia) return null;
    const media = await msg.downloadMedia();
    if (!media) return null;
    const entry = { mimetype: media.mimetype, data: Buffer.from(media.data, 'base64'), filename: media.filename };
    // Cap by bytes, not count: a handful of videos would otherwise fill a small VPS.
    if (entry.data.length <= this.mediaCacheMax / 4 && !this.mediaCache.has(msgId)) {
      this.mediaCache.set(msgId, entry);
      this.mediaCacheBytes += entry.data.length;
      while (this.mediaCacheBytes > this.mediaCacheMax) {
        const [oldId, old] = this.mediaCache.entries().next().value;
        this.mediaCache.delete(oldId);
        this.mediaCacheBytes -= old.data.length;
      }
    }
    return entry;
  }

  async avatarUrl(chatId) {
    this.requireReady();
    const hit = this.avatarCache.get(chatId);
    if (hit && Date.now() - hit.at < 60 * 60 * 1000) return hit.url;
    const url = (await this.client.getProfilePicUrl(chatId).catch(() => null)) || null;
    this.avatarCache.set(chatId, { url, at: Date.now() });
    return url;
  }
}

function chatIdOf(msg) {
  return msg.fromMe ? msg.to : msg.from;
}

export function serializeChat(chat) {
  const last = chat.lastMessage;
  return {
    id: chat.id._serialized,
    name: chat.name || chat.id.user,
    isGroup: chat.isGroup,
    unread: chat.unreadCount || 0,
    timestamp: chat.timestamp || last?.timestamp || 0,
    pinned: !!chat.pinned,
    muted: !!chat.isMuted,
    readOnly: !!chat.isReadOnly,
    last: last ? { type: last.type, body: previewBody(last), fromMe: last.fromMe, ack: last.ack } : null,
  };
}

export function serializeMessage(msg) {
  const d = msg._data || {};
  return {
    id: msg.id._serialized,
    chatId: chatIdOf(msg),
    fromMe: msg.fromMe,
    author: msg.author ? d.notifyName || msg.author.split('@')[0] : null,
    type: msg.type,
    body: messageBody(msg),
    timestamp: msg.timestamp,
    ack: msg.ack,
    hasMedia: msg.hasMedia,
    mimetype: d.mimetype || null,
    filename: d.filename || null,
    duration: msg.duration || null,
    isForwarded: !!msg.isForwarded,
    quoted: d.quotedMsg
      ? { id: d.quotedStanzaID || null, body: d.quotedMsg.caption || d.quotedMsg.body || '', type: d.quotedMsg.type }
      : null,
    location: msg.location ? { lat: msg.location.latitude, lng: msg.location.longitude, name: msg.location.name || '' } : null,
  };
}

const TYPE_LABEL = {
  image: '📷 Photo',
  video: '🎥 Video',
  audio: '🎵 Audio',
  ptt: '🎤 Voice message',
  document: '📄 Document',
  sticker: '💟 Sticker',
  location: '📍 Location',
  vcard: '👤 Contact',
  multi_vcard: '👥 Contacts',
  revoked: '🚫 This message was deleted',
  poll_creation: '📊 Poll',
  call_log: '📞 Call',
};

// For these types whatsapp-web.js puts non-text in body (thumbnails, raw vCards).
const NON_TEXT_BODY = new Set(['location', 'sticker', 'revoked', 'vcard', 'multi_vcard', 'call_log']);

export function previewBody(msg) {
  const label = TYPE_LABEL[msg.type];
  if (!label) return msg.body || '';
  return msg.body && !NON_TEXT_BODY.has(msg.type) ? `${label.split(' ')[0]} ${msg.body}` : label;
}

function messageBody(msg) {
  if (msg.type === 'vcard') return /^FN:(.*)$/m.exec(msg.body || '')?.[1]?.trim() || '';
  return NON_TEXT_BODY.has(msg.type) ? '' : msg.body || '';
}
