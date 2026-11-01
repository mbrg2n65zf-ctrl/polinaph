// GET /api/orders — полный список заявок для админки (только с токеном фотографа).
import { json, errJson, wrap, checkToken, readOrders } from './_lib.js';

const handle = wrap(async req => {
  if (req.method !== 'GET') return errJson(405, 'Метод не поддерживается');
  if (!checkToken(req)) return errJson(401, 'Требуется вход фотографа');
  const orders = await readOrders();
  orders.sort((a, b) => (b.id || 0) - (a.id || 0)); // новые сверху
  // ключ k (доступ к заявке у клиента) наружу админке не нужен — вырезаем
  return json({ orders: orders.map(o => ({ ...o, k: undefined })) });
});

export function GET(request) { return handle(request); }
