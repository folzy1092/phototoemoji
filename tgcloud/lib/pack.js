// Step-wise pack building. The platform allows only FILES_PER_RUN uploads per
// invocation, so every step (the confirm button, a "+20" button, a Mini App
// call) re-renders the photo with the job's settings and uploads the next
// chunk of tiles. Video jobs (lib/video.js) upload fewer per step: as many
// animated tiles as an invocation's CPU time allows.
//
// User-facing text goes through lib/i18n.js (the job owner's language);
// log cards stay in Russian.

import { db, InputFile, BotApiError } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { eq, sql } from 'sdk/db';
import { jobs } from '../schema.js';
import {
  call, previewMessages, getBotUsername, packTitle, renderJob, tileEmoji, makeSetName, TILE, MAX_TILES,
} from './emojipack.js';
import { loadSource } from './source.js';
import { sliceTiles } from './image.js';
import { videoTiles } from './video.js';
import { log, logError, esc, link } from './log.js';
import { t, tr } from './i18n.js';

export const FILES_PER_RUN = 20;
export const MINI_APP_URL = 'https://app8837044715.tgcloud.ai/';
// An invocation is killed after ~30 s; a stuck lease must expire soon after.
const LEASE_MS = 45000;

export const addLink = (name) => `https://t.me/addemoji/${name}`;

export function shareLink(job, botUsername, T) {
  const text = T('share_text', job.cols, job.rows, botUsername);
  return `https://t.me/share/url?url=${encodeURIComponent(addLink(job.setName))}&text=${encodeURIComponent(text)}`;
}

export function getJob(id) {
  return db.select().from(jobs).where(eq(jobs.id, id)).get();
}

/** What a caller (Mini App, button) needs to know about a job. */
export function snapshot(job, extra = {}) {
  return {
    jobId: job.id,
    done: job.done,
    total: (job.cols || 0) * (job.rows || 0),
    status: job.status,
    finished: job.status === 'done' || job.status === 'appended',
    link: job.setName ? addLink(job.setName) : null,
    ...extra,
  };
}

const sticker = (png, i, emoji) => ({
  sticker: new InputFile(png, `tile_${i}.png`, { type: 'image/png' }),
  format: 'static',
  emoji_list: [emoji],
});

const videoSticker = (webm, i, emoji) => ({
  sticker: new InputFile(webm, `tile_${i}.webm`, { type: 'video/webm' }),
  format: 'video',
  emoji_list: [emoji],
});

async function stickersInSet(name) {
  try {
    return (await api.getStickerSet({ name })).stickers.length;
  } catch (e) {
    if (e instanceof BotApiError && e.code === 400) return 0; // not created yet
    throw e;
  }
}

/**
 * Turn a confirmed draft into a running job and do the first step.
 * `user` is the Telegram User who confirmed (or paid).
 */
export async function startJob(job, user) {
  const T = await tr(job.userId, user.language_code);
  const bot = await getBotUsername();
  // Extending a pack: upload into its set, after the stickers already there.
  const target = job.appendTo ? await getJob(job.appendTo) : null;
  const setName = target ? target.setName : makeSetName(job.userId, job.id, bot);
  const base = target ? await stickersInSet(setName) : 0;
  const status = await api.sendMessage({
    chat_id: job.chatId,
    text: T('building'),
    reply_parameters: job.previewMsg ? { message_id: job.previewMsg, allow_sending_without_reply: true } : undefined,
  });
  await db.update(jobs)
    .set({ status: 'running', setName, base, statusMsg: status.message_id, awaitTitle: 0 })
    .where(eq(jobs.id, job.id));
  job = { ...job, status: 'running', setName, base, statusMsg: status.message_id };

  // The preview's buttons are done with.
  if (job.previewMsg) {
    try {
      await api.editMessageReplyMarkup({ chat_id: job.chatId, message_id: job.previewMsg, reply_markup: { inline_keyboard: [] } });
    } catch (_) { /* best effort */ }
  }

  // Buttons first: if this invocation gets killed mid-upload, the user can still resume.
  await showProgress(job);
  try {
    await runStep(job.id, user);
  } catch (e) {
    await stepFailed(job.id, e, user);
  }
}

/** Report a failed step: keep it resumable, or fail it (and refund) if nothing was uploaded. */
async function stillRunning(jobId) {
  const r = await db.get(sql`SELECT status FROM jobs WHERE id = ${jobId}`);
  return !!r && r.status === 'running';
}

export async function stepFailed(jobId, e, user) {
  console.error(e);
  const job = await getJob(jobId);
  // Cancelled while the step ran (its set is gone, hence the error): nothing to report.
  if (!job || job.status !== 'running') return;
  const T = await tr(job.userId);
  await logError('Ошибка сборки', {
    user,
    lines: [`Пак: <code>${job.id}</code> ${job.cols}×${job.rows}, загружено ${job.done}`, esc(describeError(e))],
  });
  if (job.done > 0) return showProgress(job, describeError(e, T.lang));

  await db.update(jobs).set({ status: 'failed' }).where(eq(jobs.id, jobId));
  let refund = '';
  if (job.usedCredit) {
    await db.run(sql`UPDATE users SET credits = credits + 1 WHERE id = ${job.userId}`);
    await db.update(jobs).set({ usedCredit: 0 }).where(eq(jobs.id, jobId));
  }
  if (job.paidStars && job.chargeId) {
    try {
      await api.refundStarPayment({ user_id: job.userId, telegram_payment_charge_id: job.chargeId });
      await db.update(jobs).set({ paidStars: 0 }).where(eq(jobs.id, jobId)); // keeps /stats honest
      refund = `\n\n${T('refund_note', job.paidStars)}`;
      await log('↩️', 'Возврат Stars', { user, lines: [`Пак: <code>${job.id}</code>`, `Сумма: <b>${job.paidStars} ⭐️</b>`] });
    } catch (err) {
      await logError('Не удалось вернуть Stars', { user, lines: [`Пак: <code>${job.id}</code>`, esc(describeError(err))] });
    }
  }
  await editStatus(job, `❌ ${describeError(e, T.lang)}${refund}`, []);
}

/**
 * Upload the next chunk of tiles for `user` (a Telegram User, used for the
 * title). `img` may be passed when already decoded.
 * Progress is saved even when a call fails; the error is rethrown.
 */
export async function runStep(jobId, user, img = null) {
  let job = await getJob(jobId);
  if (!job || job.userId !== user.id) throw new Error('NOT_FOUND');
  if (job.status !== 'running') return snapshot(job);

  // Lease: one step at a time per job.
  const now = Date.now();
  const claim = await db.run(sql`UPDATE jobs SET lease_until = ${now + LEASE_MS}
    WHERE id = ${jobId} AND status = 'running' AND lease_until < ${now}`);
  if (!claim.rowsAffected) return snapshot(job, { busy: true });

  const total = job.cols * job.rows;
  // The set itself is the source of truth (a call may have succeeded without us seeing it).
  // An appended job starts after the `base` stickers that were already in the set.
  let done = Math.max(0, (await stickersInSet(job.setName)) - (job.base || 0));
  try {
    if (done < total) {
      const upTo = Math.min(total, done + FILES_PER_RUN);
      let tiles;
      if (job.source === 'video') {
        // Possibly fewer than asked: as many as fit in this invocation's CPU time.
        tiles = (await videoTiles(job, done, upTo)).map((t, k) => videoSticker(t.webm, done + k, t.emoji));
      } else {
        if (!img) img = await loadSource(job);
        const big = renderJob(img, job);
        img = null;
        tiles = sliceTiles(big, job.cols, TILE, done, upTo)
          .map((png, k) => sticker(png, done + k, tileEmoji(big, job.cols, TILE, done + k)));
      }
      const end = done + tiles.length;
      if (done === 0 && !job.appendTo) {
        await call('createNewStickerSet', {
          user_id: user.id,
          name: job.setName,
          title: packTitle(user, await getBotUsername(), job.title),
          sticker_type: 'custom_emoji',
          stickers: tiles,
        });
        done = end;
      } else {
        for (const s of tiles) {
          // The user may cancel while this step runs: stop instead of uploading into a deleted set.
          if (!(await stillRunning(jobId))) break;
          await call('addStickerToSet', { user_id: user.id, name: job.setName, sticker: s });
          done++;
        }
      }
    }
  } finally {
    await db.run(sql`UPDATE jobs SET done = ${done}, lease_until = 0 WHERE id = ${jobId}`);
  }

  job = { ...job, done };
  // Cancelled meanwhile: the status message already says so, leave it alone.
  if (!(await stillRunning(jobId))) return snapshot({ ...job, status: 'deleted' });
  if (done < total) {
    await showProgress(job);
    return snapshot(job);
  }
  return finish(job, user);
}

async function finish(job, user) {
  const set = await call('getStickerSet', { name: job.setName });
  const total = job.cols * job.rows;
  const mine = set.stickers.slice(job.base || 0, (job.base || 0) + total);
  if (job.appendTo) {
    // An extension is listed as part of its pack, not as a pack of its own.
    await db.run(sql`UPDATE jobs SET status = 'appended', finished_at = unixepoch() WHERE id = ${job.id}`);
    await db.run(sql`UPDATE jobs SET extra = extra + ${total} WHERE id = ${job.appendTo}`);
    job = { ...job, status: 'appended' };
  } else {
    await db.run(sql`UPDATE jobs SET status = 'done', finished_at = unixepoch() WHERE id = ${job.id}`);
    job = { ...job, status: 'done' };
  }
  const bot = await getBotUsername();
  const T = await tr(job.userId);

  await editStatus(job, T('done_msg', job.cols, job.rows, set.stickers.length, addLink(job.setName)), finalButtons(job, bot, T));
  try {
    for (const m of previewMessages(mine, job.cols)) {
      await call('sendMessage', { chat_id: job.chatId, text: m.text, entities: m.entities });
    }
  } catch (e) {
    console.warn('preview failed', e);
  }
  await log('🧩', job.appendTo ? 'Пак дополнен' : 'Пак создан', {
    user,
    lines: [
      `Результат: ${addLink(job.setName)}`,
      `Пак: ${link(addLink(job.setName), `${job.cols}×${job.rows} · ${set.stickers.length} эмодзи в наборе`)}`,
      `Источник: ${job.source}${job.source === 'text' ? ` «${esc(job.text)}»` : ''}`,
      `Название: ${esc(set.title)}`,
      job.paidStars ? `Оплата: <b>${job.paidStars} ⭐️</b>` : job.usedCredit ? 'Оплата: подарок 🎁' : 'Оплата: бесплатно',
    ],
  });
  return snapshot(job);
}

export function finalButtons(job, bot, T) {
  return [
    [
      { text: T('btn_add'), url: addLink(job.setName) },
      { text: T('btn_share'), url: shareLink(job, bot, T) },
    ],
    [{ text: T('btn_delete'), callback_data: `del:${job.appendTo || job.id}` }],
  ];
}

export function confirmButtons(job, T) {
  return [[
    { text: T('btn_confirm_delete', job.cols, job.rows), callback_data: `delok:${job.id}` },
    { text: T('btn_no'), callback_data: `undel:${job.id}` },
  ]];
}

/** The /packs message: finished and in-progress packs; each opens its menu. */
export async function packList(userId) {
  const T = await tr(userId);
  const rows = await db.all(sql`SELECT * FROM jobs
    WHERE user_id = ${userId} AND append_to IS NULL AND (status = 'done' OR (status = 'running' AND done > 0))
    ORDER BY id DESC LIMIT 30`);
  if (!rows.length) return { text: T('packs_empty'), keyboard: [] };

  const lines = [];
  const keyboard = [];
  rows.forEach((r, i) => {
    const n = i + 1;
    const total = r.cols * r.rows + r.extra;
    const state = r.status === 'done' ? T('pack_done', total) : T('pack_building', r.done, r.cols * r.rows);
    const name = r.title ? ` «${r.title}»` : '';
    lines.push(`${n}.${name} ${r.cols}×${r.rows} · ${state}\n${addLink(r.set_name)}`);
    keyboard.push([
      { text: `⚙️ ${n}. ${r.cols}×${r.rows}`, callback_data: `pm:${r.id}:${n}` },
      { text: T('btn_add'), url: addLink(r.set_name) },
    ]);
  });
  return { text: `${T('packs_header', rows.length)}\n\n${lines.join('\n\n')}`, keyboard };
}

/** One pack's menu (shown in place of the /packs list). */
export async function packMenu(job, n, T) {
  const bot = await getBotUsername();
  const total = job.cols * job.rows + (job.extra || 0);
  const kb = [
    [{ text: T('btn_add'), url: addLink(job.setName) }, { text: T('btn_share'), url: shareLink(job, bot, T) }],
  ];
  if (job.status === 'done') {
    kb.push([{ text: T('btn_rename'), callback_data: `pr:${job.id}` }, { text: T('btn_rebuild'), callback_data: `rb:${job.id}` }]);
    if (total < MAX_TILES) kb.push([{ text: T('btn_append'), callback_data: `ap:${job.id}` }]);
  }
  kb.push([{ text: T('btn_delete'), callback_data: `md:${job.id}:${n}` }, { text: T('btn_back'), callback_data: `pl:${job.id}` }]);
  return { text: T('pack_menu', n, job.title, job.cols, job.rows, total, addLink(job.setName)), keyboard: kb };
}

export function progressButtons(job, T) {
  return [
    [{ text: T('btn_upload_all'), web_app: { url: `${MINI_APP_URL}?job=${job.id}` } }],
    [
      { text: job.source === 'video' ? T('btn_more_video') : T('btn_more', FILES_PER_RUN), callback_data: `next:${job.id}` },
      { text: T('btn_cancel'), callback_data: `del:${job.id}` },
    ],
  ];
}

/** `error` is already a user-facing (translated) string. */
export async function showProgress(job, error = null) {
  const T = await tr(job.userId);
  const total = job.cols * job.rows;
  const lines = [T('progress', job.done, total)];
  if (job.source === 'video') lines.push('', T('progress_explain_video'));
  else if (total > FILES_PER_RUN) lines.push('', T('progress_explain', FILES_PER_RUN));
  if (error) lines.push('', `⚠️ ${error}`);
  await editStatus(job, lines.join('\n'), progressButtons(job, T));
}

export async function editStatus(job, text, keyboard = null) {
  if (!job.chatId || !job.statusMsg) return;
  try {
    await api.editMessageText({
      chat_id: job.chatId,
      message_id: job.statusMsg,
      text,
      link_preview_options: { is_disabled: true },
      ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e; // e.g. "message is not modified"
  }
}

/** Error text for the user (`lang`) or, by default, for Russian log cards. */
export function describeError(e, lang = 'ru') {
  if (e instanceof BotApiError) return t(lang, 'err_telegram', e.description);
  switch (e && e.message) {
    case 'UNSUPPORTED_FORMAT': return t(lang, 'err_unsupported');
    case 'TOO_LARGE': return t(lang, 'err_too_large');
    case 'FILE_TOO_BIG': return t(lang, 'err_file_big');
    case 'VIDEO_TOO_BIG': return t(lang, 'err_video_big');
    case 'VIDEO_HEAVY': return t(lang, 'err_video_heavy');
    case 'VIDEO_UNREADABLE': case 'FFMPEG_FAILED': return t(lang, 'err_video');
    case 'VIDEO_TILE_BIG': return t(lang, 'err_video_tile');
    case 'NOT_FOUND': return t(lang, 'pack_not_found');
    default: return t(lang, 'err_generic', e && e.message);
  }
}
