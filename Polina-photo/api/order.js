// /api/order — работа с одной заявкой.
// GET  ?id=&k=             — клиент читает свою заявку по номеру и секретному ключу k.
// POST {action:'create'}   — клиент создаёт заявку (цены считает СЕРВЕР по каталогу,
//                            клиент присылает только id тарифа и допуслуг — подменить нельзя).
// POST {action:'pay'}      — тестовая оплата по id + k.
// POST {action:'admin'}    — сохранение правок заявки (только токен фотографа).
import { json, errJson, wrap, asStr, asInt, checkToken, readState, readOrders, mutateOrders,
         sanitizeOrder, publicOrder, DN, S0, A0, defaultDocs, nowRu, verifyInitData, notify } from './_lib.js';
import { randomBytes } from 'node:crypto';

const K_RE = /^[a-f0-9]{32}$/;

const handle = wrap(async req => {
  const url = new URL(req.url);

  // ——— чтение заявки клиентом ————————————————————————————————————————————————
  if (req.method === 'GET') {
    const id = asInt(url.searchParams.get('id'));
    const k = String(url.searchParams.get('k') || '');
    if (!id || !K_RE.test(k)) return errJson(400, 'Некорректная ссылка на заявку');
    const o = (await readOrders()).find(x => x.id === id && x.k === k);
    if (!o) return errJson(404, 'Заявка не найдена');
    return json({ ok: true, order: publicOrder(o) });
  }

  if (req.method !== 'POST') return errJson(405, 'Метод не поддерживается');

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !body.action) return errJson(400, 'Некорректный запрос');

  // ——— создание заявки клиентом ——————————————————————————————————————————————
  if (body.action === 'create') {
    const o = (body.order && typeof body.order === 'object') ? body.order : {};
    const name = asStr(o.name, 120), contact = asStr(o.contact, 200),
          date = asStr(o.date, 40), time = asStr(o.time, 60),
          city = asStr(o.city, 120), com = asStr(o.com, 2000);
    if (!name || !contact || !date || !city) return errJson(400, 'Заполните обязательные поля заявки');

    // каталог берём из сохранённого состояния; если фотограф ещё не сохранял — встроенный резерв
    const st = await readState();
    const svcList = st && Array.isArray(st.svc) && st.svc.length ? st.svc : S0;
    const addList = st && Array.isArray(st.add) ? st.add : A0;
    const docs = st && st.docs && typeof st.docs === 'object' ? st.docs : defaultDocs();

    const svc = svcList.find(s => s && s.id === asInt(o.svcId) && s.on !== false);
    if (!svc) return errJson(400, 'Выбранный тариф недоступен — обновите страницу и попробуйте снова');

    const ad = (Array.isArray(o.adIds) ? o.adIds : []).map(asInt).filter(Boolean)
      .map(id => addList.find(a => a && a.id === id && a.cat === svc.cat && a.on !== false))
      .filter(Boolean)
      .map(a => ({ name: a.name, price: a.price == null ? Math.round((svc.full * (a.pct || 0)) / 100) : a.price }));
    const total = (svc.full || 0) + ad.reduce((s, x) => s + (x.price || 0), 0);
    const first = svc.first == null ? null : svc.first;

    // версии юридических документов фиксируем на сервере в момент заявки
    const acc = ['contract', 'privacy', 'consent'].map(k => {
      const list = Array.isArray(docs[k]) ? docs[k] : [];
      const last = list[list.length - 1];
      return { doc: DN[k], ver: last ? (asInt(last.v) ?? 1) : 1, at: nowRu(), how: 'чекбокс в приложении' };
    });

    // атрибуция Telegram-пользователя (если заявка пришла из мини-приложения)
    const user = verifyInitData(asStr(o.tg, 4096), process.env.TELEGRAM_BOT_TOKEN);

    const orders = await readOrders();
    const id = orders.reduce((m, x) => Math.max(m, asInt(x && x.id) ?? 0), 0) + 1;
    const k = randomBytes(16).toString('hex');
    const order = {
      id, k,
      svcId: svc.id, svc: asStr(svc.name, 120), cat: asStr(svc.cat, 20),
      name, contact, date, time, city, com, ad,
      total, first, paid: 0,
      status: 'Ожидает оплаты', pay: 'Ожидает оплаты',
      note: '', cons: '', sum: '', alt: '', cdate: '',
      log: [nowRu() + ' — Заявка создана; подтверждены документы (версии зафиксированы)' + (user ? '; заявка из Telegram' : '')],
      acc, user,
    };

    await mutateOrders(list => {
      list.push(order);
      return again => again.some(x => x.k === k);
    });

    notify(
      `📷 Новая заявка №${id} — ${order.svc}\n` +
      `Дата: ${date}${time ? ' ' + time : ''}\n` +
      `${name}, ${city}\nКонтакт: ${contact}\n` +
      `Сумма: ${total} ₽${first != null ? `, первый платёж ${first} ₽` : ''}` +
      (com ? `\nКомментарий: ${com}` : '') +
      (user ? `\nTelegram: ${user.name || ''} ${user.username ? '@' + user.username : ''}` : '')
    ).catch(() => {});

    return json({ ok: true, order }); // order содержит k — клиент сохранит его для доступа к заявке
  }

  // ——— «мои заявки» клиента: привязка к Telegram-аккаунту ————————————————————————————
  // Telegram подписывает initData при каждом открытии мини-приложения. Проверив
  // подпись, сервер уверен, что перед ним владелец аккаунта, и отдаёт только его
  // заявки — с любого устройства. Без валидной подписи список не выдаётся.
  if (body.action === 'mine') {
    const user = verifyInitData(asStr(body.tg, 4096), process.env.TELEGRAM_BOT_TOKEN);
    if (!user || !user.id) return errJson(401, 'Не удалось подтвердить Telegram-аккаунт');
    const list = (await readOrders()).filter(o => o && o.user && o.user.id === user.id);
    return json({ ok: true, orders: list.map(publicOrder) });
  }

  // ——— тестовая оплата клиентом (по id + секретному ключу) ——————————————————————
  if (body.action === 'pay') {
    const id = asInt(body.id);
    const k = String(body.k || '');
    if (!id || !K_RE.test(k)) return errJson(400, 'Некорректный запрос');
    let updated = null;
    await mutateOrders(orders => {
      const o = orders.find(x => x.id === id && x.k === k);
      if (!o) return null;
      if (o.status === 'Ожидает оплаты') {
        o.paid = o.first == null ? 0 : o.first;
        o.pay = 'Успешен (ТЕСТ)';
        o.status = 'Оплачен, ожидает консультации';
        o.log = o.log || [];
        o.log.unshift(nowRu() + ' — Тестовый платёж ' + (o.paid || 0) + ' ₽ — не реальные деньги');
      }
      updated = o;
      return again => again.some(x => x.id === id && x.k === k);
    });
    if (!updated) return errJson(404, 'Заявка не найдена');
    notify(`💳 Тестовый платёж по заявке №${id} (${updated.total || 0} ₽). Реальные деньги не списываются.`).catch(() => {});
    return json({ ok: true, order: publicOrder(updated) });
  }

  // ——— сохранение правок заявки админкой ————————————————————————————————————————
  if (body.action === 'admin') {
    if (!checkToken(req)) return errJson(401, 'Требуется вход фотографа');
    const inc = (body.order && typeof body.order === 'object') ? body.order : {};
    const id = asInt(inc.id);
    if (!id) return errJson(400, 'Некорректная заявка');
    await mutateOrders(orders => {
      const cur = orders.find(x => x.id === id);
      const norm = sanitizeOrder(inc, id, (cur && cur.k) || (K_RE.test(inc.k || '') ? inc.k : randomBytes(16).toString('hex')));
      if (cur) Object.assign(cur, norm);
      else orders.push(norm);
      return again => again.some(x => x.id === id);
    });
    return json({ ok: true });
  }

  return errJson(400, 'Неизвестное действие');
});

export function GET(request) { return handle(request); }
export function POST(request) { return handle(request); }
