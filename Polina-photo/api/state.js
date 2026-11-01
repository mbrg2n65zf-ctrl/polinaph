// GET  /api/state — каталог и фото для всех посетителей; раздел «Возвраты» (ref)
//                    и полный ответ отдаются только с токеном фотографа.
// POST /api/state — сохранение каталога/фото/документов/возвратов (только фотограф).
import { json, errJson, wrap, checkToken, readState, writeJSON, STATE_PATH, sanitizePub, sanitizeRef } from './_lib.js';

const handle = wrap(async req => {
  if (req.method === 'GET') {
    const authed = checkToken(req);
    const st = await readState();
    if (!st) return json({ pub: null, ref: [] }); // клиент подставит встроенные тарифы-заглушки
    const pub = { svc: st.svc, add: st.add, docs: st.docs, PH: st.PH };
    if (!authed) return json({ pub }); // раздел «Возвраты» — служебный, наружу не отдаём
    return json({ pub, ref: Array.isArray(st.ref) ? st.ref : [] });
  }

  if (req.method === 'POST') {
    if (!checkToken(req)) return errJson(401, 'Требуется вход фотографа');
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== 'object') return errJson(400, 'Некорректный запрос');
    const pub = sanitizePub(body.pub);
    if (!pub) return errJson(400, 'Некорректные данные каталога или фото — обновите страницу и попробуйте снова');
    const ref = sanitizeRef(body.ref);
    if (!ref) return errJson(400, 'Некорректные данные возвратов');
    await writeJSON(STATE_PATH, { ...pub, ref });
    return json({ ok: true });
  }

  return errJson(405, 'Метод не поддерживается');
});

export function GET(request) { return handle(request); }
export function POST(request) { return handle(request); }
