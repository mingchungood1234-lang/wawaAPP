// Single-user password login. The session cookie is an HMAC-signed expiry
// timestamp, so there is no server-side session store.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const COOKIE = 'wam_session';
const MAX_AGE_DAYS = 30;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function createAuth({ dataDir, password }) {
  if (!password || password.length < 8) {
    throw new Error('Set APP_PASSWORD (at least 8 characters) to protect your WhatsApp session.');
  }
  const secretFile = join(dataDir, 'secret');
  if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'), { mode: 0o600 });
  const secret = readFileSync(secretFile, 'utf8').trim();
  const failures = new Map(); // ip -> { count, until }

  const sign = (value) => createHmac('sha256', secret).update(value).digest('base64url');

  function issue(res, secure) {
    const expires = Date.now() + MAX_AGE_DAYS * 864e5;
    const token = `${expires}.${sign(String(expires))}`;
    res.cookie(COOKIE, token, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      maxAge: MAX_AGE_DAYS * 864e5,
      path: '/',
    });
  }

  function valid(cookieHeader) {
    const token = parseCookies(cookieHeader)[COOKIE];
    if (!token) return false;
    const [expires, mac] = token.split('.');
    if (!expires || !mac || Number(expires) < Date.now()) return false;
    return safeEqual(mac, sign(expires));
  }

  function login(req, res) {
    const ip = req.ip;
    const f = failures.get(ip);
    if (f && f.count >= MAX_FAILURES && Date.now() < f.until) {
      return res.status(429).json({ error: 'Too many attempts. Try again later.' });
    }
    if (!safeEqual(String(req.body?.password ?? ''), password)) {
      const count = (f && Date.now() < f.until ? f.count : 0) + 1;
      failures.set(ip, { count, until: Date.now() + LOCKOUT_MS });
      return res.status(401).json({ error: 'Wrong password' });
    }
    failures.delete(ip);
    issue(res, req.secure);
    res.json({ ok: true });
  }

  function logout(req, res) {
    res.clearCookie(COOKIE, { path: '/' });
    res.json({ ok: true });
  }

  function require(req, res, next) {
    if (valid(req.headers.cookie)) return next();
    res.status(401).json({ error: 'Not logged in' });
  }

  return { login, logout, require, valid };
}

function safeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
