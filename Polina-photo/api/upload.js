import { put } from '@vercel/blob';
import { json, isAdmin } from './_lib.js';

const OK = /^(photos\/p\d+\.jpg|docs\/d\d+\.(pdf|docx?|odt|rtf|txt))$/i;
const MAX = 4.4 * 1024 * 1024; // лимит тела запроса на Vercel ~4,5 МБ

export default async function handler(req) {
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);
  if (!isAdmin(req)) return json({ error: 'Нужен вход фотографа' }, 401);
  const p = new URL(req.url).searchParams.get('p') || '';
  if (!OK.test(p)) return json({ error: 'Недопустимое имя файла' }, 400);
  const buf = await req.arrayBuffer();
  if (!buf.byteLength) return json({ error: 'Пустой файл' }, 400);
  if (buf.byteLength > MAX) return json({ error: 'Файл больше 4 МБ' }, 413);
  const ct = p.startsWith('photos/') ? 'image/jpeg' : req.headers.get('content-type') || 'application/octet-stream';
  await put(p, buf, { access: 'private', addRandomSuffix: false, allowOverwrite: true, contentType: ct, cacheControlMaxAge: 31536000 });
  return json({ ok: true, p });
}
