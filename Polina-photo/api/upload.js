// POST /api/upload?p=<путь> — загрузка фото (photos/pN.jpg) и редакций документов
// (docs/dN.<ext>). Только с токеном фотографа. Лимит Vercel — 4.5 МБ на тело
// запроса, поэтому здесь жёсткий лимит 4 МБ (фронтенд сжимает фото до 1600 px).
import { json, errJson, wrap, checkToken, blobPut, validPath, ctypeOf, isPhotoPath } from './_lib.js';

const MAX_UPLOAD = 4 * 1024 * 1024; // байт
const DOC_EXT = ['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt'];

const handle = wrap(async req => {
  if (req.method !== 'POST') return errJson(405, 'Метод не поддерживается');
  if (!checkToken(req)) return errJson(401, 'Требуется вход фотографа');

  const p = new URL(req.url).searchParams.get('p') || '';
  if (!validPath(p)) return errJson(400, 'Недопустимый путь файла');

  const len = Number(req.headers.get('content-length') || 0);
  if (len > MAX_UPLOAD) return errJson(413, 'Файл больше 4 МБ');
  const buf = Buffer.from(await req.arrayBuffer());
  if (!buf.length) return errJson(400, 'Пустой файл');
  if (buf.length > MAX_UPLOAD) return errJson(413, 'Файл больше 4 МБ');

  if (isPhotoPath(p)) {
    if (ctypeOf(p) !== 'image/jpeg') return errJson(400, 'Фото должно быть JPEG');
    // проверяем магические байты JPEG, а не только расширение
    if (buf[0] !== 0xFF || buf[1] !== 0xD8) return errJson(400, 'Файл не похож на JPEG');
  } else {
    const ext = p.split('.').pop().toLowerCase();
    if (!DOC_EXT.includes(ext)) return errJson(400, 'Недопустимый тип документа');
    if (ext === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return errJson(400, 'Файл не похож на PDF');
    }
  }

  await blobPut(p, buf, ctypeOf(p));
  return json({ ok: true });
});

export function POST(request) { return handle(request); }
