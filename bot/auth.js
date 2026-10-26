import fs from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const COOKIE = 'orbita_sessao';
const SESSION_DAYS = 30;
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;

const digest = (value) => createHash('sha256').update(String(value)).digest();
const base64url = (value) => Buffer.from(value).toString('base64url');

// The signing secret stays on the server; changing PAINEL_SENHA also invalidates every open session.
function signingKey(root, password) {
  const file = path.join(root, '.orbita', 'sessao.key');
  let secret;
  try { secret = fs.readFileSync(file); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    secret = randomBytes(32);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, secret, { mode: 0o600 });
  }
  return createHmac('sha256', secret).update(password).digest();
}

function readCookie(header, name) {
  for (const part of String(header ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export function createAuth({ root, password }) {
  const enabled = Boolean(password);
  const key = enabled ? signingKey(root, password) : null;
  let failures = [];

  const sign = (payload) => createHmac('sha256', key).update(payload).digest('base64url');

  function issue() {
    const payload = base64url(JSON.stringify({ exp: Date.now() + SESSION_DAYS * 86400000 }));
    return `${payload}.${sign(payload)}`;
  }

  function valid(token) {
    const [payload, signature] = String(token ?? '').split('.');
    if (!payload || !signature) return false;
    const expected = Buffer.from(sign(payload));
    const received = Buffer.from(signature);
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) return false;
    try { return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).exp > Date.now(); }
    catch { return false; }
  }

  function cookie(value, { secure, maxAge }) {
    return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  }

  return {
    enabled,
    authenticated: (req) => !enabled || valid(readCookie(req.headers.cookie, COOKIE)),

    // Returns the Set-Cookie value, or throws with status 401/429.
    login(attempt, { secure }) {
      if (!enabled) return null;
      const now = Date.now();
      failures = failures.filter((time) => now - time < FAILURE_WINDOW_MS);
      if (failures.length >= MAX_FAILURES) {
        throw Object.assign(new Error('Muitas tentativas incorretas. Aguarde 15 minutos e tente novamente.'), { status: 429 });
      }
      if (typeof attempt !== 'string' || !timingSafeEqual(digest(attempt), digest(password))) {
        failures.push(now);
        throw Object.assign(new Error('Senha incorreta.'), { status: 401 });
      }
      failures = [];
      return cookie(issue(), { secure, maxAge: SESSION_DAYS * 86400 });
    },

    logout: ({ secure }) => cookie('', { secure, maxAge: 0 }),
  };
}
