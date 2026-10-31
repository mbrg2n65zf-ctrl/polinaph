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

// Vercel Node.js functions передают IncomingMessage: req.headers — обычный объект,
// а не Fetch Headers. Поддерживаем оба формата.
export function getHeader(req, name) {
  const headers = req && req.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const value = headers[name.toLowerCase()] ?? headers[name];
  return Array.isArray(value) ? value[0] || '' : String(value || '');
}

// Чтение JSON как из Fetch Request, так и из Node.js/Vercel IncomingMessage.
export async function readRequestJSON(req) {
  if (typeof req.json === 'function') return req.json();
  if (req.body !== undefined) {
    if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) {
      return JSON.parse(String(req.body) || '{}');
    }
    return req.body || {};
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

export async function readRequestBuffer(req) {
  if (typeof req.arrayBuffer === 'function') return Buffer.from(await req.arrayBuffer());
  if (req.body !== undefined) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body);
    // Vercel может разобрать тело заранее; для бинарной загрузки нужен исходный поток.
    if (req.body && typeof req.body === 'object') {
      throw new Error('Бинарное тело запроса уже разобрано middleware');
    }
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function isAdmin(req) {
  const t = getHeader(req, 'authorization').replace(/^Bearer /i, '');
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
