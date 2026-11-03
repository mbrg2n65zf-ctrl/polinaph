// GET /api/file?p=<путь> — раздача фото, фоновых видео и документов из приватного
// Blob-хранилища. Фото и видео публичны (портфолио и фон сайта), документы —
// юридические файлы для клиентов. Путь жёстко валидируется: только photos/…,
// videos/… и docs/… с разрешёнными расширениями.
import { errJson, wrap, blobGet, validPath, ctypeOf, isPhotoPath } from './_lib.js';

const handle = wrap(async req => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return errJson(405, 'Метод не поддерживается');

  const p = new URL(req.url).searchParams.get('p') || '';
  if (!validPath(p)) return errJson(400, 'Недопустимый путь файла');

  try {
    const buf = await blobGet(p); // фото/документы неизменяемы по своим путям — кэш разрешён
    const fname = p.split('/').pop();
    // Офисные документы отдаём как вложение (attachment), а не для показа в браузере:
    // их место — скачивание, и так исключён любой рендер содержимого в контексте сайта
    // (рекомендация аудита). PDF и медиа остаются inline: их показывают в окне.
    const ext = p.split('.').pop().toLowerCase();
    const disp = p.toLowerCase().startsWith('docs/') && ext !== 'pdf' ? 'attachment' : 'inline';
    return new Response(req.method === 'HEAD' ? null : buf, {
      status: 200,
      headers: {
        'Content-Type': ctypeOf(p),
        'Content-Length': String(buf.length),
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
        'Content-Disposition': `${disp}; filename="${fname}"`,
      },
    });
  } catch (e) {
    if (e && (e.status === 404 || /not\s*found|notfound|does\s*not\s*exist|nosuchkey/i.test(String((e && e.message) || e)))) {
      return errJson(404, 'Файл не найден');
    }
    throw e;
  }
});

export function GET(request) { return handle(request); }
export function HEAD(request) { return handle(request); }
