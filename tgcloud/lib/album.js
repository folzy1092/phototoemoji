// Albums: Telegram delivers each photo of a media group as its own update, and
// the runtime can't wait for the rest (no timers). So every photo is recorded,
// the first one posts a «🧩 Собрать коллаж» button, later ones update the
// count, and the collage is built from whatever arrived when it's pressed.

import { db } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { messageFileId } from './draft.js';
import { MAX_ALBUM } from './source.js';
import { tr } from './i18n.js';

async function count(groupId) {
  const r = await db.get(sql`SELECT count(*) AS n FROM album_items WHERE group_id = ${groupId}`);
  return Math.min(MAX_ALBUM, r ? r.n : 0);
}

export async function onAlbumPhoto(message) {
  const groupId = String(message.media_group_id);
  const user = message.from;
  const chatId = message.chat.id;
  const T = await tr(user.id, user.language_code);

  await db.run(sql`INSERT INTO album_items (group_id, file_id, msg_id)
    VALUES (${groupId}, ${messageFileId(message)}, ${message.message_id})
    ON CONFLICT(group_id, msg_id) DO NOTHING`);
  const lead = await db.run(sql`INSERT INTO albums (group_id, user_id, chat_id)
    VALUES (${groupId}, ${user.id}, ${chatId}) ON CONFLICT(group_id) DO NOTHING`);
  const keyboard = { inline_keyboard: [[{ text: T('btn_album'), callback_data: `alb:${groupId}` }]] };

  const edit = async (messageId, n) => {
    try {
      await api.editMessageText({ chat_id: chatId, message_id: messageId, text: T('album_got', n), reply_markup: keyboard });
    } catch (_) { /* "not modified" or a race with another photo */ }
  };

  if (lead.rowsAffected) {
    const n = await count(groupId);
    const sent = await api.sendMessage({
      chat_id: chatId,
      text: T('album_got', n),
      reply_markup: keyboard,
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    });
    await db.run(sql`UPDATE albums SET status_msg = ${sent.message_id} WHERE group_id = ${groupId}`);
    const now = await count(groupId);
    if (now !== n) await edit(sent.message_id, now);
    return;
  }
  const album = await db.get(sql`SELECT status_msg FROM albums WHERE group_id = ${groupId}`);
  if (album && album.status_msg) await edit(album.status_msg, await count(groupId));
}
