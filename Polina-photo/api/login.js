// POST /api/login — вход фотографа по паролю из переменной окружения ADMIN_PASSWORD.
// Возвращает токен "<срок>.<подпись>", который фронтенд кладёт в localStorage
// и присылает в заголовке Authorization: Bearer.
import { json, errJson, wrap, checkPassword, checkToken, makeToken, rateLimit, clientIp, notify } from './_lib.js';

// Неудачные входы по IP: { n — попыток с прошлого уведомления, at — время уведомления }.
// В памяти экземпляра функции, мера приблизительная — это осознанный компромисс.
const failsByIp = new Map();

const handle = wrap(async req => {
  if (req.method !== 'POST') return errJson(405, 'Метод не поддерживается');
  if (!process.env.ADMIN_PASSWORD) {
    // нейтральный текст: не раскрываем посетителю, где размещён сайт и что настраивать
    return errJson(500, 'Вход временно недоступен: сервер не настроен (подробности в README, шаг 4)');
  }
  // уже вошедший с действующим токеном — просто подтверждаем
  if (checkToken(req)) return json({ ok: true, token: null });

  const ip = clientIp(req);
  if (!rateLimit('login:' + ip, 10, 5 * 60000)) {
    return errJson(429, 'Слишком много попыток входа. Подождите несколько минут.');
  }

  let body = null;
  try { body = await req.json(); } catch (e) { /* тело не JSON — обработаем как пустое */ }
  const pw = body && typeof body.password === 'string' ? body.password : '';
  if (!pw || pw.length > 200) return errJson(400, 'Введите пароль');

  // небольшая задержка замедляет перебор пароля
  await new Promise(r => setTimeout(r, 400));

  if (!checkPassword(pw)) {
    // Уведомление фотографу о подозрительной активности (рекомендация аудита):
    // считаем неудачи каждого IP отдельно; шлём не чаще раза в 15 минут и только
    // с 5-й попытки, чтобы не спамить из-за пары опечаток при вводе своего пароля.
    const f = failsByIp.get(ip) || { n: 0, at: 0 };
    f.n++;
    if (Date.now() - f.at > 15 * 60 * 1000 && f.n >= 5) {
      f.at = Date.now();
      f.n = 0;
      notify(`⚠️ Подозрительная активность: 5+ неверных попыток входа в админку с адреса ${ip}. Если это не вы — смените ADMIN_PASSWORD.`).catch(() => {});
    }
    failsByIp.set(ip, f);
    if (failsByIp.size > 1000) failsByIp.clear(); // защита памяти от множества адресов
    return errJson(401, 'Неверный пароль');
  }
  failsByIp.delete(ip); // верный пароль сбрасывает счётчик этого адреса
  return json({ ok: true, token: makeToken() });
});

export function POST(request) { return handle(request); }
