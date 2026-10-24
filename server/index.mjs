// HTTP + WebSocket server for the mobile WhatsApp client.
//
//   APP_PASSWORD=...  npm start
//
// Env: APP_PASSWORD (required), PORT (3000), DATA_DIR (./data),
//      PUSH_CONTACT (mailto: for VAPID), WA_NO_SANDBOX=1 (containers running as root),
//      MEDIA_CACHE_MB (24), UPLOAD_LIMIT_MB (64)
import { mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createAuth } from './auth.mjs';
import { createPush } from './push.mjs';
import { WhatsApp, previewBody } from './wa.mjs';

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url));
const UPLOAD_LIMIT_MB = Number(process.env.UPLOAD_LIMIT_MB || 64);
const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
mkdirSync(DATA_DIR, { recursive: true });

const auth = createAuth({ dataDir: DATA_DIR, password: process.env.APP_PASSWORD });
const push = createPush({ dataDir: DATA_DIR, contact: process.env.PUSH_CONTACT || 'mailto:admin@localhost' });
const wa = new WhatsApp({ dataDir: DATA_DIR });

const app = express();
app.set('trust proxy', 'loopback, uniquelocal'); // behind nginx: real client IP + https
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  });
  next();
});

// ---------- public ----------

app.post('/api/login', express.json(), auth.login);
app.post('/api/logout', auth.logout);
app.get('/api/session', (req, res) => res.json({ loggedIn: auth.valid(req.headers.cookie) }));

app.use(
  express.static(WEB_DIR, {
    setHeaders: (res, path) => {
      // The service worker and app shell must revalidate so updates roll out.
      if (/sw\.js$|index\.html$|\.webmanifest$/.test(path)) res.set('Cache-Control', 'no-cache');
    },
  })
);

// ---------- authenticated API ----------

const api = express.Router();
api.use(auth.require);
const wrap = (fn) => (req, res, next) => fn(req, res).catch(next);

api.get('/status', (req, res) => res.json(wa.state));

api.post('/wa/pair', express.json(), wrap(async (req, res) => {
  res.json({ code: await wa.requestPairingCode(String(req.body?.phone || '')) });
}));

api.post('/wa/logout', wrap(async (req, res) => {
  await wa.logout();
  res.json({ ok: true });
}));

api.get('/chats', wrap(async (req, res) => res.json(await wa.chats())));

api.get('/chats/:id/messages', wrap(async (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
  res.json(await wa.messages(req.params.id, limit));
}));

api.post('/chats/:id/messages', express.json({ limit: '1mb' }), wrap(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'Empty message' });
  res.json(await wa.send(req.params.id, text, req.body.quotedId));
}));

api.post('/chats/:id/media', express.raw({ type: () => true, limit: `${UPLOAD_LIMIT_MB}mb` }), wrap(async (req, res) => {
  if (!req.body?.length) return res.status(400).json({ error: 'Empty upload' });
  res.json(
    await wa.sendMedia(req.params.id, {
      buffer: req.body,
      mimetype: req.get('content-type') || 'application/octet-stream',
      filename: String(req.query.filename || 'file'),
      caption: req.query.caption ? String(req.query.caption) : undefined,
      asDocument: req.query.doc === '1',
    })
  );
}));

api.post('/chats/:id/seen', wrap(async (req, res) => {
  await wa.markSeen(req.params.id);
  res.json({ ok: true });
}));

api.get('/media/:id', wrap(async (req, res) => {
  const media = await wa.media(req.params.id);
  if (!media) return res.status(404).end();
  const disposition = req.query.inline === '1' ? 'inline' : 'attachment';
  res.set({
    'Content-Type': media.mimetype,
    'Content-Disposition': `${disposition}; filename*=UTF-8''${encodeURIComponent(media.filename || 'file')}`,
    'Cache-Control': 'private, max-age=86400',
    'Accept-Ranges': 'bytes',
  });
  sendRange(req, res, media.data);
}));

api.get('/avatar/:id', wrap(async (req, res) => {
  const url = await wa.avatarUrl(req.params.id);
  if (!url) return res.status(404).set('Cache-Control', 'private, max-age=3600').end();
  const upstream = await fetch(url);
  if (!upstream.ok) return res.status(404).end();
  res.set({ 'Content-Type': upstream.headers.get('content-type') || 'image/jpeg', 'Cache-Control': 'private, max-age=3600' });
  res.send(Buffer.from(await upstream.arrayBuffer()));
}));

api.get('/push/key', (req, res) => res.json({ key: push.publicKey }));
api.post('/push/subscribe', express.json(), (req, res) => {
  push.subscribe(req.body);
  res.json({ ok: true });
});
api.post('/push/unsubscribe', express.json(), (req, res) => {
  push.unsubscribe(req.body?.endpoint);
  res.json({ ok: true });
});

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));
app.get('*', (req, res) => res.sendFile('index.html', { root: WEB_DIR, headers: { 'Cache-Control': 'no-cache' } }));

app.use((err, req, res, next) => {
  if (!err.status || err.status >= 500) console.error('[api]', req.method, req.path, err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

// iOS Safari only plays audio/video that supports byte ranges.
function sendRange(req, res, buf) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (!m) return res.send(buf);
  const start = m[1] ? Number(m[1]) : buf.length - Number(m[2]);
  const end = m[1] && m[2] ? Math.min(Number(m[2]), buf.length - 1) : buf.length - 1;
  if (start > end || start < 0) return res.status(416).set('Content-Range', `bytes */${buf.length}`).end();
  res.status(206).set('Content-Range', `bytes ${start}-${end}/${buf.length}`).send(buf.subarray(start, end + 1));
}

// ---------- live events ----------

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !auth.valid(req.headers.cookie)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});

wss.on('connection', (ws) => {
  ws.visible = true;
  ws.isAlive = true;
  ws.send(JSON.stringify({ type: 'status', state: wa.state }));
  ws.on('pong', () => (ws.isAlive = true));
  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.type === 'visible') ws.visible = !!msg.visible;
    } catch {}
  });
});

// Drop dead sockets (phones going to sleep don't always close cleanly).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) ws.terminate();
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

wa.on('event', (event) => {
  const data = JSON.stringify(event);
  for (const ws of wss.clients) if (ws.readyState === 1) ws.send(data);

  if (event.type === 'message' && !event.message.fromMe && !event.chat.muted) {
    // Only notify when no open tab is showing the app.
    const watching = [...wss.clients].some((ws) => ws.readyState === 1 && ws.visible);
    if (!watching) {
      const { message, chat } = event;
      const text = previewBody(message);
      push
        .send({
          title: chat.name,
          body: chat.isGroup && message.author ? `${message.author}: ${text}` : text,
          tag: chat.id,
          url: `/#/chat/${encodeURIComponent(chat.id)}`,
        })
        .catch((err) => console.error('[push]', err.message));
    }
  }
});

server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`));
wa.start().catch((err) => wa.fail(err));

// whatsapp-web.js fires un-awaited page work (e.g. re-injecting on navigation) that can
// reject after the browser closes during a restart; log it instead of killing the server.
process.on('unhandledRejection', (err) => console.error('[unhandled]', err?.message || err));

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await wa.client?.destroy().catch(() => {});
    process.exit(0);
  });
}
