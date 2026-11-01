// api/_blob.js — единственное место, где проект говорит с Vercel Blob.
// Хранилище предполагается приватным (Private): файлы читаются только
// через наши функции. Если у вас публичный стор — задайте переменную
// окружения BLOB_ACCESS=public.
import { put, get } from '@vercel/blob';

const ACCESS = process.env.BLOB_ACCESS === 'public' ? 'public' : 'private';

// Запись: путь фиксированный (без случайного суффикса), перезапись разрешена —
// state.json и orders.json постоянно перезаписываются целиком.
export async function blobPut(path, body, contentType) {
  await put(path, body, {
    access: ACCESS,
    contentType,
    addRandomSuffix: false,
    allowOverwrite: true,
  });
}

// Чтение. fresh: true — гарантированно свежие данные (для meta/state.json и
// meta/orders.json, где важна согласованность read-modify-write).
// Возвращает Buffer или бросает ошибку с e.status = 404, если файла нет.
export async function blobGet(path, { fresh = false } = {}) {
  const result = await get(path, { access: ACCESS, useCache: !fresh });
  if (!result || result.statusCode !== 200 || !result.stream) {
    const e = new Error('blob not found: ' + path);
    e.status = 404;
    throw e;
  }
  const chunks = [];
  const reader = result.stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
