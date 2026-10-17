// 🎭 A regular sticker from a draft: the previewed framing (or banner), one
// side exactly 512 px, background removed if the draft has that on; a video
// draft makes a video sticker. Each user has one sticker set, created on their
// first sticker.

import { InputFile, BotApiError } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { call, getBotUsername, packTitle, framing } from './emojipack.js';
import { loadSource } from './source.js';
import { cropResize, removeBackground } from './image.js';
import { encodePng } from './png.js';
import { drawBanner } from './font.js';
import { videoStickerWebm } from './video.js';
import { log, link } from './log.js';

const SIDE = 512;

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

export async function makeSticker(job, user, T) {
  const bot = await getBotUsername();
  const name = stickerSetName(user.id, bot);
  const sticker = { ...(await stickerFile(job)), emoji_list: ['🧩'] };
  try {
    await call('addStickerToSet', { user_id: user.id, name, sticker });
  } catch (e) {
    if (!(e instanceof BotApiError) || !/STICKERSET_INVALID/i.test(e.description || '')) throw e;
    // First sticker: the set doesn't exist yet. (Title must not start with "@", see packTitle.)
    await call('createNewStickerSet', {
      user_id: user.id, name, title: packTitle(user, bot, 'Stickers'), sticker_type: 'regular', stickers: [sticker],
    });
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
    lines: [`Из черновика: <code>${job.id}</code> (${job.source})`, `Стикерпак: ${link(url, name)} · стикеров: ${set.stickers.length}`],
  });
}
