import { json, isAdmin, readJSON, writeJSON, readRequestJSON } from './_lib.js';

// Общее состояние сайта: тарифы, допуслуги, документы, фото и главная.
// Читать может кто угодно, писать только фотограф.
export default async function handler(req) {
  if (req.method === 'GET') {
    const admin = isAdmin(req);
    const pub = await readJSON('state.json', admin);
    const out = { pub };
    if (admin) out.ref = (await readJSON('ref.json', true)) || [];
    return json(out);
  }
  if (req.method === 'POST') {
    if (!isAdmin(req)) return json({ error: 'Нужен вход фотографа' }, 401);
    let b;
    try { b = await readRequestJSON(req); } catch (e) { return json({ error: 'Некорректные данные' }, 400); }
    const p = b && b.pub;
    if (!p || !Array.isArray(p.svc) || !Array.isArray(p.add) || typeof p.docs !== 'object' || !p.PH)
      return json({ error: 'Некорректное состояние' }, 400);
    await writeJSON('state.json', { svc: p.svc, add: p.add, docs: p.docs, PH: p.PH, saved: Date.now() });
    if (Array.isArray(b.ref)) await writeJSON('ref.json', b.ref);
    return json({ ok: true });
  }
  return json({ error: 'Метод не поддерживается' }, 405);
}
