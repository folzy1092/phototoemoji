// Housekeeping, run opportunistically (there is no cron): at most once an hour,
// piggybacking on whatever message arrives.
//   - drafts nobody confirmed for a day -> expired (preview buttons removed)
//   - packs stuck "running" for a day   -> sticker set deleted, abandoned
//   - albums older than a day             -> forgotten

import { db, BotApiError } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { log } from './log.js';
import { tr } from './i18n.js';

const EVERY_S = 3600;
const STALE_S = 24 * 3600;

export async function maybeSweep() {
  try {
    const now = Math.floor(Date.now() / 1000);
    const claim = await db.run(sql`INSERT INTO settings (key, value) VALUES ('sweep_at', ${String(now)})
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE CAST(settings.value AS INTEGER) < ${now - EVERY_S}`);
    if (!claim.rowsAffected) return;
    const cutoff = now - STALE_S;

    const drafts = await db.all(sql`SELECT id, chat_id, preview_msg FROM jobs
      WHERE status = 'draft' AND created_at < ${cutoff} LIMIT 50`);
    for (const d of drafts) {
      await db.run(sql`UPDATE jobs SET status = 'expired', await_title = 0 WHERE id = ${d.id}`);
      if (d.preview_msg) {
        try {
          await api.editMessageReplyMarkup({ chat_id: d.chat_id, message_id: d.preview_msg, reply_markup: { inline_keyboard: [] } });
        } catch (_) { /* message may be gone */ }
      }
    }

    const stuck = await db.all(sql`SELECT id, user_id, chat_id, status_msg, set_name, cols, rows, done, append_to FROM jobs
      WHERE status = 'running' AND created_at < ${cutoff} AND lease_until < ${Date.now()} LIMIT 10`);
    for (const s of stuck) {
      // An unfinished extension shares its pack's set: never delete that.
      if (s.set_name && s.done > 0 && !s.append_to) {
        try {
          await api.deleteStickerSet({ name: s.set_name });
        } catch (e) {
          if (!(e instanceof BotApiError) || e.code !== 400) throw e;
        }
      }
      await db.run(sql`UPDATE jobs SET status = 'abandoned' WHERE id = ${s.id}`);
      if (s.status_msg) {
        const T = await tr(s.user_id);
        try {
          await api.editMessageText({
            chat_id: s.chat_id,
            message_id: s.status_msg,
            text: T('abandoned', s.cols, s.rows, s.done, s.cols * s.rows),
            reply_markup: { inline_keyboard: [] },
          });
        } catch (_) { /* ok */ }
      }
    }

    // Banner offers nobody pressed (value = "<unix time>\n<text>").
    await db.run(sql`DELETE FROM settings WHERE key LIKE 'suggest:%'
      AND CAST(substr(value, 1, instr(value, char(10)) - 1) AS INTEGER) < ${cutoff}`);

    // Albums whose collage button nobody pressed.
    await db.run(sql`DELETE FROM album_items WHERE group_id IN (SELECT group_id FROM albums WHERE created_at < ${cutoff})`);
    await db.run(sql`DELETE FROM albums WHERE created_at < ${cutoff}`);

    if (drafts.length || stuck.length) {
      await log('🧹', 'Очистка', {
        lines: [`Просроченных превью: ${drafts.length}`, `Брошенных паков удалено: ${stuck.length}`],
      });
    }
  } catch (e) {
    console.warn('sweep failed', e);
  }
}
