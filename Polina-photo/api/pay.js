// /api/pay — старт оплаты картой (эквайринг Т-Банка).
// POST {id, k} — клиент начинает оплату своей записи (секрет k — как у /api/order).
//
// РЕЖИМ ЗАГЛУШКИ: пока в переменных окружения Vercel не заданы TBANK_TERMINAL_KEY
// и TBANK_TERMINAL_PASSWORD, эндпоинт отвечает {stub:true} — фронт показывает
// «оплата скоро подключится», интерфейс уже готов. Когда ключи добавлены, этот же
// запрос создаёт платёж в банке (POST https://securepay.tbank.ru/v2/Init) и
// возвращает {paymentURL} — платёжную форму открывает клиент.
// Статус оплаты приходит отдельно на /api/pay-webhook (NotificationURL в ЛК банка):
// доверять финальному статусу можно только уведомлению с верной подписью Token.
import { json, errJson, wrap, asInt, readOrders, mutateOrders, rateLimit, clientIp, tbankToken, nowRu, notify } from './_lib.js';

const INIT_URL = 'https://securepay.tbank.ru/v2/Init';
const K_RE = /^[a-f0-9]{32}$/;

const handle = wrap(async req => {
  if (req.method !== 'POST') return errJson(405, 'Метод не поддерживается');
  // анти-спам: каждая попытка создаёт запрос к банку и уведомление фотографу
  if (!rateLimit('acq:' + clientIp(req), 30, 60 * 60 * 1000)) return errJson(429, 'Слишком много попыток оплаты — попробуйте позже');
  const body = await req.json().catch(() => null);
  const id = asInt(body && body.id);
  const k = String((body && body.k) || '');
  if (!id || !K_RE.test(k)) return errJson(400, 'Некорректный запрос');

  const terminal = process.env.TBANK_TERMINAL_KEY || '';
  const password = process.env.TBANK_TERMINAL_PASSWORD || '';
  if (!terminal || !password) return json({ stub: true }); // ключей ещё нет — честная заглушка

  const o = (await readOrders()).find(x => x && x.id === id && x.k === k);
  if (!o) return errJson(404, 'Заявка не найдена');
  if (o.status !== 'Ожидает оплаты') return errJson(400, 'Запись уже оплачена или закрыта');
  // платим первый платёж, если фотограф его задал, иначе полную цену
  const amount = o.first != null && o.first > 0 ? o.first : o.total;
  if (!(amount > 0)) return errJson(400, 'Размер платежа определит фотограф — мы сообщим отдельно');

  const origin = new URL(req.url).origin;
  const init = {
    TerminalKey: terminal,
    Amount: Math.round(amount * 100), // банк принимает сумму в копейках
    OrderId: String(id), // повторный Init с тем же OrderId банк связывает с этим же платежом
    Description: ('Фото день: ' + (o.svc || 'съёмка') + ', запись №' + id).slice(0, 140),
    SuccessURL: process.env.TBANK_SUCCESS_URL || origin + '/',
    FailURL: process.env.TBANK_FAIL_URL || origin + '/',
  };
  const payload = { ...init, Token: tbankToken(init, password) };
  let resp;
  try {
    resp = await fetch(INIT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    return errJson(502, 'Банк не отвечает — попробуйте ещё раз через минуту');
  }
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || !data.Success || !data.PaymentURL) {
    const detail = data && data.Message
      ? ' (' + String(data.Message).slice(0, 120) + (data.Details ? ': ' + String(data.Details).slice(0, 160) : '') + ')'
      : '';
    return errJson(502, 'Банк отклонил создание платежа' + detail);
  }

  // фиксируем PaymentId, чтобы сопоставлять вебхуки с заявкой; сбой записи
  // не должен мешать переходу на оплату — статус всё равно придёт вебхуком
  const payId = String(data.PaymentId || '');
  if (payId) await mutateOrders(list => {
    const x = list.find(y => y && y.id === id && y.k === k);
    if (!x) return null;
    x.payId = payId;
    x.pay = 'Ожидает оплаты (Т-Банк)';
    x.log = x.log || [];
    x.log.unshift(nowRu() + ' — Создан платёж в Т-Банке (PaymentId ' + payId + '), сумма ' + amount + ' ₽');
    return again => { const y = again.find(z => z && z.id === id && z.k === k); return !!y && y.payId === payId; };
  }).catch(() => {});

  notify(`💳 Создан платёж Т-Банка по заявке №${id} на ${amount} ₽`).catch(() => {});
  return json({ ok: true, paymentURL: String(data.PaymentURL) });
});

export function POST(request) { return handle(request); }
