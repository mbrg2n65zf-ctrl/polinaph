// POST /api/upload?p=<путь> — загрузка фото (photos/pN.jpg), фонового видео
// (videos/vN.mp4|webm) и редакций документов (docs/dN.<ext>). Только с токеном
// фотографа. Лимит Vercel — 4.5 МБ на тело запроса, поэтому жёсткий лимит 4 МБ
// (фронтенд сжимает фото до 1600 px, видео — короткий ролик до 3,5 МБ).
import { json, errJson, wrap, checkToken, blobPut, validPath, ctypeOf, isPhotoPath, isVideoPath } from './_lib.js';

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
  } else if (isVideoPath(p)) {
    const ext = p.split('.').pop().toLowerCase();
    if (!['mp4', 'webm', 'mov'].includes(ext)) return errJson(400, 'Видео должно быть MP4 или WebM');
    // проверяем сигнатуру контейнера, а не только расширение:
    // MP4/MOV — 'ftyp' в байтах 4–7, WebM/MKV — EBML-заголовок 0x1A45DFA3
    const isFtyp = buf.subarray(4, 8).toString('latin1') === 'ftyp';
    const isEbml = buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3;
    if (!isFtyp && !isEbml) return errJson(400, 'Файл не похож на видео');
  } else {
    const ext = p.split('.').pop().toLowerCase();
    if (!DOC_EXT.includes(ext)) return errJson(400, 'Недопустимый тип документа');
    if (ext === 'pdf' && buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return errJson(400, 'Файл не похож на PDF');
    }
    // Проверка структуры контейнера, а не только расширения (рекомендация аудита):
    // DOCX/ODT — это ZIP-архивы, DOC — OLE2-контейнер, RTF — текст с \rtf в начале.
    // Проверяем и локальный заголовок, и наличие центрального каталога ZIP (EOCD
    // в последних 64 КБ) — файл, обрезанный или с чужим содержимым, не пройдёт.
    const sig = (arr) => arr.every((b, i) => buf[i] === b);
    if (ext === 'docx' || ext === 'odt') {
      const zipStart = sig([0x50, 0x4B, 0x03, 0x04]); // "PK\x03\x04"
      const tail = buf.subarray(Math.max(0, buf.length - 65536));
      const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4B, 0x05, 0x06])); // EOCD
      if (!zipStart || eocd < 0) return errJson(400, 'Файл не похож на документ Office (это не ZIP-контейнер)');
    } else if (ext === 'doc') {
      if (!sig([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1])) return errJson(400, 'Файл не похож на документ Word');
    } else if (ext === 'rtf') {
      if (!buf.subarray(0, 5).toString('latin1').startsWith('{\\rtf')) return errJson(400, 'Файл не похож на RTF');
    }
  }

  await blobPut(p, buf, ctypeOf(p));
  return json({ ok: true });
});

export function POST(request) { return handle(request); }
