import { json, readJSON, writeJSON, wrap } from './_lib.js';

// Проверка настроек: откройте /api/health в браузере — увидите, что работает, а что нет.
async function handler() {
  const checks = [];
  const pw = process.env.ADMIN_PASSWORD || '';
  checks.push({
    name: 'Пароль фотографа (ADMIN_PASSWORD)', ok: pw.length >= 8,
    hint: !pw ? 'Не задан: Vercel → Settings → Environment Variables → добавить ADMIN_PASSWORD, затем Redeploy'
      : pw.length < 12 ? 'Работает, но короткий: лучше не меньше 12 символов' : null,
  });
  let blobOk = false, blobErr = '';
  try {
    await writeJSON('meta/health.json', { t: Date.now() });
    blobOk = !!(await readJSON('meta/health.json', true));
    if (!blobOk) blobErr = 'файл записан, но не читается';
  } catch (e) { blobErr = String((e && e.message) || e).slice(0, 160); }
  checks.push({
    name: 'Хранилище фото и заявок (Blob)', ok: blobOk,
    hint: blobOk ? null : 'Vercel → Storage → Blob (режим Private) должно быть подключено к проекту, затем Redeploy. Ответ: ' + blobErr,
  });
  const tg = !!(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
  checks.push({ name: 'Уведомления в Telegram (необязательно)', ok: true, optional: true, hint: tg ? 'включены' : 'выключены' });
  return json({ ok: checks.every((c) => c.ok), checks });
}
export default wrap(handler);
