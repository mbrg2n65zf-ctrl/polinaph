// /api/order — работа с одной записью (заявкой).
// GET  ?id=  (секрет k — в заголовке X-Order-Key)
//                            — клиент читает свою запись по номеру и секретному ключу k.
// POST {action:'create'}   — клиент записывается на анонс фото дня (цена и даты —
//                            только серверные, из анонса; подменить нельзя).
// POST {action:'mine'}     — «мои записи» клиента по подписанному initData.
// POST {action:'admin'}    — сохранение правок записи (только токен фотографа).
// POST {action:'delete'}   — удаление заявок по списку id (только токен фотографа).
// Оплата вынесена в /api/pay (старт платежа) и /api/pay-webhook (уведомление банка).
import { json, errJson, wrap, asStr, asInt, asNum, checkToken, readState, readOrders, mutateOrders, rateLimit, clientIp,
         sanitizeOrder, publicOrder, DN, CITIES, defaultDocs, nowRu, verifyInitData, notify } from './_lib.js';
import { randomBytes } from 'node:crypto';

const K_RE = /^[a-f0-9]{32}$/;

const handle = wrap(async req => {
  const url = new URL(req.url);

  // ——— чтение заявки клиентом ————————————————————————————————————————————————
  if (req.method === 'GET') {
    // Секрет k передаётся в заголовке X-Order-Key, а не в query string: URL без
    // секрета не оседает в журналах сервера, истории браузера и аналитике
    // (рекомендация аудита). Клиент шлёт заголовок с того же источника.
    if (!rateLimit('ordget:' + clientIp(req), 60, 60 * 60 * 1000)) return errJson(429, 'Слишком много запросов — попробуйте позже');
    const id = asInt(url.searchParams.get('id'));
    const k = String(req.headers.get('x-order-key') || '');
    if (!id || !K_RE.test(k)) return errJson(400, 'Некорректная ссылка на заявку');
    const o = (await readOrders()).find(x => x.id === id && x.k === k);
    if (!o) return errJson(404, 'Заявка не найдена');
    return json({ ok: true, order: publicOrder(o) });
  }

  if (req.method !== 'POST') return errJson(405, 'Метод не поддерживается');

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== 'object' || !body.action) return errJson(400, 'Некорректный запрос');

  // ——— создание записи клиентом ——————————————————————————————————————————————
  // Клиент записывается на конкретный анонс фото дня: дату выбирает строго из
  // заданных фотографом (ev.dates), цену считает СЕРВЕР из анонса — подменить нельзя.
  if (body.action === 'create') {
    // приём записей открыт без пароля — ограничиваем частоту с одного IP (анти-спам);
    // 20/час хватает с запасом: живой клиент делает 1–3 заявки, а мобильные операторы
    // прячут много людей за одним адресом (аудит: прежние 120/час избыточны)
    if (!rateLimit('order:' + clientIp(req), 20, 60 * 60 * 1000)) return errJson(429, 'Слишком много записей с одного адреса — попробуйте позже');
    const o = (body.order && typeof body.order === 'object') ? body.order : {};
    const name = asStr(o.name, 120), contact = asStr(o.contact, 200),
          date = asStr(o.date, 40), time = asStr(o.time, 60), com = asStr(o.com, 2000);
    if (!name || !contact) return errJson(400, 'Заполните имя и контакт');
    if (o.accepted !== true) return errJson(400, 'Подтвердите согласие с документами');

    // анонсы берём из сохранённого состояния
    const st = await readState();
    const events = st && Array.isArray(st.ev) ? st.ev : [];
    const ev = events.find(e => e && e.id === asInt(o.evId) && e.on !== false);
    if (!ev) return errJson(400, 'Эта съёмка недоступна — обновите страницу и попробуйте снова');
    const evDates = Array.isArray(ev.dates) ? ev.dates : [];
    if (!evDates.includes(date)) return errJson(400, 'Выберите дату из предложенных — запись только на даты фото дня');
    // прошедшие фото дни уходят в архив автоматически. Фронт скрывает прошедшие
    // даты, но подстраховываемся и здесь: запись «в прошлое» не принимается
    // (время московское — same as nowRu; 'sv-SE' даёт формат YYYY-MM-DD)
    const dm = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
    if (dm) {
      const iso = dm[3] + '-' + dm[2] + '-' + dm[1];
      const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Moscow' });
      if (iso < today) return errJson(400, 'Эта дата уже прошла — выберите актуальную дату фото дня');
    }

    // версии юридических документов фиксируем на сервере в момент записи
    const docs = st && st.docs && typeof st.docs === 'object' ? st.docs : defaultDocs();
    const acc = ['contract', 'privacy', 'consent'].map(k => {
      const list = Array.isArray(docs[k]) ? docs[k] : [];
      const last = list[list.length - 1];
      return { doc: DN[k], ver: last ? (asInt(last.v) ?? 1) : 1, at: nowRu(), how: 'чекбокс в приложении' };
    });

    // атрибуция Telegram-пользователя (если запись пришла из мини-приложения)
    const user = verifyInitData(asStr(o.tg, 4096), process.env.TELEGRAM_BOT_TOKEN);

    const total = Math.max(0, asNum(ev.price) ?? 0);
    // предоплата засчитывается только когда она меньше полной цены (зеркалит логику книги записи)
    const preN = asNum(ev.pre);
    const first = preN != null && preN > 0 && preN < total ? preN : total;
    const city = CITIES[ev.city] || 'Москва';
    const orders = await readOrders();
    const id = orders.reduce((m, x) => Math.max(m, asInt(x && x.id) ?? 0), 0) + 1;
    const k = randomBytes(16).toString('hex');
    const order = {
      id, k,
      evId: ev.id, svc: asStr(ev.t, 120), cat: asStr(ev.city, 10),
      name, contact, date, time, city, com, ad: [],
      total, first, paid: 0,
      status: 'Ожидает оплаты', pay: 'Ожидает оплаты',
      note: '', cons: '', sum: '', alt: '', cdate: '',
      log: [nowRu() + ' — Запись на «' + asStr(ev.t, 120) + '» (' + city + ', ' + date + '); документы подтверждены (версии зафиксированы)' + (user ? '; запись из Telegram' : '')],
      acc, user,
    };

    await mutateOrders(list => {
      list.push(order);
      return again => again.some(x => x.k === k);
    });

    notify(
      `📷 Новая запись №${id} — ${order.svc}\n` +
      `Город: ${city}\nДата: ${date}${time ? ' ' + time : ''}\n` +
      `${name}\nКонтакт: ${contact}\n` +
      `Сумма: ${total} ₽${first !== total ? `, предоплата ${first} ₽` : ''}` +
      (com ? `\nКомментарий: ${com}` : '') +
      (user ? `\nTelegram: ${user.name || ''} ${user.username ? '@' + user.username : ''}` : '')
    ).catch(() => {});

    return json({ ok: true, order }); // order содержит k — клиент сохранит его для доступа к записи
  }

  // ——— «мои заявки» клиента: привязка к Telegram-аккаунту ————————————————————————————
  // Telegram подписывает initData при каждом открытии мини-приложения. Проверив
  // подпись, сервер уверен, что перед ним владелец аккаунта, и отдаёт только его
  // заявки — с любого устройства. Без валидной подписи список не выдаётся.
  if (body.action === 'mine') {
    if (!rateLimit('mine:' + clientIp(req), 60, 60 * 60 * 1000)) return errJson(429, 'Слишком много запросов — попробуйте позже');
    const user = verifyInitData(asStr(body.tg, 4096), process.env.TELEGRAM_BOT_TOKEN);
    if (!user || !user.id) return errJson(401, 'Не удалось подтвердить Telegram-аккаунт');
    const list = (await readOrders()).filter(o => o && o.user && o.user.id === user.id);
    return json({ ok: true, orders: list.map(publicOrder) });
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

  // ——— удаление заявок фотографом (одиночное и массовое) ———————————————————————————
  // Удалённая заявка исчезает и у клиента: «Мои заявки» строятся из этого же списка,
  // а прямое чтение по id+k отвечает 404 — клиент вычищает такой ярлык с устройства.
  if (body.action === 'delete') {
    if (!checkToken(req)) return errJson(401, 'Требуется вход фотографа');
    const ids = [...new Set((Array.isArray(body.ids) ? body.ids : []).map(asInt).filter(Boolean))].slice(0, 500);
    if (!ids.length) return errJson(400, 'Укажите номера заявок для удаления');
    const del = new Set(ids);
    let removed = 0;
    await mutateOrders(orders => {
      const keep = orders.filter(o => !del.has(asInt(o && o.id) ?? 0));
      removed = orders.length - keep.length;
      orders.splice(0, orders.length, ...keep);
      return again => again.length === keep.length;
    });
    return json({ ok: true, removed });
  }

  return errJson(400, 'Неизвестное действие');
});

export function GET(request) { return handle(request); }
export function POST(request) { return handle(request); }
