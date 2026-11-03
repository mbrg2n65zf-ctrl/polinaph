import { json, readJSON, writeJSON, wrap, checkToken, tbankToken, bankPost, tryJson } from './_lib.js';

// Проверка настроек. Наружу (без токена) отдаётся только общий статус ok:true/false —
// без деталей и подсказок, чтобы не раскрывать устройство проекта. Полный отчёт
// видит только вошедший фотограф: ссылка «Проверить настройки сервера» в подвале админки.
async function handler(req) {
  const checks = [];
  const pw = process.env.ADMIN_PASSWORD || '';
  checks.push({
    name: 'Пароль фотографа (ADMIN_PASSWORD)', ok: pw.length >= 8,
    hint: !pw ? 'Не задан: Vercel → Settings → Environment Variables → добавить ADMIN_PASSWORD, затем Redeploy'
      : pw.length < 12 ? 'Работает, но короткий: лучше не меньше 12 символов' : null,
  });
  let blobOk = false, blobErr = '';
  try {
    await writeJSON('meta/health.json', { t: Date.now() });
    blobOk = !!(await readJSON('meta/health.json', true));
    if (!blobOk) blobErr = 'файл записан, но не читается';
  } catch (e) { blobErr = String((e && e.message) || e).slice(0, 160); }
  checks.push({
    name: 'Хранилище фото и заявок (Blob)', ok: blobOk,
    hint: blobOk ? null : 'Vercel → Storage → Blob (режим Private) должно быть подключено к проекту, затем Redeploy. Ответ: ' + blobErr,
  });
  const bot = process.env.TELEGRAM_BOT_TOKEN || '';
  checks.push({
    name: 'Токен бота Telegram («Мои заказы» по аккаунту)', ok: !!bot,
    hint: bot ? null : 'Не задан: «Мои заказы» будут видны только на том устройстве, где оформлен заказ. Токен даёт @BotFather; добавить в Vercel → Settings → Environment Variables, затем Redeploy',
  });
  const chat = process.env.TELEGRAM_CHAT_ID || '';
  if (bot && chat) {
    // Живая проверка: реально отправляем тестовое сообщение. Фотограф получает его
    // в чате с ботом, а в отчёте появляется точная ошибка Telegram, если пара
    // «токен + chat id» не работает (неверный токен, чужой chat id, не нажат Start).
    let tgErr = '';
    try {
      const r = await fetch(`https://api.telegram.org/bot${bot}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text: '✅ Проверка связи: уведомления о заявках работают' }),
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json().catch(() => null);
      if (!(r.ok && j && j.ok === true)) tgErr = String((j && j.description) || 'HTTP ' + r.status).slice(0, 140);
    } catch (e) { tgErr = String((e && e.message) || e).slice(0, 140); }
    checks.push({
      name: 'Уведомления в Telegram (необязательно)', ok: !tgErr, optional: true,
      hint: tgErr
        ? 'не работают: ' + tgErr + (/chat not found/i.test(tgErr) ? ' — проверьте TELEGRAM_CHAT_ID и что вы нажали Start у бота' : (/401|unauthorized/i.test(tgErr) ? ' — похоже, TELEGRAM_BOT_TOKEN неверный' : ''))
        : 'включены — тестовое сообщение отправлено, посмотрите чат с ботом',
    });
  } else {
    checks.push({
      name: 'Уведомления в Telegram (необязательно)', ok: true, optional: true,
      hint: 'выключены: задайте в Vercel TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID, чтобы получать новые заявки в личку от бота, затем Redeploy',
    });
  }
  // Эквайринг Т-Банка. Без ключей — честная заглушка (здоровое состояние);
  // «наполовину» (одна переменная без второй) — неисправность: фотограф думает,
  // что оплату включил, а /api/pay молчит заглушкой. При заданных ключах делаем
  // живую пробу связи: GetState по заведомо несуществующему платежу. Запрос
  // безобиден (ничего не создаёт и не списывает), но проверяет сразу всё —
  // TLS-связь с банком (сертификат Минцифры), TerminalKey и пароль (подпись Token).
  const tk = process.env.TBANK_TERMINAL_KEY || '';
  const tpw = process.env.TBANK_TERMINAL_PASSWORD || '';
  if (tk && tpw) {
    const probe = { TerminalKey: tk, PaymentId: '0', Token: tbankToken({ TerminalKey: tk, PaymentId: '0' }, tpw) };
    let okAcq = false, hint = '';
    try {
      const r = await bankPost(process.env.TBANK_API_URL || 'https://securepay.tinkoff.ru/v2/GetState', probe, 8000);
      const j = tryJson(r.text) || {};
      const msg = ((j.Message || '') + ' ' + (j.Details || '')).trim();
      if (/подпис/i.test(msg)) {
        hint = 'банк отверг подпись запроса — пароль терминала (TBANK_TERMINAL_PASSWORD) не подходит, сверьте его с личным кабинетом эквайринга';
      } else if (/терминал/i.test(msg)) {
        hint = 'банк не знает такой TerminalKey — сверьте значение TBANK_TERMINAL_KEY с личным кабинетом эквайринга';
      } else if (j.Success === true || /не найд|транзакц|payment/i.test(msg)) {
        okAcq = true;
        hint = 'включён, связь с банком есть (терминал ' + tk.slice(0, 3) + '…) — ключи приняты, кнопка «Оплатить картой» создаёт платежи. Продублируйте NotificationURL /api/pay-webhook в личном кабинете эквайринга — без него не приходят статусы возвратов';
      } else {
        hint = 'неожиданный ответ банка: ' + (msg || 'HTTP ' + r.status).slice(0, 140);
      }
    } catch (e) {
      const code = String((e && (e.code || e.message)) || 'ошибка сети').slice(0, 100);
      hint = /cert|ssl|tls/i.test(code)
        ? 'сервер не доверяет сертификату банка (' + code + ') — на Vercel старые файлы проекта: залейте свежую версию, нужный корневой сертификат встроен начиная с этой сборки'
        : 'банк недоступен: ' + code;
    }
    checks.push({ name: 'Эквайринг Т-Банка — оплата картой (необязательно)', ok: okAcq, optional: true, hint });
  } else {
    checks.push({
      name: 'Эквайринг Т-Банка — оплата картой (необязательно)',
      ok: !tk && !tpw,
      optional: true,
      hint: tk || tpw
        ? 'настроен наполовину: задан только ' + (tk ? 'TerminalKey, пароль терминала отсутствует' : 'пароль терминала, TerminalKey отсутствует') + ' — оплата пока работает как заглушка. Добавьте вторую переменную в Vercel → Environment Variables, затем Redeploy'
        : 'не подключён: кнопка оплаты показывает посетителю «оплата скоро подключится», деньги не списываются. Чтобы принимать карты, задайте в Vercel TBANK_TERMINAL_KEY и TBANK_TERMINAL_PASSWORD, затем Redeploy',
    });
  }
  const ok = checks.every((c) => c.ok);
  if (!checkToken(req)) return json({ ok });
  return json({ ok, checks });
}
const handle = wrap(handler);

export function GET(request) { return handle(request); }
