import crypto from 'node:crypto';
import { json, isAdmin, readJSON, writeJSON, readRequestJSON } from './_lib.js';

const clip = (v, n = 300) => String(v == null ? '' : v).slice(0, n).trim();
const stamp = () => new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });
const forClient = (o) => { const c = { ...o }; delete c.note; delete c.sum; return c; };

export default async function handler(req) {
  const url = new URL(req.url);

  // Клиент смотрит свою заявку: нужен номер и секретный ключ k
  if (req.method === 'GET') {
    const id = Number(url.searchParams.get('id')), k = url.searchParams.get('k') || '';
    const o = id ? await readJSON(`orders/${id}.json`, true) : null;
    if (!o || o.k !== k) return json({ error: 'Заявка не найдена' }, 404);
    return json({ order: forClient(o) });
  }
  if (req.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);

  let b;
  try { b = await readRequestJSON(req); } catch (e) { return json({ error: 'Некорректные данные' }, 400); }

  // Новая заявка: цены считаются на сервере по актуальным тарифам
  if (b.action === 'create') {
    const x = b.order || {};
    const state = await readJSON('state.json', true);
    const svcList = state ? state.svc : null;
    if (!svcList) return json({ error: 'Каталог ещё не опубликован фотографом' }, 409);
    const s = svcList.find((v) => v.id === Number(x.svcId) && v.on);
    if (!s) return json({ error: 'Эта услуга сейчас недоступна' }, 400);
    const name = clip(x.name), contact = clip(x.contact), date = clip(x.date, 40), city = clip(x.city);
    if (!name || !contact || !date || !city) return json({ error: 'Заполните обязательные поля' }, 400);
    if (x.accepted !== true) return json({ error: 'Нужно принять документы' }, 400);
    const ids = Array.isArray(x.adIds) ? x.adIds.map(Number) : [];
    const ad = state.add
      .filter((a) => a.on && a.cat === s.cat && ids.includes(a.id))
      .map((a) => ({ name: a.name, price: a.price == null ? Math.round((s.full * a.pct) / 100) : a.price }));
    const seq = (await readJSON('meta/seq.json', true)) || { n: 0 };
    seq.n += 1;
    await writeJSON('meta/seq.json', seq);
    const acc = ['contract', 'privacy', 'consent'].map((k) => ({
      doc: ({ contract: 'Договор оказания услуг', privacy: 'Политика обработки персональных данных', consent: 'Согласие на обработку персональных данных' })[k],
      ver: state.docs[k] ? state.docs[k].at(-1).v : 1,
      at: stamp(),
      how: 'чекбокс в приложении',
    }));
    const o = {
      id: seq.n, k: crypto.randomBytes(16).toString('hex'),
      name, contact, date, time: clip(x.time, 80), city, com: clip(x.com, 1000),
      svc: s.name, cat: s.cat, ad,
      total: s.full + ad.reduce((t, a) => t + a.price, 0), first: s.first,
      paid: 0, status: 'Ожидает оплаты', pay: 'Ожидает оплаты', note: '', acc,
      log: [stamp() + ' — Заявка создана; подтверждены документы (версии зафиксированы)'],
    };
    await writeJSON(`orders/${o.id}.json`, o);
    return json({ order: forClient(o) });
  }

  // Тестовая оплата своей заявки
  if (b.action === 'pay') {
    const o = await readJSON(`orders/${Number(b.id)}.json`, true);
    if (!o || o.k !== b.k) return json({ error: 'Заявка не найдена' }, 404);
    if (o.status !== 'Ожидает оплаты' || o.first == null) return json({ error: 'Оплата сейчас недоступна' }, 400);
    o.paid = o.first;
    o.pay = 'Успешен (ТЕСТ)';
    o.status = 'Оплачен, ожидает консультации';
    o.log.unshift(stamp() + ' — Тестовый платёж ' + o.first.toLocaleString('ru-RU') + ' ₽ — не реальные деньги');
    await writeJSON(`orders/${o.id}.json`, o);
    return json({ order: forClient(o) });
  }

  // Изменения от фотографа
  if (b.action === 'admin') {
    if (!isAdmin(req)) return json({ error: 'Нужен вход фотографа' }, 401);
    const n = b.order || {};
    const old = await readJSON(`orders/${Number(n.id)}.json`, true);
    if (!old) return json({ error: 'Заявка не найдена' }, 404);
    await writeJSON(`orders/${old.id}.json`, { ...n, id: old.id, k: old.k });
    return json({ ok: true });
  }
  return json({ error: 'Неизвестное действие' }, 400);
}
