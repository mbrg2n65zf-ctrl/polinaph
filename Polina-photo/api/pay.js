// /api/pay — старт оплаты картой (эквайринг Т-Банка).
// POST {id, k} — клиент начинает оплату своей записи (секрет k — как у /api/order).
//
// РЕЖИМ ЗАГЛУШКИ: пока в переменных окружения Vercel не заданы TBANK_TERMINAL_KEY
// и TBANK_TERMINAL_PASSWORD, эндпоинт отвечает {stub:true} — фронт показывает
// «оплата скоро подключится», интерфейс уже готов. Когда ключи добавлены, этот же
// запрос создаёт платёж (POST /v2/Init — developer.tbank.ru/eacq/api/init) и
// возвращает {paymentURL} — платёжную форму открывает клиент.
// Статус оплаты приходит отдельно на /api/pay-webhook (NotificationURL): доверять
// финальному статусу можно только уведомлению с верной подписью Token.
import { json, errJson, wrap, asInt, readOrders, mutateOrders, rateLimit, clientIp, tbankToken, nowRu, notify, bankPost, tryJson, DN } from './_lib.js';

// Боевой домен по документации — securepay.tinkoff.ru (бренд Т-Банк, домен банка
// прежний). Тестовая среда: TBANK_API_URL=https://rest-api-test.tinkoff.ru/v2
// (потребуется внести IP сервера в белый список — см. README).
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
  // оплата только после принятия документов (договор, политика, согласие):
  // запись создаётся с acc на сервере, а заказы без согласий (созданные до
  // введения галочек) сначала проходят /api/order action:'accept'
  const accOk = Array.isArray(o.acc) && ['contract', 'privacy', 'consent'].every(dk => o.acc.some(a => a && a.doc === DN[dk]));
  if (!accOk) return errJson(400, 'Сначала подтвердите согласие с документами');
  // платим первый платёж, если фотограф его задал, иначе полную цену
  const amount = o.first != null && o.first > 0 ? o.first : o.total;
  if (!(amount > 0)) return errJson(400, 'Размер платежа определит фотограф — мы сообщим отдельно');

  const origin = new URL(req.url).origin;
  // OrderId должен быть уникальным для каждой операции (требование банка), поэтому
  // к номеру записи добавляем суффикс попытки; вебхук сопоставляет заявку по
  // ведущему числу. Повторное «Оплатить» создаёт новую попытку — прежняя просто
  // останется неоплаченной и истечёт сама.
  const orderId = id + '-' + Date.now().toString(36);
  const init = {
    TerminalKey: terminal,
    Amount: Math.round(amount * 100), // банк принимает сумму в копейках
    OrderId: orderId,
    Description: ('Фото день: ' + (o.svc || 'съёмка') + ', запись №' + id).slice(0, 140),
    // уведомление о статусе шлём на наш вебхук даже без настроек в ЛК банка
    NotificationURL: process.env.TBANK_NOTIFICATION_URL || origin + '/api/pay-webhook',
    SuccessURL: process.env.TBANK_SUCCESS_URL || origin + '/',
    FailURL: process.env.TBANK_FAIL_URL || origin + '/',
  };
  const payload = { ...init, Token: tbankToken(init, password) };
  // Запрос к банку идёт через bankPost: он доверяет УЦ Минцифры, чьим сертификатом
  // подписан securepay.tinkoff.ru. Обычный fetch на серверах Vercel падал с
  // SELF_SIGNED_CERT_IN_CHAIN — посетитель видел это как «Банк не отвечает».
  let resp;
  try {
    resp = await bankPost(process.env.TBANK_API_URL || 'https://securepay.tinkoff.ru/v2/Init', payload);
  } catch (e) {
    const code = String((e && (e.code || e.message)) || 'ошибка сети').slice(0, 100);
    notify('💳 Банк недоступен при создании платежа (заявка №' + id + '): ' + code).catch(() => {});
    return errJson(502, 'Банк не отвечает — попробуйте ещё раз через минуту');
  }
  const data = tryJson(resp.text);
  if (resp.status !== 200 || !data || !data.Success || !data.PaymentURL) {
    const detail = data && data.Message
      ? ' (' + String(data.Message).slice(0, 120) + (data.Details ? ': ' + String(data.Details).slice(0, 160) : '') + ')'
      : '';
    return errJson(502, 'Банк отклонил создание платежа' + detail);
  }

  // фиксируем PaymentId и OrderId попытки, чтобы сопоставлять вебхуки с заявкой;
  // сбой записи не должен мешать переходу на оплату — статус всё равно придёт вебхуком
  const payId = String(data.PaymentId || '');
  if (payId) await mutateOrders(list => {
    const x = list.find(y => y && y.id === id && y.k === k);
    if (!x) return null;
    x.payId = payId;
    x.payOrderId = orderId;
    x.pay = 'Ожидает оплаты (Т-Банк)';
    x.log = x.log || [];
    x.log.unshift(nowRu() + ' — Создан платёж в Т-Банке (PaymentId ' + payId + '), сумма ' + amount + ' ₽');
    return again => { const y = again.find(z => z && z.id === id && z.k === k); return !!y && y.payId === payId; };
  }).catch(() => {});

  notify(`💳 Создан платёж Т-Банка по заявке №${id} на ${amount} ₽`).catch(() => {});
  return json({ ok: true, paymentURL: String(data.PaymentURL) });
});

export function POST(request) { return handle(request); }
