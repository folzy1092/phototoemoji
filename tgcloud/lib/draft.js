// Drafts: every source (photo, album collage, /text banner, video or GIF, a
// rebuilt or extended pack) first becomes a preview — the picture with the tile
// grid (for a video: an animation) —
// with buttons for its settings. Nothing is uploaded as stickers until the
// user presses «Создать» (and pays or uses a gift, for big packs).

import { db, InputFile, BotApiError } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { eq, sql } from 'sdk/db';
import { jobs } from '../schema.js';
import {
  parseCaption, fitGrid, autoRows, renderJob, packTitle, getBotUsername, priceFor,
  cleanTitle, parseLink, setTaken, LINK_MIN, MAX_TILES, MAX_COLS, FREE_TILES, PRICE_STARS, OWNER_ID,
} from './emojipack.js';
import { previewPng, trimmedAxis, removeBackground, telegramViewPng } from './image.js';
import { parseBanner, bannerGrid, bannerCols, COLORS } from './font.js';
import { loadSource, MAX_ALBUM } from './source.js';
import { startJob, getJob, describeError } from './pack.js';
import { offerStickerTargets, stickerFromLink } from './sticker.js';
import { videoOf, usableVariants, openClip, previewMp4, firstFrame } from './video.js';
import { log, logError, esc } from './log.js';
import { tr } from './i18n.js';
import { isPaidPlan, checkLimit, countUse, sendLimitHit, onProPaid, PRO_PRICE } from './plan.js';

const MAX_DOWNLOAD = 20 * 1024 * 1024;
const isImageDoc = (d) => d && /^image\/(jpeg|png)$/.test(d.mime_type || '');
export const isImageMessage = (m) => !!(m.photo || isImageDoc(m.document));

const CROP_KEY = {
  y: { start: 'crop_top', center: 'crop_center', end: 'crop_bottom', fit: 'crop_whole' },
  x: { start: 'crop_left', center: 'crop_center', end: 'crop_right', fit: 'crop_whole' },
};

export function messageFileId(message) {
  if (message.photo) return message.photo.reduce((a, b) => (a.width * a.height >= b.width * b.height ? a : b)).file_id;
  return message.document ? message.document.file_id : null;
}

// ---- appending to an existing pack ----

const packTotal = (j) => j.cols * j.rows + (j.extra || 0);

async function appendTarget(job) {
  if (!job.appendTo) return null;
  const t = await getJob(job.appendTo);
  return t && t.status === 'done' ? t : null;
}

/** Room left in the pack this draft extends (or the whole limit). */
async function tileLimit(job) {
  const t = await appendTarget(job);
  return t ? MAX_TILES - packTotal(t) : MAX_TILES;
}

/** users.pending = 'append:<id>' set from the pack menu; consumed by the next picture. */
async function takeAppendTarget(userId) {
  const row = await db.get(sql`SELECT pending FROM users WHERE id = ${userId}`);
  const m = row && /^append:(\d+)$/.exec(row.pending || '');
  if (!m) return null;
  await db.run(sql`UPDATE users SET pending = NULL WHERE id = ${userId}`);
  const t = await getJob(+m[1]);
  return t && t.userId === userId && t.status === 'done' && packTotal(t) < MAX_TILES ? t : null;
}

// ---- prices and gifts ----

/** Stars to pay for this draft (0 = free). Extending a paid/gifted pack is free. */
export async function priceForJob(job) {
  if (await isPaidPlan(job.userId)) return 0; // owner, VIP, Pro
  const t = await appendTarget(job);
  if (t) {
    if (t.paidStars || t.usedCredit) return 0;
    return packTotal(t) + job.cols * job.rows > FREE_TILES ? PRICE_STARS : 0;
  }
  return priceFor(job.cols * job.rows, job.userId);
}

async function creditsOf(userId) {
  const row = await db.get(sql`SELECT credits FROM users WHERE id = ${userId}`);
  return row ? row.credits : 0;
}

// ---- creating drafts ----

/**
 * Create a draft and send its preview.
 * fields: source settings ({ source, fileId | files | text, ...settings }).
 * Grid comes from fields.cols/rows, else from the caption, else from the picture.
 */
async function newDraft({ user, chatId, key, fields, replyTo = null, caption = null, allowAppend = true, logLines = [] }) {
  const T = await tr(user.id, user.language_code);
  const target = allowAppend ? await takeAppendTarget(user.id) : null;

  // A re-delivered update must not create a second draft.
  const claimed = await db.insert(jobs)
    .values({ key, userId: user.id, chatId, status: 'draft', source: fields.source || 'photo', fileId: fields.fileId || null })
    .onConflictDoNothing({ target: jobs.key })
    .returning({ id: jobs.id });
  if (!claimed.length) return;
  const jobId = claimed[0].id;
  const reply = replyTo ? { message_id: replyTo, allow_sending_without_reply: true } : undefined;

  const wait = await api.sendMessage({ chat_id: chatId, text: T(fields.source === 'video' ? 'preparing_video' : 'preparing'), reply_parameters: reply });
  try {
    const job = { ...fields, id: jobId, userId: user.id, chatId, crop: fields.crop || 'center', removeBg: fields.removeBg || 0, color: fields.color || 0 };
    const want = parseCaption(caption);
    // The grid width (if the caption sets it) picks which copy of a video to download.
    const clip = job.source === 'video' ? await openClip({ ...job, cols: job.cols || want.cols }) : null;
    const img = clip ? null : await loadSource(job);
    if (job.source !== 'text') {
      const size = clip ? clip.info : img;
      job.srcW = size.width;
      job.srcH = size.height;
      if (!job.cols) Object.assign(job, fitGrid(size.width, size.height, want));
    }
    if (want.title && !job.title) job.title = want.title;
    if (target) {
      job.appendTo = target.id;
      const room = MAX_TILES - packTotal(target);
      if (job.cols > room) { job.cols = room; job.rows = 1; }
      if (job.cols * job.rows > room) job.rows = Math.max(1, Math.floor(room / job.cols));
    }

    await db.update(jobs).set({
      fileId: job.fileId || null, files: job.files || null, text: job.text || null, color: job.color,
      srcW: job.srcW, srcH: job.srcH, cols: job.cols, rows: job.rows, crop: job.crop, removeBg: job.removeBg,
      title: job.title || null, appendTo: job.appendTo || null,
    }).where(eq(jobs.id, jobId));
    const saved = await getJob(jobId);

    const common = {
      chat_id: chatId,
      caption: await caption_(saved, user, T),
      reply_markup: { inline_keyboard: await keyboard(saved, T) },
      reply_parameters: reply,
    };
    const sent = clip
      ? await api.sendAnimation({ ...common, animation: new InputFile(previewMp4(clip, saved), 'preview.mp4', { type: 'video/mp4' }) })
      : await api.sendPhoto({ ...common, photo: new InputFile(renderPreview(img, saved), 'preview.png', { type: 'image/png' }) });
    await db.update(jobs).set({ previewMsg: sent.message_id }).where(eq(jobs.id, jobId));
    try { await api.deleteMessage({ chat_id: chatId, message_id: wait.message_id }); } catch (_) { /* ok */ }

    // No photo in the log: the result arrives as a pack link once it's built.
    await log(SOURCE_ICON[saved.source] || '🖼', target ? 'Дополнение пака' : 'Новый черновик', {
      user,
      lines: [
        `Черновик: <code>${jobId}</code> · ${saved.source}${saved.srcW && saved.source !== 'text' ? ` ${saved.srcW}×${saved.srcH}px` : ''}`,
        `Сетка: ${saved.cols}×${saved.rows} = ${saved.cols * saved.rows} эмодзи`,
        target ? `Дополняет пак: <code>${target.id}</code>` : null,
        ...logLines,
      ],
    });
  } catch (e) {
    console.error(e);
    await db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, jobId));
    try {
      await api.editMessageText({ chat_id: chatId, message_id: wait.message_id, text: `❌ ${describeError(e, T.lang)}` });
    } catch (_) { /* ok */ }
    await logError('Черновик не создан', { user, lines: [`Черновик: <code>${jobId}</code>`, esc(describeError(e))] });
  }
}

const SOURCE_ICON = { text: '🔤', album: '📚', video: '🎞' };

/** A video, GIF, round video or a video/GIF file: animated emoji. */
export async function createVideoDraft(message) {
  const user = message.from;
  const variants = videoOf(message);
  if (!usableVariants(variants).length && variants[0].size > MAX_DOWNLOAD) {
    const T = await tr(user.id, user.language_code);
    return api.sendMessage({ chat_id: message.chat.id, text: `❌ ${describeError(new Error('VIDEO_TOO_BIG'), T.lang)}` });
  }
  const kind = message.animation ? 'GIF' : message.video_note ? 'кружок' : message.video ? 'видео' : 'файл';
  return newDraft({
    user,
    chatId: message.chat.id,
    key: `${message.chat.id}:${message.message_id}`,
    fields: { source: 'video', fileId: variants[0].id, files: JSON.stringify(variants) },
    replyTo: message.message_id,
    caption: message.caption,
    logLines: [`Видео: ${kind}, копий: ${variants.length}`, message.caption ? `Подпись: <i>${esc(message.caption.slice(0, 200))}</i>` : null],
  });
}

/** A photo or an image document. */
export async function createDraft(message) {
  const user = message.from;
  if (message.document && message.document.file_size > MAX_DOWNLOAD) {
    const T = await tr(user.id, user.language_code);
    return api.sendMessage({ chat_id: message.chat.id, text: `❌ ${describeError(new Error('FILE_TOO_BIG'), T.lang)}` });
  }
  const fileId = messageFileId(message);
  return newDraft({
    user,
    chatId: message.chat.id,
    key: `${message.chat.id}:${message.message_id}`,
    fields: { source: 'photo', fileId },
    replyTo: message.message_id,
    caption: message.caption,
    logLines: [message.caption ? `Подпись: <i>${esc(message.caption.slice(0, 200))}</i>` : null],
  });
}

/** /text ПРИВЕТ */
export async function createTextDraft(message, raw) {
  const user = message.from;
  const T = await tr(user.id, user.language_code);
  const parsed = parseBanner(raw);
  const answer = (text) => api.sendMessage({ chat_id: message.chat.id, text });
  if (parsed.empty) return answer(T('text_usage'));
  if (parsed.bad) return answer(T('text_bad', parsed.bad));
  const grid = parsed.tooLong ? null : bannerGrid(raw, MAX_COLS, MAX_TILES);
  if (!grid) return answer(T('text_too_long'));
  const text = parsed.lines.join('\n');
  return newDraft({
    user,
    chatId: message.chat.id,
    key: `${message.chat.id}:${message.message_id}`,
    fields: { source: 'text', text, cols: grid.cols, rows: grid.rows, crop: 'fit', title: cleanTitle(parsed.lines.join(' ')) },
    replyTo: message.message_id,
    logLines: [`Текст: <code>${esc(text)}</code>`],
  });
}

/** «🧩 Собрать коллаж» under an album. */
export async function createAlbumDraft(query, groupId) {
  const user = query.from;
  const album = await db.get(sql`SELECT * FROM albums WHERE group_id = ${groupId}`);
  const T = await tr(user.id, user.language_code);
  if (!album || album.user_id !== user.id) {
    return api.answerCallbackQuery({ callback_query_id: query.id, text: T('album_missing'), show_alert: true });
  }
  const items = await db.all(sql`SELECT file_id FROM album_items WHERE group_id = ${groupId} ORDER BY msg_id LIMIT ${MAX_ALBUM}`);
  await api.answerCallbackQuery({ callback_query_id: query.id });
  if (query.message) {
    try {
      await api.editMessageReplyMarkup({ chat_id: query.message.chat.id, message_id: query.message.message_id, reply_markup: { inline_keyboard: [] } });
    } catch (_) { /* ok */ }
  }
  const ids = items.map((i) => i.file_id);
  return newDraft({
    user,
    chatId: album.chat_id,
    key: `album:${groupId}`,
    fields: ids.length === 1 ? { source: 'photo', fileId: ids[0] } : { source: 'album', files: JSON.stringify(ids) },
    replyTo: album.status_msg,
    logLines: [`Фото в коллаже: ${ids.length}`],
  });
}

/** 🔁 from the pack menu: a fresh draft with the same picture and settings. */
export async function rebuildDraft(query, job) {
  const fields = {
    source: job.source, fileId: job.fileId, files: job.files, text: job.text, color: job.color,
    cols: job.cols, rows: job.rows, crop: job.crop, removeBg: job.removeBg, title: job.title,
  };
  return newDraft({
    user: query.from,
    chatId: job.chatId,
    key: `rebuild:${job.id}:${Date.now()}`,
    fields,
    allowAppend: false,
    logLines: [`Пересборка пака <code>${job.id}</code>`],
  });
}

// ---- preview ----

function previewTile(job) {
  return Math.max(16, Math.min(100, Math.floor(1000 / Math.max(job.cols, job.rows))));
}

function renderPreview(img, job) {
  const tile = previewTile(job);
  return previewPng(renderJob(img, job, tile), job.cols, job.rows, tile);
}

async function caption_(job, user, T) {
  const tiles = job.cols * job.rows;
  const price = await priceForJob(job);
  const target = await appendTarget(job);
  const video = job.source === 'video';
  const lines = [T(video ? 'video_preview_head' : 'preview_head', job.cols, job.rows, tiles)];
  if (video) lines.push(T('video_clip_line'));
  if (target) lines.push(T('append_line', MAX_TILES - packTotal(target)));
  if (job.source !== 'text') {
    const trimmed = trimmedAxis(job.srcW, job.srcH, job.cols, job.rows);
    const crop = job.crop === 'fit' || trimmed ? T(CROP_KEY[trimmed || 'y'][job.crop]) : T('crop_none');
    lines.push(video ? T('video_frame_line', crop) : T('frame_line', crop, T(job.removeBg ? 'bg_removed' : 'bg_kept')));
  }
  if (!target) {
    lines.push(T('title_line', packTitle(await getBotUsername(), job.title)));
    if (job.linkName) lines.push(T('link_line', `t.me/addemoji/${job.linkName}_by_${await getBotUsername()}`));
  }
  lines.push(price ? T('price_paid', price, FREE_TILES) : T('price_free'), '', T('adjust_hint'));
  return lines.join('\n');
}

async function keyboard(job, T) {
  const id = job.id;
  const b = (text, action) => ({ text, callback_data: `s:${id}:${action}` });
  const mark = (crop, key) => (job.crop === crop ? `• ${T(key)}` : T(key));
  const rows = [];
  if (job.source === 'text') {
    rows.push([b('➖', 'r-'), b(T('btn_size', job.rows), 'n'), b('➕', 'r+')]);
    rows.push([b(T('btn_color', COLORS[job.color % COLORS.length][0]), 'col'), b(T('btn_title'), 't')]);
  } else {
    rows.push([b('➖', 'c-'), b(T('btn_cols', job.cols), 'n'), b('➕', 'c+')]);
    rows.push([b('➖', 'r-'), b(T('btn_rows', job.rows), 'n'), b('➕', 'r+')]);
    const axis = trimmedAxis(job.srcW, job.srcH, job.cols, job.rows);
    if (axis === 'y') rows.push([b(mark('start', 'btn_top'), 'k:start'), b(mark('center', 'btn_center'), 'k:center'), b(mark('end', 'btn_bottom'), 'k:end')]);
    if (axis === 'x') rows.push([b(mark('start', 'btn_left'), 'k:start'), b(mark('center', 'btn_center'), 'k:center'), b(mark('end', 'btn_right'), 'k:end')]);
    if (axis) rows.push([b(mark('fit', 'btn_fit'), 'k:fit')]);
    // No background removal for videos: a plain border color changes from frame to frame.
    const extra = [];
    if (job.source !== 'video') extra.push(b(T(job.removeBg ? 'btn_bg_on' : 'btn_bg_off'), 'bg'));
    if (!job.appendTo) extra.push(b(T('btn_title'), 't'));
    if (extra.length) rows.push(extra);
  }
  const target = await appendTarget(job);
  const destBtn = b(target ? T('btn_dest_in', destName(target)) : T('btn_dest_new'), 'd');
  rows.push(target ? [destBtn] : [destBtn, b(job.linkName ? T('btn_link_set', job.linkName) : T('btn_link'), job.linkName ? 'lx' : 'ln')]);
  rows.push([b(T('btn_view'), 'v'), b(T(job.source === 'video' ? 'btn_sticker_video' : 'btn_sticker'), 'st')]);
  const price = await priceForJob(job);
  const credits = price ? await creditsOf(job.userId) : 0;
  rows.push([b(!price ? T('btn_create') : credits ? T('btn_create_gift') : T('btn_create_paid', price), 'go')]);
  rows.push([b(T('btn_cancel'), 'x')]);
  return rows;
}

// ---- where the pack goes: a new one or one of the user's existing packs ----

/** A short name for a pack in buttons: its title, else its link without "_by_<bot>". */
const destName = (job) => {
  const n = job.title || String(job.setName || `#${job.id}`).replace(/_by_.*$/, '');
  return n.length > 22 ? `${n.slice(0, 21)}…` : n;
};

/** Packs of the user that still have room, newest first. */
async function packChoices(userId) {
  const rows = await db.all(sql`SELECT * FROM jobs
    WHERE user_id = ${userId} AND status = 'done' AND append_to IS NULL AND set_name IS NOT NULL AND cols * rows + extra < ${MAX_TILES}
    ORDER BY id DESC LIMIT 8`);
  return rows.map((r) => ({ id: r.id, title: r.title, setName: r.set_name, total: r.cols * r.rows + r.extra }));
}

async function destKeyboard(job, T) {
  const b = (text, action) => ({ text, callback_data: `s:${job.id}:${action}` });
  const rows = (await packChoices(job.userId)).map((p) => [b(`📦 ${destName(p)} · ${p.total}`, `dp${p.id}`)]);
  rows.unshift([b(`${job.appendTo ? '' : '• '}${T('btn_dest_choose_new')}`, 'dn')]);
  rows.push([b(T('btn_back'), 'db')]);
  return rows;
}

async function setMarkup(job, keyboard) {
  try {
    await api.editMessageReplyMarkup({ chat_id: job.chatId, message_id: job.previewMsg, reply_markup: { inline_keyboard: keyboard } });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
  }
}

// Quick presses edit one message at once; Telegram cancels the older edits.
const isEditRace = (e) => e instanceof BotApiError && /canceled by new edit message request|message is not modified/i.test(e.description || '');

async function refreshPreview(job, user, T) {
  const media = job.source === 'video'
    ? { type: 'animation', media: new InputFile(previewMp4(await openClip(job), job), 'preview.mp4', { type: 'video/mp4' }) }
    : { type: 'photo', media: new InputFile(renderPreview(await loadSource(job), job), 'preview.png', { type: 'image/png' }) };
  await api.editMessageMedia({
    chat_id: job.chatId,
    message_id: job.previewMsg,
    media: { ...media, caption: await caption_(job, user, T) },
    reply_markup: { inline_keyboard: await keyboard(job, T) },
  });
}

async function refreshCaption(job, user, T) {
  try {
    await api.editMessageCaption({
      chat_id: job.chatId,
      message_id: job.previewMsg,
      caption: await caption_(job, user, T),
      reply_markup: { inline_keyboard: await keyboard(job, T) },
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
  }
}

/** Ask for a title: for a draft (its preview updates) or a finished pack (rename). */
export const askTitle = (job, user, T) => askInput(job, user, T, INPUT_TITLE);

// jobs.await_title: what the next text message from the user is for.
export const INPUT_TITLE = 1;   // a title (draft) or a new title (finished pack)
export const INPUT_LINK = 2;    // the link of the new emoji pack
export const INPUT_STICKER_LINK = 3; // the link of a new sticker set (lib/sticker.js)

async function askInput(job, user, T, kind) {
  await db.run(sql`UPDATE jobs SET await_title = (CASE WHEN id = ${job.id} THEN ${kind} ELSE 0 END) WHERE user_id = ${user.id} AND status IN ('draft', 'done')`);
  const bot = await getBotUsername();
  return api.sendMessage({
    chat_id: job.chatId,
    text: kind === INPUT_LINK ? T('link_prompt', bot, 64 - 4 - bot.length) : T('title_prompt'),
    reply_markup: { force_reply: true, input_field_placeholder: T(kind === INPUT_LINK ? 'link_placeholder' : 'title_placeholder') },
  });
}

/** Button under a preview: `s:<id>:<action>`. */
export async function onDraftButton(query, job, action, attempt = 0) {
  const user = query.from;
  const T = await tr(job.userId, user.language_code);
  const answer = (text = undefined, alert = false) =>
    api.answerCallbackQuery({ callback_query_id: query.id, text, show_alert: alert });
  if (job.status !== 'draft') return answer(T('preview_stale'));

  const limit = await tileLimit(job);
  const next = { ...job };
  const pick = /^dp(\d+)$/.exec(action);
  if (pick) {
    const target = await getJob(+pick[1]);
    const room = target ? MAX_TILES - packTotal(target) : 0;
    if (!target || target.userId !== job.userId || target.status !== 'done' || target.appendTo || room < 1) return answer(T('dest_gone'), true);
    next.appendTo = target.id;
    next.linkName = null;
    // The new part must fit what's left of the pack.
    if (next.cols > room) { next.cols = room; next.rows = 1; }
    else if (next.cols * next.rows > room) next.rows = Math.max(1, Math.floor(room / next.cols));
  }
  switch (pick ? 'dp' : action) {
    case 'n': return answer();
    case 'd': {
      if (!(await packChoices(job.userId)).length && !job.appendTo) return answer(T('dest_none'), true);
      await answer();
      return setMarkup(job, await destKeyboard(job, T));
    }
    case 'db':
      await answer();
      return setMarkup(job, await keyboard(job, T));
    case 'dn':
      if (!job.appendTo) return answer();
      next.appendTo = null;
      break;
    case 'ln':
      await answer();
      return askInput(job, user, T, INPUT_LINK);
    case 'lx':
      next.linkName = null;
      break;
    case 'c+': case 'c-': {
      if (job.source === 'text') return answer();
      const cols = Math.min(MAX_COLS, Math.max(1, job.cols + (action === 'c+' ? 1 : -1)));
      if (cols === job.cols) return answer(cols === 1 ? T('min_reached') : T('max_cols', MAX_COLS));
      next.cols = cols;
      next.rows = Math.min(autoRows(job.srcW, job.srcH, cols), Math.max(1, Math.floor(limit / cols)));
      if (cols > limit) return answer(T('max_tiles', limit));
      break;
    }
    case 'r+': case 'r-': {
      const rows = job.rows + (action === 'r+' ? 1 : -1);
      if (rows < 1) return answer(T('min_reached'));
      if (job.source === 'text') {
        const cols = bannerCols(job.text, rows, 100, MAX_COLS);
        if (!cols || cols * rows > limit) return answer(T('text_wont_fit'));
        next.cols = cols;
      }
      if (next.cols * rows > limit) return answer(T('max_tiles', limit));
      next.rows = rows;
      break;
    }
    case 'k:start': case 'k:center': case 'k:end': case 'k:fit':
      next.crop = action.slice(2);
      if (next.crop === job.crop) return answer();
      break;
    case 'col':
      next.color = (job.color + 1) % COLORS.length;
      break;
    case 'bg':
      if (job.source === 'video') return answer();
      next.removeBg = job.removeBg ? 0 : 1;
      if (next.removeBg && !removeBackground(await loadSource(job))) return answer(T('no_bg'), true);
      break;
    case 't':
      await answer();
      return askTitle(job, user, T);
    case 'dp': break; // the pack was picked above
    case 'v': {
      await answer();
      const tile = Math.max(12, Math.min(64, Math.floor(700 / Math.max(job.cols, job.rows))));
      const video = job.source === 'video';
      const big = video ? firstFrame(await openClip(job), job, tile) : renderJob(await loadSource(job), job, tile);
      return api.sendPhoto({
        chat_id: job.chatId,
        photo: new InputFile(telegramViewPng(big, job.cols, job.rows, tile), 'telegram.png', { type: 'image/png' }),
        caption: T(video ? 'view_caption_video' : 'view_caption'),
        reply_parameters: { message_id: job.previewMsg, allow_sending_without_reply: true },
      });
    }
    case 'st':
      await answer();
      return offerStickerTargets(job, user, T);
    case 'go':
      return confirm(query, job, T);
    case 'x':
      await db.update(jobs).set({ status: 'expired', awaitTitle: 0 }).where(eq(jobs.id, job.id));
      await answer(T('cancelled_toast'));
      try {
        await api.editMessageCaption({ chat_id: job.chatId, message_id: job.previewMsg, caption: T('cancelled_caption'), reply_markup: { inline_keyboard: [] } });
      } catch (_) { /* ok */ }
      return;
    default:
      return answer();
  }

  // Apply on top of the revision this press was computed from; if another press
  // got in first, redo this one on the newer state (so no press is lost).
  const saved = await db.update(jobs)
    .set({
      cols: next.cols, rows: next.rows, crop: next.crop, removeBg: next.removeBg, color: next.color,
      appendTo: next.appendTo || null, linkName: next.linkName || null, rev: sql`rev + 1`,
    })
    .where(sql`id = ${job.id} AND rev = ${job.rev} AND status = 'draft'`)
    .returning({ id: jobs.id });
  if (!saved.length) {
    if (attempt >= 4) return answer(T('updating'));
    return onDraftButton(query, await getJob(job.id), action, attempt + 1);
  }
  await answer(T('updating'));
  await syncPreview(job.id, job.rev + 1, user, T);
}

/**
 * Show the draft as it is now. A press only renders if no newer press has
 * been saved (that one renders instead); after rendering, check again, in
 * case a newer press landed while this picture was on its way.
 */
async function syncPreview(jobId, rev, user, T) {
  const cur = await getJob(jobId);
  if (!cur || cur.status !== 'draft' || cur.rev !== rev) return;
  try {
    await refreshPreview(cur, user, T);
  } catch (e) {
    if (isEditRace(e)) return; // a newer edit took over
    throw e;
  }
  if (cur.source === 'video') return; // too heavy to render twice in one invocation
  const after = await getJob(jobId);
  if (after.status === 'draft' && after.rev !== rev) {
    try { await refreshPreview(after, user, T); } catch (e) { if (!isEditRace(e)) throw e; }
  }
}

/** A text message while a draft or pack waits for a title or a link. Returns true if consumed. */
export async function maybeSetTitle(message) {
  const job = await db.select().from(jobs)
    .where(sql`user_id = ${message.from.id} AND status IN ('draft', 'done') AND await_title IN (1, 2, 3)`)
    .get();
  if (!job) return false;
  const user = message.from;
  const T = await tr(job.userId, user.language_code);
  if (job.awaitTitle === INPUT_LINK) return setLink(message, job, user, T);
  if (job.awaitTitle === INPUT_STICKER_LINK) return stickerFromLink(message, job, user, T);
  const title = message.text.trim() === '-' ? null : cleanTitle(message.text);
  await db.update(jobs).set({ title, awaitTitle: 0 }).where(eq(jobs.id, job.id));

  if (job.status === 'done') {
    const full = packTitle(await getBotUsername(), title);
    await api.setStickerSetTitle({ name: job.setName, title: full });
    await api.sendMessage({ chat_id: message.chat.id, text: T('renamed', full) });
    await log('✏️', 'Пак переименован', { user, lines: [`Пак: <code>${job.id}</code>`, `Название: ${esc(full)}`] });
    return true;
  }
  await refreshCaption(await getJob(job.id), user, T);
  await api.sendMessage({
    chat_id: message.chat.id,
    text: title ? T('title_set', title) : T('title_removed'),
    reply_parameters: job.previewMsg ? { message_id: job.previewMsg, allow_sending_without_reply: true } : undefined,
  });
  await log('✏️', 'Название пака', { user, lines: [`Черновик: <code>${job.id}</code>`, `Название: ${esc(title || '—')}`] });
  return true;
}

/**
 * The link for a new emoji pack, typed by the user. A bad or taken one keeps
 * waiting for another; "-" drops a link that was set.
 */
async function setLink(message, job, user, T) {
  const reply = (text) => api.sendMessage({
    chat_id: message.chat.id,
    text,
    reply_parameters: job.previewMsg ? { message_id: job.previewMsg, allow_sending_without_reply: true } : undefined,
  });
  const bot = await getBotUsername();
  let base = null;
  if (message.text.trim() !== '-') {
    const r = parseLink(message.text, bot);
    if (r.error) {
      await reply(T(`link_bad_${r.error}`, r.max, LINK_MIN));
      return true;
    }
    if (await setTaken(`${r.base}_by_${bot}`)) {
      await reply(T('link_taken', r.base));
      return true;
    }
    base = r.base;
  }
  await db.update(jobs).set({ linkName: base, awaitTitle: 0, rev: sql`rev + 1` }).where(eq(jobs.id, job.id));
  await refreshCaption(await getJob(job.id), user, T);
  await reply(base ? T('link_set', `t.me/addemoji/${base}_by_${bot}`) : T('link_removed'));
  await log('🔗', 'Ссылка пака', { user, lines: [`Черновик: <code>${job.id}</code>`, `Ссылка: <code>${esc(base || '—')}</code>`] });
  return true;
}

// ---- «Создать», gifts and Telegram Stars ----

const payload = (job, price) => `pack:${job.id}:${job.cols}x${job.rows}:${price}`;

async function confirm(query, job, T) {
  // A chosen link may have been taken since it was checked.
  const bot = await getBotUsername();
  if (job.linkName && !job.appendTo && (await setTaken(`${job.linkName}_by_${bot}`))) {
    await db.update(jobs).set({ linkName: null, rev: sql`rev + 1` }).where(eq(jobs.id, job.id));
    await api.answerCallbackQuery({ callback_query_id: query.id, text: T('link_taken_now', job.linkName), show_alert: true });
    return syncPreview(job.id, job.rev + 1, query.from, T);
  }
  const price = await priceForJob(job);
  if (price && !job.paidStars && !job.usedCredit) {
    // A gift (referrals, /gift) covers it.
    const used = await db.run(sql`UPDATE users SET credits = credits - 1 WHERE id = ${job.userId} AND credits > 0`);
    if (used.rowsAffected) {
      await db.update(jobs).set({ usedCredit: 1 }).where(eq(jobs.id, job.id));
      await api.answerCallbackQuery({ callback_query_id: query.id, text: T('gift_used', await creditsOf(job.userId)) });
      await log('🎁', 'Подарок использован', { user: query.from, lines: [`Пак: <code>${job.id}</code> · ${job.cols}×${job.rows}`] });
      return startJob({ ...job, usedCredit: 1 }, query.from);
    }
    await api.answerCallbackQuery({ callback_query_id: query.id });
    await api.sendInvoice({
      chat_id: job.chatId,
      title: T('invoice_title', job.cols, job.rows),
      description: T('invoice_desc', job.cols * job.rows, FREE_TILES),
      payload: payload(job, price),
      currency: 'XTR',
      prices: [{ label: T('invoice_label', job.cols * job.rows), amount: price }],
    });
    return log('🧾', 'Счёт выставлен', { user: query.from, lines: [`Черновик: <code>${job.id}</code> · ${job.cols}×${job.rows}`, `Сумма: <b>${price} ⭐️</b>`] });
  }
  // A free pack on the free plan counts toward its daily limit.
  const lim = await checkLimit(job.userId, 'pack');
  if (!lim.ok) {
    await api.answerCallbackQuery({ callback_query_id: query.id });
    return sendLimitHit(job.chatId, 'pack', lim.limit, T);
  }
  await countUse(job.userId, 'pack');
  await api.answerCallbackQuery({ callback_query_id: query.id, text: T('building_toast') });
  await log('🚀', 'Сборка начата', { user: query.from, lines: [`Пак: <code>${job.id}</code> · ${job.cols}×${job.rows} = ${job.cols * job.rows} эмодзи`] });
  await startJob(job, query.from);
}

/** pre_checkout_query: the invoice must still match the draft's settings. */
export async function checkPayment(q) {
  if (q.invoice_payload === 'pro') {
    const ok = q.currency === 'XTR' && q.total_amount === PRO_PRICE;
    return api.answerPreCheckoutQuery(ok
      ? { pre_checkout_query_id: q.id, ok: true }
      : { pre_checkout_query_id: q.id, ok: false, error_message: (await tr(q.from.id, q.from.language_code))('pay_changed') });
  }
  const m = /^pack:(\d+):(\d+)x(\d+):(\d+)$/.exec(q.invoice_payload || '');
  const job = m && (await getJob(+m[1]));
  const T = await tr(q.from.id, q.from.language_code);
  let error = null;
  if (!job || job.userId !== q.from.id) error = T('pay_bad_job');
  else if (job.status !== 'draft' || job.paidStars || job.usedCredit) error = T('pay_already');
  else if (`${job.cols}x${job.rows}` !== `${m[2]}x${m[3]}` || (await priceForJob(job)) !== +m[4] || q.total_amount !== +m[4]) {
    error = T('pay_changed');
  }
  await api.answerPreCheckoutQuery(error
    ? { pre_checkout_query_id: q.id, ok: false, error_message: error }
    : { pre_checkout_query_id: q.id, ok: true });
}

/** message.successful_payment: record it and start building. */
export async function onPaid(message) {
  const p = message.successful_payment;
  if (p.invoice_payload === 'pro') return onProPaid(message, await tr(message.from.id, message.from.language_code));
  const m = /^pack:(\d+):/.exec(p.invoice_payload || '');
  const job = m && (await getJob(+m[1]));
  await log('⭐', 'Оплата', {
    user: message.from,
    lines: [`Пак: <code>${m ? m[1] : '?'}</code>`, `Сумма: <b>${p.total_amount} ⭐️</b>`, `Charge: <code>${esc(p.telegram_payment_charge_id)}</code>`],
  });
  if (!job || job.status !== 'draft') {
    // Paid for something that can't be built any more: give the Stars back.
    await api.refundStarPayment({ user_id: message.from.id, telegram_payment_charge_id: p.telegram_payment_charge_id });
    await logError('Оплата без черновика — возврат', { user: message.from, lines: [`Сумма: <b>${p.total_amount} ⭐️</b>`] });
    const T = await tr(message.from.id, message.from.language_code);
    return api.sendMessage({ chat_id: message.chat.id, text: T('paid_too_late') });
  }
  await db.update(jobs).set({ paidStars: p.total_amount, chargeId: p.telegram_payment_charge_id }).where(eq(jobs.id, job.id));
  await startJob({ ...job, paidStars: p.total_amount, chargeId: p.telegram_payment_charge_id }, message.from);
}
