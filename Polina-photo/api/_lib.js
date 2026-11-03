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
// TTL 7 дней: чем короче сессия, тем меньше окно у украденного токена
// (рекомендация аудита; вход повторяется раз в неделю — приемлемая цена).
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000;
// Ключ подписи токенов: отдельная переменная ADMIN_SECRET (рекомендация аудита).
// Если она не задана, используется производный ключ SHA-256 с доменной привязкой,
// но НИКОГДА не сам ADMIN_PASSWORD: пароль входа не должен одновременно быть
// HMAC-ключом. Смена схемы подписи делает старые токены недействительными —
// это же механизм принудительного выхода всех сессий (поменять секрет → все разлогинены).
const secretKey = () => {
  const s = process.env.ADMIN_SECRET;
  if (s) return s;
  const pw = process.env.ADMIN_PASSWORD || '';
  return pw ? createHash('sha256').update('photographer-tma:admin-session:' + pw).digest('hex') : '';
};
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

// ——— описание анонса: ограниченный HTML из визуального редактора ——————————————
// Фотограф форматирует описание в админке (жирный, курсив, подчёркивание,
// зачёркивание, списки, абзацы, ссылки). Наружу пропускается только эта простая
// разметка: скрипты, стили, обработчики событий, атрибуты и незнакомые теги
// удаляются, ссылки живут только на http(s):, mailto: и tel:. Функция
// идемпотентна (повторная очистка уже очищенного текста ничего не меняет),
// поэтому применяется и при сохранении, и при чтении состояния — записи,
// сохранённые старыми версиями сайта, тоже проходят через фильтр.
const RT_TAG = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', s: 's', strike: 's', del: 's', br: 'br', p: 'p', div: 'p', ul: 'ul', ol: 'ol', li: 'li', a: 'a' };
const RT_BLOCK = /<\s*(script|style|iframe|object|embed|svg|math|title|textarea|noscript|template)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const RT_AMP = /&(?![a-zA-Z]{2,8};|#[0-9]{1,7};|#x[0-9a-fA-F]{1,6};)/g;
const attrEsc = x => String(x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// обратная операция ровно для тех сущностей, что создаёт attrEsc, — чтобы
// повторная санитизация ссылки не удваивала экранирование «&» в адресе
const RT_UNESC = /&(amp|lt|gt|quot|#39);/gi;
const rtUnesc = x => x.replace(RT_UNESC, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" }[m.toLowerCase()]));
export function richText(v) {
  let s = String(v ?? '').slice(0, 20000);
  if (!s) return '';
  s = s.replace(RT_BLOCK, '').replace(/<!--[\s\S]*?-->/g, '');
  let out = '', i = 0;
  const putText = t => { out += t.replace(RT_AMP, '&amp;').replace(/[<>]/g, c => c === '<' ? '&lt;' : '&gt;').replace(/\r\n?|\n/g, '<br>'); };
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { putText(s.slice(i)); break; }
    putText(s.slice(i, lt));
    const gt = s.indexOf('>', lt + 1);
    if (gt < 0) { putText(s.slice(lt)); break; }
    const raw = s.slice(lt, gt + 1);
    // настоящий тег: <имя …>, </имя …>. Не похожее на тег («< b >» из обычного
    // текста) показываем как текст; настоящий, но запрещённый тег выбрасываем целиком
    const m = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>$/.exec(raw);
    if (!m) { putText(raw); i = gt + 1; continue; }
    const tag = RT_TAG[m[2].toLowerCase()];
    if (!tag) { i = gt + 1; continue; }
    if (m[1] === '/') out += '</' + tag + '>';
    else if (tag === 'br') out += '<br>';
    else if (tag === 'a') {
      const h = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(raw) || [];
      const href = rtUnesc(h[1] ?? h[2] ?? h[3] ?? '');
      const safe = /^(https?:\/\/|mailto:|tel:)/i.test(href.replace(/[\s\u0000-\u001F]+/g, ''));
      out += safe ? '<a href="' + attrEsc(href) + '">' : '<a>';
    } else out += '<' + tag + '>';
    i = gt + 1;
  }
  return out.slice(0, 6000);
}

// при чтении состояния: чистим описания анонсов и нормализуем настройки сайта
export async function readState() {
  const st = await readJSON(STATE_PATH, true);
  if (!st || typeof st !== 'object') return st;
  if (Array.isArray(st.ev)) st.ev = st.ev.map(e => {
    if (!e || typeof e !== 'object') return e;
    // фото анонса — массив id; старые записи с одиночным img мигрируют на месте
    const photos = Array.isArray(e.photos) && e.photos.length ? e.photos.map(String) : (e.img ? [String(e.img)] : []);
    // описание чистится richText() и при чтении: в Blob могли остаться записи,
    // сохранённые старой версией сайта без полной санитизации (Stored XSS)
    return { ...e, d: richText(e.d), photos, img: undefined };
  });
  const def = st.set && typeof st.set === 'object' ? asStr(st.set.def, 20) : '';
  st.set = { def: CITIES[def] ? def : '' }; // город первой страницы сайта
  return st;
}
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

// ——— константы: города фото дней, юридические документы ————————————————————
//     ДОЛЖНЫ совпадать с CITIES / DN / STUB в index.html — править синхронно! ———
export const CITIES = { msk: 'Москва', gel: 'Геленджик' };
export const DN = {
  contract: 'Договор оказания услуг',
  privacy: 'Политика обработки персональных данных',
  consent: 'Согласие на обработку персональных данных',
  terms: 'Пользовательское соглашение',
};
export const STUB = 'Текст предоставляет владелец проекта после проверки юристом. Здесь намеренно нет придуманных юридических условий.';
export const defaultDocs = () =>
  Object.fromEntries(Object.keys(DN).map(k => [k, [{ v: 1, d: nowRu(), t: STUB }]]));

// ——— валидация путей файлов (защита от path traversal) ——————————————————————
// Клиент создаёт только: photos/p<число>.jpg, videos/v<число>.<видео-расширение>
// и docs/d<число>.<разрешённое расширение>. Внутри каждой папки — свой набор
// расширений, кросс-подмена отсекается проверками типа содержимого при загрузке.
export const PATH_RE = /^(photos|docs|videos)\/[a-z0-9_-]{1,64}\.(jpg|pdf|doc|docx|odt|rtf|txt|mp4|webm|mov)$/i;
export const validPath = p => typeof p === 'string' && p.length <= 100 && PATH_RE.test(p);

const CONTENT_TYPES = {
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  odt: 'application/vnd.oasis.opendocument.text',
  rtf: 'application/rtf',
  txt: 'text/plain; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
};
export const ctypeOf = p => CONTENT_TYPES[String(p).split('.').pop().toLowerCase()] || 'application/octet-stream';
export const isPhotoPath = p => /^photos\//i.test(p);
export const isVideoPath = p => /^videos\//i.test(p);

// ——— санитизация анонсов/документов/фото, которые присылает админка ——————————
// Возвращает объект {ev, docs, PH} или null, если структура непригодна.
export function sanitizePub(pub) {
  if (!pub || typeof pub !== 'object') return null;
  if (!Array.isArray(pub.ev)) return null;
  if (!pub.docs || typeof pub.docs !== 'object' || !pub.PH || typeof pub.PH !== 'object') return null;

  // Анонсы фото дней: город строго из списка, даты задаёт фотограф —
  // клиент сможет выбрать запись только на эти даты (проверяется в order.js).
  // Описание — ограниченный HTML из визуального редактора, чистится richText().
  // photos — фотографии анонса (показываются слайдами между названием и описанием):
  // хранятся в photos/pN.jpg, в состоянии живёт массив id «p<число>» из общего
  // счётчика PH.q; одиночное img от предыдущей версии сайта мигрирует в photos.
  const phId = v => typeof v === 'string' && /^p\d{1,12}$/.test(v);
  const ev = pub.ev.slice(0, 100).map(e => {
    let photos = [...new Set((Array.isArray(e && e.photos) ? e.photos : []).filter(phId))].slice(0, 12);
    if (!photos.length && phId(e && e.img)) photos = [e.img];
    return {
      id: asInt(e && e.id) ?? 0,
      city: e && e.city === 'gel' ? 'gel' : 'msk',
      t: asStr(e && e.t, 120),
      d: richText(e && e.d),
      photos: [...new Set(photos)],
      dates: (Array.isArray(e && e.dates) ? e.dates : []).slice(0, 30).map(x => asStr(x, 40)).filter(Boolean),
      price: Math.max(0, asNum(e && e.price) ?? 0),
      old: e && e.old == null ? null : Math.max(0, asNum(e.old) ?? 0),
      pre: (() => { const n = asNum(e && e.pre); return n != null && n > 0 ? n : null; })(),
      on: !!(e && e.on),
    };
  }).filter(e => e.id > 0);

  // настройки сайта: какой город открывается первым при заходе (пусто — как раньше)
  const defCity = pub.set && typeof pub.set === 'object' ? asStr(pub.set.def, 20) : '';

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

  // идентификаторы фото/видео генерирует фронтенд как p<число> / v<число> —
  // жёсткий шаблон не даёт подсунуть в PH произвольные строки (те же p<число>
  // используются как photos у анонсов, счётчик общий)
  const s = Array.isArray(pub.PH.s) ? pub.PH.s.slice(0, 2000).map(p => ({
    id: phId(p && p.id) ? p.id : null,
    city: p && p.city === 'gel' ? 'gel' : 'msk',
  })).filter(p => p.id) : null;
  if (!s) return null;
  const video = pub.PH.video && typeof pub.PH.video === 'object' &&
    /^v\d{1,12}$/.test(String(pub.PH.video.id || '')) &&
    ['mp4', 'webm', 'mov'].includes(pub.PH.video.ext)
    ? { id: pub.PH.video.id, ext: pub.PH.video.ext } : null;

  // текст шапки главной страницы (надпись над именем, две строки имени, подзаголовок):
  // обычные строки без разметки, угловые скобки удаляются — клиент выводит их как текст.
  // Поле отсутствует, пока фотограф не отредактировал хотя бы одно из значений:
  // тогда клиент показывает стандартный текст.
  const bs = pub.PH.brand && typeof pub.PH.brand === 'object' && !Array.isArray(pub.PH.brand) ? pub.PH.brand : null;
  const plain = (v, max) => asStr(v, max).replace(/[<>]/g, '');
  const brand = bs ? {
    kicker: plain(bs.kicker, 60),
    n1: plain(bs.n1, 40),
    n2: plain(bs.n2, 40),
    sub: plain(bs.sub, 300),
  } : null;

  // ссылки на соцсети фотографа (кружки в шапке): только https-адреса домена
  // соответствующей сети (те же списки, что в клиенте, — править синхронно) и путь
  // из печатных ASCII-символов; всё непохожее отбрасывается, а не валит сохранение.
  const socIn = pub.PH.soc && typeof pub.PH.soc === 'object' && !Array.isArray(pub.PH.soc) ? pub.PH.soc : null;
  const SOC_HOSTS = {
    ig: ['instagram.com', 'instagr.am', 'ig.me'],
    tg: ['t.me', 'telegram.me', 'telegram.dog'],
    vk: ['vk.com', 'vk.ru', 'vkontakte.ru', 'vk.me'],
    mx: ['max.ru'],
    wa: ['wa.me', 'api.whatsapp.com', 'chat.whatsapp.com', 'whatsapp.com'],
  };
  const socOk = (k, v) => {
    if (typeof v !== 'string' || v.length > 200) return false;
    const m = v.match(/^https:\/\/([A-Za-z0-9.-]+)(:\d{2,5})?(\/[!-~]*)?$/);
    if (!m) return false;
    const host = m[1].toLowerCase().replace(/^www\./, '');
    if (!(SOC_HOSTS[k] || []).includes(host)) return false;
    if (k === 'wa' && host === 'wa.me' && !/^\/\d{6,15}(\?[!-~]*)?$/.test(m[3] || '')) return false;
    return true;
  };
  let soc = null;
  if (socIn) {
    const o = {};
    for (const k of ['ig', 'tg', 'vk', 'mx', 'wa']) {
      const v = String(socIn[k] ?? '').trim();
      if (v && socOk(k, v)) o[k] = v;
    }
    if (Object.keys(o).length) soc = o;
  }

  return { ev, docs, PH: { s, hero: phId(pub.PH.hero) ? pub.PH.hero : '', video, q: Math.min(1e12, asInt(pub.PH.q) ?? 1), ...(brand ? { brand } : {}), ...(soc ? { soc } : {}) }, set: { def: CITIES[defCity] ? defCity : '' } };
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
    evId: asInt(o && o.evId) ?? asInt(o && o.svcId) ?? 0,
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
    // окно доверия: не старше суток И не из будущего (допуск 60 с на расхождение часов)
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate > now + 60 || now - authDate > 86400) return null;
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
