// api/_lib.js — общие помощники для всех функций API.
// Рантайм: Vercel Functions (Node.js), Web Request/Response, ESM
// (см. package.json "type": "module" — без него import в .js не работает).
import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { blobPut, blobGet } from './_blob.js';

export { blobPut, blobGet };

// ——— ответы ———————————————————————————————————————————————————————————————
export const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
export const errJson = (status, error) => json({ error }, status);

// wrap: любая необработанная ошибка превращается в JSON 500, а не в HTML-страницу,
// которую фронтенд не смог бы разобрать (api() ожидает JSON).
//
// ВАЖНО: каждый роут экспортирует именованные HTTP-методы (export function GET/POST/…),
// а НЕ default-функцию. Vercel запускает default как устаревший Node-обработчик
// (req, res) => void: там req.headers — обычный объект без .get(), а возврат Response
// игнорируется. Именованный экспорт метода гарантирует Web-стиль (Request → Response).
export const wrap = handler => async req => {
  try {
    return await handler(req);
  } catch (e) {
    console.error('[api] ошибка:', e);
    return errJson(500, 'Внутренняя ошибка сервера. Попробуйте ещё раз.');
  }
};

// ——— санитизация всего, что приходит снаружи ———————————————————————————————
export const asStr = (v, max) => String(v ?? '').trim().slice(0, max);
export const asNum = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
export const asInt = v => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : null; };
export const nowRu = () => new Date().toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' });

// ——— токен фотографа: "<срок_действия_ms>.<HMAC-подпись>" ———————————————————
// Фронтенд разбирает этот формат (проверяет срок по части до точки).
const TOKEN_TTL = 30 * 24 * 60 * 60 * 1000; // 30 дней
const secretKey = () => process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || '';
const tokenSig = exp => createHmac('sha256', secretKey()).update('t' + exp).digest('hex');
export const makeToken = () => {
  const exp = String(Date.now() + TOKEN_TTL);
  return exp + '.' + tokenSig(exp);
};
export const checkToken = req => {
  const m = /^Bearer\s+(\d{13,16}\.[a-f0-9]{64})$/.exec(req.headers.get('authorization') || '');
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  const expN = Number(exp);
  // слишком «далёкое будущее» тоже отвергаем: сервер такие подписи не выдаёт
  if (expN < Date.now() || expN > Date.now() + TOKEN_TTL + 60000) return false;
  const good = Buffer.from(tokenSig(exp), 'hex');
  const got = Buffer.from(sig, 'hex');
  return got.length === good.length && timingSafeEqual(got, good);
};

// ——— пароль: сравнение через хеши, чтобы не раскрывать длину/содержимое по времени ———
export const checkPassword = pw => {
  const real = process.env.ADMIN_PASSWORD || '';
  if (!real || typeof pw !== 'string') return false;
  const a = createHash('sha256').update(pw).digest();
  const b = createHash('sha256').update(real).digest();
  return timingSafeEqual(a, b);
};

// ——— ограничение частоты попыток входа (в памяти инстанса функции) ————————————
const tries = new Map();
export const rateLimit = (key, max = 10, windowMs = 5 * 60000) => {
  const t = Date.now();
  const list = (tries.get(key) || []).filter(x => t - x < windowMs);
  list.push(t);
  tries.set(key, list);
  if (tries.size > 10000) for (const [k, v] of tries) if (!v.some(x => t - x < windowMs)) tries.delete(k);
  return list.length <= max;
};
export const clientIp = req =>
  String(req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'unknown';

// ——— хранилище JSON-документов в Vercel Blob ————————————————————————————————
export const STATE_PATH = 'meta/state.json';
export const ORDERS_PATH = 'meta/orders.json';

export const readJSON = async (path, allowNull = false) => {
  try {
    const buf = await blobGet(path, { fresh: true }); // свежие данные обязательны для read-modify-write
    return JSON.parse(buf.toString('utf8'));
  } catch (e) {
    if (e && (e.status === 404 || /not\s*found|notfound|does\s*not\s*exist|nosuchkey/i.test(String((e && e.message) || e)))) {
      if (allowNull) return null;
      throw new Error('not found: ' + path);
    }
    throw e;
  }
};
export const writeJSON = (path, data) => blobPut(path, JSON.stringify(data), 'application/json; charset=utf-8');
export const readState = () => readJSON(STATE_PATH, true);
export const readOrders = async () => {
  const v = await readJSON(ORDERS_PATH, true);
  return Array.isArray(v) ? v : [];
};

// В Blob нет транзакций: читаем → меняем → пишем → перечитываем для проверки.
// При редкой гонке (две одновременные записи) — до 5 попыток с паузой.
export const mutateOrders = async mutate => {
  let lastErr;
  for (let i = 0; i < 5; i++) {
    try {
      const orders = await readOrders();
      const verify = mutate(orders) || (() => true);
      await writeJSON(ORDERS_PATH, orders);
      if (verify(await readOrders())) return true;
      lastErr = new Error('orders write conflict');
    } catch (e) {
      lastErr = e;
    }
    await new Promise(r => setTimeout(r, 80 + Math.floor(Math.random() * 200)));
  }
  throw lastErr || new Error('orders write failed');
};

// ——— константы каталога: резерв, если фотограф ещё ни разу не сохранял каталог.
//     ДОЛЖНЫ совпадать с S0 / A0 / DN / STUB в index.html — править синхронно! ———
export const DN = {
  contract: 'Договор оказания услуг',
  privacy: 'Политика обработки персональных данных',
  consent: 'Согласие на обработку персональных данных',
  terms: 'Пользовательское соглашение',
};
export const STUB = 'Текст предоставляет владелец проекта после проверки юристом. Здесь намеренно нет придуманных юридических условий.';
export const S0 = [
  ['ind', 'Мини', 'До 1 часа · до 25 фото · консультация и подбор локации', '2–3 недели', 20000, 5000],
  ['ind', 'Макси', 'До 2 часов · до 50 фото · консультация и подбор локации', '2–3 недели', 30000, 7000],
  ['ind', 'Съёмка ко дню рождения', 'До 1 часа · до 30 фото · видео в подарок', '3–5 дней', 20000, 5000],
  ['rep', 'Репортаж — 1 час', 'До 60 обработанных кадров за час', 'до 3 недель', 15000, null],
  ['rep', 'Репортаж — 4 часа', '4 часа', '—', 43000, null],
  ['rep', 'Репортаж — 6 часов', '6 часов', '—', 65000, null],
  ['rep', 'Репортаж — 8–10 часов', 'От 8 до 10 часов', '—', 75000, null],
  ['wed', 'ЗАГС и прогулка', 'До 1,5 часа · до 70 фото · консультация и подбор локаций', '4–5 недель', 27000, 7000],
  ['wed', 'Камерная свадьба', 'До 3 часов · до 150 фото · консультация и подбор локаций', '4–5 недель', 40000, 12000],
  ['wed', 'Полдня', 'До 6 часов · до 300 фото · консультация и подбор локаций', '4–5 недель', 60000, 18000],
  ['wed', 'Свадебный день', 'До 10 часов · до 500 фото · консультация и подбор локаций', '4–5 недель', 90000, 25000],
].map((a, i) => ({ id: i + 1, cat: a[0], name: a[1], desc: a[2], del: a[3], full: a[4], first: a[5], on: true }));
export const A0 = [
  ['ind', 'Дополнительный час', 15000],
  ['ind', 'Мини-видео', 8000],
  ['ind', 'Фотокнига', 10000],
  ['ind', 'Ускоренная отдача фотографий', 4000],
  ['wed', 'Дополнительный час', 12000],
  ['wed', 'Срочная обработка (+10% к пакету)', null],
  ['wed', 'Мини-видео', 12000],
  ['wed', 'Фотокнига', 10000],
].map((a, i) => ({ id: i + 1, cat: a[0], name: a[1], price: a[2], pct: a[2] == null ? 10 : 0, on: true }));
export const defaultDocs = () =>
  Object.fromEntries(Object.keys(DN).map(k => [k, [{ v: 1, d: nowRu(), t: STUB }]]));

// ——— валидация путей файлов (защита от path traversal) ——————————————————————
// Клиент создаёт только: photos/p<число>.jpg и docs/d<число>.<разрешённое расширение>
export const PATH_RE = /^(photos|docs)\/[a-z0-9_-]{1,64}\.(jpg|pdf|doc|docx|odt|rtf|txt)$/i;
export const validPath = p => typeof p === 'string' && p.length <= 100 && PATH_RE.test(p);

const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
};
export const ctypeOf = p => CONTENT_TYPES[String(p).split('.').pop().toLowerCase()] || 'application/octet-stream';
export const isPhotoPath = p => /^photos\//i.test(p);

// ——— санитизация каталога/документов/фото, которые присылает админка —————————
// Возвращает объект {svc, add, docs, PH} или null, если структура непригодна.
export function sanitizePub(pub) {
  if (!pub || typeof pub !== 'object') return null;
  if (!Array.isArray(pub.svc) || !Array.isArray(pub.add)) return null;
  if (!pub.docs || typeof pub.docs !== 'object' || !pub.PH || typeof pub.PH !== 'object') return null;

  const svc = pub.svc.slice(0, 100).map(s => ({
    id: asInt(s && s.id) ?? 0,
    cat: asStr(s && s.cat, 20),
    name: asStr(s && s.name, 120),
    desc: asStr(s && s.desc, 600),
    del: asStr(s && s.del, 60),
    full: Math.max(0, asNum(s && s.full) ?? 0),
    first: s && s.first == null ? null : Math.max(0, asNum(s.first) ?? 0),
    on: !!(s && s.on),
  })).filter(s => s.id > 0);

  const add = pub.add.slice(0, 100).map(a => ({
    id: asInt(a && a.id) ?? 0,
    cat: asStr(a && a.cat, 20),
    name: asStr(a && a.name, 120),
    price: a && a.price == null ? null : Math.max(0, asNum(a.price) ?? 0),
    pct: Math.min(100, Math.max(0, asNum(a && a.pct) ?? 0)),
    on: !(a && a.on === false),
  })).filter(a => a.id > 0);

  const docs = {};
  for (const k of Object.keys(DN)) {
    const list = Array.isArray(pub.docs[k]) ? pub.docs[k].slice(-50) : null;
    if (!list) return null;
    docs[k] = list.map((d, i) => ({
      v: asInt(d && d.v) ?? i + 1,
      d: asStr(d && d.d, 40),
      t: asStr(d && d.t, 50000),
      f: d && d.f && typeof d.f === 'object' ? {
        k: /^[a-z0-9_-]{1,40}$/.test(String(d.f.k || '')) ? d.f.k : '',
        n: asStr(d.f.n, 200),
        m: asStr(d.f.m, 100),
        s: asInt(d.f.s) ?? 0,
        p: validPath(d.f.p) ? d.f.p : undefined,
      } : undefined,
    }));
  }

  // идентификаторы фото/альбомов генерирует фронтенд как p<число> / a<число> —
  // жёсткий шаблон не даёт подсунуть в PH произвольные строки
  const phId = v => typeof v === 'string' && /^p\d{1,12}$/.test(v);
  const albId = v => typeof v === 'string' && /^a\d{1,12}$/.test(v);
  const s = Array.isArray(pub.PH.s) ? pub.PH.s.slice(0, 2000).map(p => ({
    id: phId(p && p.id) ? p.id : null,
    cat: asStr(p && p.cat, 20),
  })).filter(p => p.id) : null;
  const a = Array.isArray(pub.PH.a) ? pub.PH.a.slice(0, 200).map(al => ({
    id: albId(al && al.id) ? al.id : null,
    name: asStr(al && al.name, 120),
    sub: asStr(al && al.sub, 200),
    ph: Array.isArray(al && al.ph) ? al.ph.slice(0, 500).filter(phId) : [],
  })).filter(al => al.id) : null;
  const f = Array.isArray(pub.PH.f) ? pub.PH.f.slice(0, 200).filter(phId) : null;
  if (!s || !a || !f) return null;

  return { svc, add, docs, PH: { s, a, f, q: Math.min(1e12, asInt(pub.PH.q) ?? 1) } };
}

export function sanitizeRef(ref) {
  if (!Array.isArray(ref)) return null;
  return ref.slice(0, 500).map(r => ({
    id: asInt(r && r.id) ?? 0,
    oid: asInt(r && r.oid) ?? 0,
    by: asStr(r && r.by, 40),
    reason: asStr(r && r.reason, 600),
    st: asStr(r && r.st, 60),
    amt: asStr(r && r.amt, 20),
    note: asStr(r && r.note, 600),
  }));
}

// Заявка, присылаемая админкой: нормализуем поля, ключ k не даём менять.
export function sanitizeOrder(o, id, k) {
  return {
    id,
    k,
    svcId: asInt(o && o.svcId) ?? 0,
    svc: asStr(o && o.svc, 120),
    cat: asStr(o && o.cat, 20),
    name: asStr(o && o.name, 120),
    contact: asStr(o && o.contact, 200),
    date: asStr(o && o.date, 40),
    time: asStr(o && o.time, 60),
    city: asStr(o && o.city, 120),
    com: asStr(o && o.com, 2000),
    ad: (Array.isArray(o && o.ad) ? o.ad : []).slice(0, 50).map(x => ({
      name: asStr(x && x.name, 120),
      price: x && x.price == null ? null : Math.max(0, asNum(x.price) ?? 0),
    })),
    total: Math.max(0, asNum(o && o.total) ?? 0),
    first: o && o.first == null ? null : Math.max(0, asNum(o.first) ?? 0),
    paid: Math.max(0, asNum(o && o.paid) ?? 0),
    status: asStr(o && o.status, 80) || 'Ожидает оплаты',
    pay: asStr(o && o.pay, 120) || 'Ожидает оплаты',
    note: asStr(o && o.note, 2000),
    cons: asStr(o && o.cons, 40),
    sum: asStr(o && o.sum, 300),
    alt: asStr(o && o.alt, 40),
    cdate: asStr(o && o.cdate, 40),
    log: (Array.isArray(o && o.log) ? o.log : []).slice(0, 200).map(x => asStr(x, 300)),
    acc: (Array.isArray(o && o.acc) ? o.acc : []).slice(0, 20).map(x => ({
      doc: asStr(x && x.doc, 120),
      ver: asInt(x && x.ver) ?? 1,
      at: asStr(x && x.at, 40),
      how: asStr(x && x.how, 60),
    })),
    user: o && o.user && typeof o.user === 'object' ? {
      id: asInt(o.user.id) ?? 0,
      name: asStr(o.user.name, 120),
      username: asStr(o.user.username, 60),
    } : null,
  };
}

// Клиентская версия заявки: без служебной заметки фотографа (note — «скрыта от клиента»).
export const publicOrder = o => {
  const { note, ...rest } = o;
  return rest;
};

// ——— проверка подписи Telegram Mini App (initData) ————————————————————————
// Нужна только для атрибуции заявки пользователю Telegram; заявки принимаются и без неё.
export function verifyInitData(initData, botToken) {
  if (!initData || !botToken || typeof initData !== 'string') return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    params.delete('signature');
    const dcs = [...params.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
    const authDate = Number(params.get('auth_date'));
    if (!Number.isFinite(authDate) || Date.now() / 1000 - authDate > 86400) return null; // старше суток — не доверяем
    const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const calc = createHmac('sha256', secret).update(dcs).digest('hex');
    const good = Buffer.from(calc, 'hex');
    const got = Buffer.from(hash, 'hex');
    if (got.length !== good.length || !timingSafeEqual(got, good)) return null;
    const user = JSON.parse(params.get('user') || 'null');
    return user && user.id ? {
      id: user.id,
      name: [user.first_name, user.last_name].filter(Boolean).join(' ').slice(0, 120),
      username: String(user.username || '').slice(0, 60) || null,
    } : null;
  } catch (e) {
    return null;
  }
}

// ——— уведомление фотографу в Telegram (необязательно) ———————————————————————
export async function notify(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) return false;
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3500), disable_web_page_preview: true }),
      signal: AbortSignal.timeout(5000),
    });
    return r.ok;
  } catch (e) {
    return false; // уведомление не должно ломать приём заявки
  }
}
