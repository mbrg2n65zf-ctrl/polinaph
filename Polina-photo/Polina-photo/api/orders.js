import { list } from '@vercel/blob';
import { json, isAdmin, readJSON } from './_lib.js';

// Список всех заявок: только для фотографа
export default async function handler(req) {
  if (!isAdmin(req)) return json({ error: 'Нужен вход фотографа' }, 401);
  const out = [];
  let cursor;
  do {
    const r = await list({ prefix: 'orders/', cursor, limit: 1000 });
    for (const b of r.blobs) {
      const o = await readJSON(b.pathname, true);
      if (o) out.push(o);
    }
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  out.sort((a, b) => b.id - a.id);
  return json({ orders: out });
}
