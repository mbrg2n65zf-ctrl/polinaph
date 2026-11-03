// /api/pay-webhook — уведомление Т-Банка о статусе платежа (NotificationURL).
// Адрес передаётся в каждом запросе Init (origin + /api/pay-webhook) и может быть
// дополнительно указан в личном кабинете эквайринга.
//
// Банк присылает параметры платежа (OrderId, Amount в копейках, Status, Success,
// PaymentId …) и подпись Token — SHA-256 по алгоритму из tbankToken. Запрос без
// верной подписи отвергается: подделать «оплату» POST-запросом нельзя.
// Статус CONFIRMED переводит запись в «Оплачен, ожидает консультации».
// Формат тела — application/x-www-form-urlencoded (по умолчанию) либо JSON.
import { errJson, wrap, asInt, mutateOrders, nowRu, notify, tbankToken } from './_lib.js';

const handle = wrap(async req => {
  if (req.method !== 'POST') return errJson(405, 'Метод не поддерживается');
  const ct = req.headers.get('content-type') || '';
  let p;
  if (/json/i.test(ct)) p = await req.json().catch(() => null);
  else {
    const form = new URLSearchParams(await req.text().catch(() => ''));
    p = Object.fromEntries(form.entries());
  }
  if (!p || typeof p !== 'object') return errJson(403, 'Некорректное уведомление');

  const terminal = process.env.TBANK_TERMINAL_KEY || '';
  const password = process.env.TBANK_TERMINAL_PASSWORD || '';
  if (!terminal || !password) return errJson(503, 'Эквайринг не подключён');
  if (String(p.TerminalKey || '') !== terminal) return errJson(403, 'Уведомление чужого терминала');
  const token = String(p.Token || '');
  if (!/^[a-f0-9]{64}$/.test(token)) return errJson(403, 'Уведомление без подписи');
  if (tbankToken(p, password) !== token) return errJson(403, 'Подпись не совпала');

  // OrderId задаём сами при Init: строка вида «<номер записи>»; бережно берём
  // ведущее число на случай, если формат когда-нибудь расширят суффиксом
  const id = asInt((/^(\d+)/.exec(String(p.OrderId || '')) || [])[1]);
  const amount = Math.round((asInt(p.Amount) ?? 0) / 100); // копейки → рубли
  const confirmed = String(p.Status) === 'CONFIRMED' && String(p.Success) === 'true';

  if (id) await mutateOrders(list => {
    const o = list.find(x => x && x.id === id);
    if (!o) return null;
    o.log = o.log || [];
    if (confirmed && o.status === 'Ожидает оплаты') {
      o.paid = o.first != null && o.first > 0 ? o.first : amount;
      o.pay = 'Оплачен картой (Т-Банк, платёж №' + String(p.PaymentId || '—') + ')';
      o.status = 'Оплачен, ожидает консультации';
      o.log.unshift(nowRu() + ' — Оплата через эквайринг Т-Банка подтверждена: ' + amount + ' ₽');
    } else if (confirmed) {
      // повторное уведомление по уже оплаченной записи — ничего не меняем
      o.log.unshift(nowRu() + ' — Повторное уведомление Т-Банка: платёж уже учтён');
    } else {
      o.log.unshift(nowRu() + ' — Уведомление Т-Банка: статус «' + String(p.Status || '?') + '», оплата не завершена');
    }
    return again => again.some(x => x && x.id === id);
  }).catch(() => null);

  if (id && confirmed) notify(`💳 Оплата Т-Банка по заявке №${id}: ${amount} ₽ — подтверждена банком`).catch(() => {});
  // банк ждёт HTTP 200 и текст OK, иначе будет повторять уведомление
  return new Response('OK', { status: 200 });
});

export function POST(request) { return handle(request); }
