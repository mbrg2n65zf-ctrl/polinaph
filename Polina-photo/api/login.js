import crypto from 'node:crypto';
import { json, makeToken } from './_lib.js';

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);
  const pw = process.env.ADMIN_PASSWORD;
  if (!pw) return json({ error: 'В настройках Vercel не задан ADMIN_PASSWORD' }, 500);
  let body = {};
  try { body = await req.json(); } catch (e) {}
  const a = Buffer.from(String(body.password || '')), b = Buffer.from(pw);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
  if (!ok) {
    await new Promise((r) => setTimeout(r, 800));
    return json({ error: 'Неверный пароль' }, 401);
  }
  return json({ token: makeToken() });
}
