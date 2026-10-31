import { get } from '@vercel/blob';

const OK = /^(photos\/p\d+\.jpg|docs\/d\d+\.(pdf|docx?|odt|rtf|txt))$/i;

// Отдаёт только фото и документы. Заявки клиентов отсюда получить нельзя.
export default async function handler(req) {
  const p = new URL(req.url).searchParams.get('p') || '';
  if (!OK.test(p)) return new Response('Not found', { status: 404 });
  const r = await get(p, { access: 'private' });
  if (!r || r.statusCode !== 200) return new Response('Not found', { status: 404 });
  return new Response(r.stream, {
    headers: {
      'Content-Type': r.blob.contentType,
      'Content-Disposition': 'inline',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'public, max-age=31536000, immutable',
    },
  });
}
