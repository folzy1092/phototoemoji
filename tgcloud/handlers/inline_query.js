// handlers/inline_query.js — "@phototoemojibot" in any chat: pick one of your
// packs and send it as a picture made of its custom emoji.
// Needs inline mode turned on in @BotFather (/setinline).

import { db } from 'sdk';
import { api } from '../lib/premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { artMessage } from '../lib/emojipack.js';
import { addLink } from '../lib/pack.js';
import { tr } from '../lib/i18n.js';

const MAX_EMOJI = 100; // custom emoji per message

export default async function (query) {
  try {
    const T = await tr(query.from.id, query.from.language_code);
    const packs = await db.all(sql`SELECT id, set_name, cols, rows, title FROM jobs
      WHERE user_id = ${query.from.id} AND status = 'done' ORDER BY id DESC LIMIT 10`);
    const results = [];
    for (const p of packs) {
      let set;
      try {
        set = await api.getStickerSet({ name: p.set_name });
      } catch (_) {
        continue;
      }
      const rows = Math.max(1, Math.floor(MAX_EMOJI / p.cols));
      const art = artMessage(set.stickers.slice(0, rows * p.cols), p.cols);
      results.push({
        type: 'article',
        id: String(p.id),
        title: `${p.title || T('inline_pack')} · ${p.cols}×${p.rows}`,
        description: set.stickers.length > rows * p.cols ? T('inline_first_rows', rows, p.rows) : set.title,
        input_message_content: { message_text: art.text, entities: art.entities },
        reply_markup: { inline_keyboard: [[{ text: T('btn_add'), url: addLink(p.set_name) }]] },
      });
    }
    await api.answerInlineQuery({
      inline_query_id: query.id,
      results,
      cache_time: 5,
      is_personal: true,
      ...(results.length ? {} : { button: { text: T('inline_make'), start_parameter: 'inline' } }),
    });
  } catch (e) {
    console.error(e);
  }
}
