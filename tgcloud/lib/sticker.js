// 🎭 A regular sticker from a draft: the previewed framing (or banner), one
// side exactly 512 px, background removed if the draft has that on; a video
// draft makes a video sticker. The 🎭 button asks where it goes: one of the
// user's sticker sets (table sticker_sets), a new numbered one, or a new one
// under a link the user types. Static and video stickers can share a set.

import { InputFile, BotApiError, db } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { call, getBotUsername, packTitle, framing, parseLink, setTaken, stickerSetNameN, LINK_MIN } from './emojipack.js';
import { loadSource } from './source.js';
import { cropResize, removeBackground } from './image.js';
import { encodePng } from './png.js';
import { drawBanner } from './font.js';
import { videoStickerWebm } from './video.js';
import { checkLimit, countUse, sendLimitHit } from './plan.js';
import { describeError } from './pack.js';
import { getSetting, setSetting, log, link, esc } from './log.js';

const SIDE = 512;
const INPUT_STICKER_LINK = 3; // jobs.await_title: the next text is the new set's link (lib/draft.js)

/** The first set every user got, before they could choose: "st<userId>_by_<bot>". */
export const stickerSetName = (userId, bot) => `st${userId}_by_${bot}`;

function fitSize(w, h) {
  const k = SIDE / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

// Exactly what the preview shows: the grid's proportions and the chosen
// framing (left/center/right, whole), not the whole source picture.
async function stickerPng(job) {
  const { w, h } = fitSize(job.cols, job.rows);
  if (job.source === 'text') return encodePng(drawBanner(job.text, job.color, w, h));
  let img = await loadSource(job);
  if (job.removeBg) img = removeBackground(img) || img;
  return encodePng(cropResize(img, w, h, framing(job)));
}

async function stickerFile(job) {
  if (job.source === 'video') {
    const { w, h } = fitSize(job.cols, job.rows);
    return { sticker: new InputFile(await videoStickerWebm(job, w, h), 'sticker.webm', { type: 'video/webm' }), format: 'video' };
  }
  return { sticker: new InputFile(await stickerPng(job), 'sticker.png', { type: 'image/png' }), format: 'static' };
}

// ---- the user's sticker sets ----

async function findSet(name) {
  try {
    return await api.getStickerSet({ name });
  } catch (e) {
    if (e instanceof BotApiError && e.code === 400) return null;
    throw e;
  }
}

/** Newest first. The original "st<userId>" set is added once, if it exists. */
async function userSets(user, bot) {
  const flag = `stset-legacy:${user.id}`;
  if (!(await getSetting(flag))) {
    const legacy = stickerSetName(user.id, bot);
    const set = await findSet(legacy);
    if (set) await db.run(sql`INSERT OR IGNORE INTO sticker_sets (name, user_id, title) VALUES (${legacy}, ${user.id}, ${'Stickers'})`);
    await setSetting(flag, '1');
  }
  return db.all(sql`SELECT * FROM sticker_sets WHERE user_id = ${user.id} ORDER BY id DESC LIMIT 6`);
}

const cut = (s, n = 26) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** «🎭»: ask which set the sticker goes to. */
export async function offerStickerTargets(job, user, T) {
  const bot = await getBotUsername();
  const sets = await userSets(user, bot);
  const b = (text, choice) => ({ text, callback_data: `sk:${job.id}:${choice}` });
  const keyboard = sets.map((s) => [b(`📁 ${cut(s.title || s.name.replace(/_by_.*$/, ''))}`, String(s.id))]);
  keyboard.push([b(T('btn_sk_new'), 'n')], [b(T('btn_sk_link'), 'l')], [b(T('btn_cancel'), 'x')]);
  return api.sendMessage({
    chat_id: job.chatId,
    text: T(sets.length ? 'sk_prompt' : 'sk_prompt_first'),
    reply_parameters: job.previewMsg ? { message_id: job.previewMsg, allow_sending_without_reply: true } : undefined,
    reply_markup: { inline_keyboard: keyboard },
  });
}

/** Button under that question: `sk:<job>:<set id> | n | l | x`. */
export async function onStickerChoice(query, job, choice, T) {
  const user = query.from;
  const answer = (text = undefined, alert = false) => api.answerCallbackQuery({ callback_query_id: query.id, text, show_alert: alert });
  const dropPrompt = async () => {
    if (!query.message) return;
    try { await api.deleteMessage({ chat_id: query.message.chat.id, message_id: query.message.message_id }); } catch (_) { /* ok */ }
  };
  if (choice === 'x') { await answer(); return dropPrompt(); }
  if (job.status !== 'draft') return answer(T('preview_stale'), true);

  if (choice === 'l') {
    await answer();
    await dropPrompt();
    await db.run(sql`UPDATE jobs SET await_title = (CASE WHEN id = ${job.id} THEN ${INPUT_STICKER_LINK} ELSE 0 END) WHERE user_id = ${user.id} AND status IN ('draft', 'done')`);
    const bot = await getBotUsername();
    return api.sendMessage({
      chat_id: job.chatId,
      text: T('sk_link_prompt', bot, 64 - 4 - bot.length),
      reply_markup: { force_reply: true, input_field_placeholder: T('link_placeholder') },
    });
  }

  let dest = { auto: true };
  if (choice !== 'n') {
    const row = await db.get(sql`SELECT * FROM sticker_sets WHERE id = ${Number(choice)} AND user_id = ${user.id}`);
    if (!row) return answer(T('sk_set_gone'), true);
    dest = { set: row };
  }
  const lim = await checkLimit(user.id, 'sticker');
  if (!lim.ok) {
    await answer();
    return sendLimitHit(job.chatId, 'sticker', lim.limit, T);
  }
  await answer(T('sticker_toast'));
  await dropPrompt();
  await countUse(user.id, 'sticker');
  return makeSticker(job, user, T, dest);
}

/** The text message with the link of a new sticker set. Returns true (consumed). */
export async function stickerFromLink(message, job, user, T) {
  const reply = (text) => api.sendMessage({ chat_id: message.chat.id, text });
  const stop = () => db.run(sql`UPDATE jobs SET await_title = 0 WHERE id = ${job.id}`);
  if (message.text.trim() === '-') {
    await stop();
    await reply(T('cancelled_toast'));
    return true;
  }
  const bot = await getBotUsername();
  const r = parseLink(message.text, bot);
  if (r.error) {
    await reply(T(`link_bad_${r.error}`, r.max, LINK_MIN));
    return true;
  }
  if (await setTaken(`${r.base}_by_${bot}`)) {
    await reply(T('link_taken', r.base));
    return true;
  }
  const lim = await checkLimit(user.id, 'sticker');
  await stop();
  if (!lim.ok) {
    await sendLimitHit(job.chatId, 'sticker', lim.limit, T);
    return true;
  }
  await countUse(user.id, 'sticker');
  try {
    await makeSticker(job, user, T, { create: `${r.base}_by_${bot}`, custom: job.title || r.base });
  } catch (e) {
    console.error(e);
    await reply(`❌ ${describeError(e, T.lang)}`);
  }
  return true;
}

// ---- making the sticker ----

async function createSet(user, name, title, sticker) {
  const bot = await getBotUsername();
  // The title must not start with "@", see packTitle.
  await call('createNewStickerSet', { user_id: user.id, name, title: packTitle(bot, title), sticker_type: 'regular', stickers: [sticker] });
  await db.run(sql`INSERT OR IGNORE INTO sticker_sets (name, user_id, title) VALUES (${name}, ${user.id}, ${title})`);
  return name;
}

/**
 * dest: { set } an existing row of sticker_sets · { create, custom } a new set
 * under that full name · { auto: true } a new numbered set.
 */
export async function makeSticker(job, user, T, dest) {
  const bot = await getBotUsername();
  const sticker = { ...(await stickerFile(job)), emoji_list: ['🧩'] };
  let name;
  if (dest.set) {
    name = dest.set.name;
    try {
      await call('addStickerToSet', { user_id: user.id, name, sticker });
    } catch (e) {
      if (e instanceof BotApiError && /STICKERSET_INVALID/i.test(e.description || '')) {
        await db.run(sql`DELETE FROM sticker_sets WHERE id = ${dest.set.id}`); // deleted in Telegram
        throw new Error('SET_GONE');
      }
      throw e;
    }
  } else if (dest.create) {
    name = await createSet(user, dest.create, dest.custom, sticker);
  } else {
    const had = await db.get(sql`SELECT COUNT(*) AS n FROM sticker_sets WHERE user_id = ${user.id}`);
    for (let i = 0; ; i++) {
      const n = had.n + 1 + i;
      const candidate = stickerSetNameN(user.id, n, bot);
      if (await setTaken(candidate)) continue;
      try {
        name = await createSet(user, candidate, `Stickers ${n}`, sticker);
        break;
      } catch (e) {
        // A deleted set can keep its name reserved: take the next number.
        const busy = e instanceof BotApiError && /SHORTNAME_OCCUPY_FAILED|already occupied/i.test(e.description || '');
        if (!busy || i >= 3) throw e;
      }
    }
  }
  const set = await call('getStickerSet', { name });
  const last = set.stickers[set.stickers.length - 1];
  const url = `https://t.me/addstickers/${name}`;
  await api.sendSticker({
    chat_id: job.chatId,
    sticker: last.file_id,
    reply_markup: { inline_keyboard: [[{ text: T('btn_add_stickers'), url }]] },
  });
  await api.sendMessage({ chat_id: job.chatId, text: T('sticker_done') });
  await log('🎭', 'Стикер создан', {
    user,
    lines: [
      `Из черновика: <code>${job.id}</code> (${job.source})`,
      `Стикерпак: ${link(url, name)} · стикеров: ${set.stickers.length}${dest.set ? ' · в существующий' : ''}`,
      dest.custom ? `Своя ссылка: <code>${esc(dest.create)}</code>` : null,
    ],
  });
}
