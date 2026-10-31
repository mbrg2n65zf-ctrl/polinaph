import { get, put } from '@vercel/blob';
import crypto from 'node:crypto';

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });

const secret = () => process.env.ADMIN_PASSWORD || '';

// Токен администратора: срок действия + подпись, действует 12 часов
export function makeToken() {
  const exp = String(Date.now() + 12 * 3600 * 1000);
  const sig = crypto.createHmac('sha256', secret()).update(exp).digest('base64url');
  return exp + '.' + sig;
}

export function isAdmin(req) {
  const t = (req.headers.get('authorization') || '').replace(/^Bearer /, '');
  const [exp, sig] = t.split('.');
  if (!exp || !sig || !secret() || Date.now() > Number(exp)) return false;
  const ok = crypto.createHmac('sha256', secret()).update(exp).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(ok);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function readJSON(path, fresh = true) {
  try {
    const r = await get(path, { access: 'private', useCache: !fresh });
    if (!r || r.statusCode !== 200) return null;
    return JSON.parse(await new Response(r.stream).text());
  } catch (e) {
    return null;
  }
}

export const writeJSON = (path, obj) =>
  put(path, JSON.stringify(obj), {
    access: 'private',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 60,
  });
