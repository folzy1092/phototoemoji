// handlers/callback_query.js — buttons:
//   lang:<code>         choose the bot language
//   alb:<group>         build a collage draft from an album
//   s:<id>:<action>     preview settings (lib/draft.js)
//   sk:<id>:<choice>    where a sticker goes: a set id, n new, l new with a link, x cancel
//   next:<id>           upload the next chunk
//   pm:<id>:<n>         pack menu (from /packs) · pl:<id> back to the list
//   pr / rb / ap:<id>   rename / rebuild / add a picture to a pack
//   md:<id>:<n>         delete from the pack menu (asks to confirm)
//   del / delok / undel:<id>  delete under a status message: ask / do / cancel
//   bc / bcx:<id>       owner's broadcast: next batch / cancel
//   tx:<msg>            draw a plain text message as a banner · hlp:0 help

import { db, BotApiError } from 'sdk';
import { api } from '../lib/premium.js'; // premium emoji applied
import { eq, sql } from 'sdk/db';
import { jobs } from '../schema.js';
import {
  runStep, stepFailed, editStatus, describeError, getJob, packList, packMenu,
  finalButtons, progressButtons, confirmButtons, addLink, FILES_PER_RUN,
} from '../lib/pack.js';
import { onStickerChoice } from '../lib/sticker.js';
import { onDraftButton, createAlbumDraft, rebuildDraft, askTitle, createTextDraft } from '../lib/draft.js';
import { getBotUsername, HELP_PARAMS, MAX_TILES } from '../lib/emojipack.js';
import { trackUser, isBanned } from '../lib/users.js';
import { onBroadcastButton } from '../lib/admin.js';
import { tr, t, setUserLang, LANGS, LANG_NAMES } from '../lib/i18n.js';
import { log, logError, esc, link, getSetting } from '../lib/log.js';
import { planMessage } from '../lib/plan.js';

export default async function (query) {
  const data = query.data || '';
  if (await isBanned(query.from.id)) return api.answerCallbackQuery({ callback_query_id: query.id });

  let m;
  if ((m = /^lang:([a-z]{2})$/.exec(data))) return chooseLang(query, m[1]);
  if ((m = /^alb:(-?\d+)$/.exec(data))) return guarded(query, () => createAlbumDraft(query, m[1]));
  if ((m = /^(bc|bcx):(\d+)$/.exec(data))) return onBroadcastButton(query, m[1], +m[2]);
  if ((m = /^tx:(\d+)$/.exec(data))) return guarded(query, () => textFromOffer(query, +m[1]));
  if (data === 'hlp:0') return showHelp(query);
  if (data === 'pro:0') return guarded(query, async () => {
    const T = await tr(query.from.id, query.from.language_code);
    await api.answerCallbackQuery({ callback_query_id: query.id });
    const { text, keyboard } = await planMessage(query.from, T);
    return api.sendMessage({ chat_id: query.message ? query.message.chat.id : query.from.id, text, reply_markup: { inline_keyboard: keyboard } });
  });

  m = /^(s|sk|next|del|delok|undel|pm|pl|pr|rb|ap|md):(\d+)(?::(.+))?$/.exec(data);
  if (!m) return api.answerCallbackQuery({ callback_query_id: query.id });
  const job = await getJob(+m[2]);
  const T = await tr(query.from.id, query.from.language_code);
  if (!job || job.userId !== query.from.id) {
    return api.answerCallbackQuery({ callback_query_id: query.id, text: T('pack_not_found') });
  }
  return guarded(query, () => {
    switch (m[1]) {
      case 's': return onDraftButton(query, job, m[3] || '');
      case 'sk': return onStickerChoice(query, job, m[3] || '', T);
      case 'next': return next(query, job, T);
      case 'pm': return showMenu(query, job, +m[3] || 1, T);
      case 'pl': return backToList(query);
      case 'pr': return rename(query, job, T);
      case 'rb': return rebuild(query, job, T);
      case 'ap': return startAppend(query, job, T);
      case 'md': return askDeleteInMenu(query, job, +m[3] || 1, T);
      case 'del': return askDelete(query, job, T);
      case 'delok': return remove(query, job, T);
      default: return cancelDelete(query, job, T);
    }
  }, T);
}

async function guarded(query, fn, T = null) {
  try {
    return await fn();
  } catch (e) {
    console.error(e);
    await logError('Ошибка кнопки', { user: query.from, lines: [`Кнопка: <code>${esc(query.data)}</code>`, esc(describeError(e))] });
    try {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: describeError(e, T ? T.lang : 'en'), show_alert: true });
    } catch (_) { /* already answered */ }
  }
}

async function textFromOffer(query, messageId) {
  const T = await tr(query.from.id, query.from.language_code);
  const chatId = query.message ? query.message.chat.id : query.from.id;
  const key = `suggest:${chatId}:${messageId}`;
  const saved = await getSetting(key);
  if (!saved) return api.answerCallbackQuery({ callback_query_id: query.id, text: T('text_offer_gone'), show_alert: true });
  await api.answerCallbackQuery({ callback_query_id: query.id, text: T('preparing') });
  await db.run(sql`DELETE FROM settings WHERE key = ${key}`);
  if (query.message) {
    try { await api.deleteMessage({ chat_id: chatId, message_id: query.message.message_id }); } catch (_) { /* ok */ }
  }
  const text = saved.slice(saved.indexOf('\n') + 1);
  // Same as "/text …" sent as that message (the draft replies to it).
  return createTextDraft({ message_id: messageId, chat: { id: chatId, type: 'private' }, from: query.from, text }, text);
}

async function showHelp(query) {
  const T = await tr(query.from.id, query.from.language_code);
  await api.answerCallbackQuery({ callback_query_id: query.id });
  return api.sendMessage({ chat_id: query.message ? query.message.chat.id : query.from.id, text: T('help', HELP_PARAMS) });
}

async function chooseLang(query, lang) {
  if (!LANGS.includes(lang)) return api.answerCallbackQuery({ callback_query_id: query.id });
  await trackUser(query.from);
  await setUserLang(query.from.id, lang);
  await api.answerCallbackQuery({ callback_query_id: query.id, text: t(lang, 'lang_set') });
  if (query.message) {
    try {
      await api.editMessageText({ chat_id: query.message.chat.id, message_id: query.message.message_id, text: t(lang, 'lang_set') });
    } catch (_) { /* ok */ }
    await api.sendMessage({ chat_id: query.message.chat.id, text: t(lang, 'help', HELP_PARAMS) });
  }
  await log('🌐', 'Выбран язык', { user: query.from, lines: [`Язык: ${LANG_NAMES[lang]}`, `Язык Telegram: <code>${esc(query.from.language_code || '—')}</code>`] });
}

async function next(query, job, T) {
  if (job.status !== 'running') {
    return api.answerCallbackQuery({ callback_query_id: query.id, text: T('not_building') });
  }
  await api.answerCallbackQuery({ callback_query_id: query.id, text: job.source === 'video' ? T('more_toast_video') : T('more_toast', FILES_PER_RUN) });
  try {
    await runStep(job.id, query.from);
  } catch (e) {
    await stepFailed(job.id, e, query.from);
  }
}

// ---- /packs list and pack menu (edited in place) ----

async function editHere(query, text, keyboard) {
  if (!query.message) return;
  try {
    await api.editMessageText({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      text,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
  }
}

async function listHere(query) {
  const { text, keyboard } = await packList(query.from.id);
  return editHere(query, text, keyboard);
}

async function backToList(query) {
  await api.answerCallbackQuery({ callback_query_id: query.id });
  return listHere(query);
}

const isLive = (job) => job.status === 'done' || job.status === 'running';

async function showMenu(query, job, n, T) {
  await api.answerCallbackQuery({ callback_query_id: query.id });
  if (!isLive(job)) return listHere(query);
  const { text, keyboard } = await packMenu(job, n, T);
  return editHere(query, text, keyboard);
}

async function rename(query, job, T) {
  await api.answerCallbackQuery({ callback_query_id: query.id });
  if (job.status !== 'done') return;
  return askTitle(job, query.from, T);
}

async function rebuild(query, job, T) {
  await api.answerCallbackQuery({ callback_query_id: query.id, text: T('preparing') });
  return rebuildDraft(query, job);
}

async function startAppend(query, job, T) {
  if (job.status !== 'done' || job.cols * job.rows + job.extra >= MAX_TILES) {
    return api.answerCallbackQuery({ callback_query_id: query.id, text: T('append_full'), show_alert: true });
  }
  await db.run(sql`UPDATE users SET pending = ${`append:${job.id}`} WHERE id = ${query.from.id}`);
  await api.answerCallbackQuery({ callback_query_id: query.id });
  return api.sendMessage({ chat_id: job.chatId, text: T('append_prompt', MAX_TILES - job.cols * job.rows - job.extra) });
}

async function askDeleteInMenu(query, job, n, T) {
  await api.answerCallbackQuery({ callback_query_id: query.id });
  if (!isLive(job)) return listHere(query);
  return setKeyboard(query, [[
    { text: T('btn_confirm_delete', job.cols, job.rows), callback_data: `delok:${job.id}` },
    { text: T('btn_no'), callback_data: `pm:${job.id}:${n}` },
  ]]);
}

// ---- deleting ----

// The button may sit under the pack's own status message or under a /packs menu.
const inList = (query, job) => query.message && query.message.message_id !== job.statusMsg;

async function setKeyboard(query, keyboard) {
  if (!query.message) return;
  try {
    await api.editMessageReplyMarkup({
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (e) {
    if (!(e instanceof BotApiError)) throw e;
  }
}

async function setExists(name) {
  try {
    await api.getStickerSet({ name });
    return true;
  } catch (e) {
    if (e instanceof BotApiError && e.code === 400) return false;
    throw e;
  }
}

async function askDelete(query, job, T) {
  if (!isLive(job)) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: T('already_deleted') });
    return inList(query, job) ? listHere(query) : undefined;
  }
  await api.answerCallbackQuery({ callback_query_id: query.id });
  await setKeyboard(query, confirmButtons(job, T));
}

async function cancelDelete(query, job, T) {
  await api.answerCallbackQuery({ callback_query_id: query.id });
  if (job.status === 'done') return setKeyboard(query, finalButtons(job, await getBotUsername(), T));
  if (job.status === 'running') return setKeyboard(query, progressButtons(job, T));
  return setKeyboard(query, []);
}

async function remove(query, job, T) {
  if (!isLive(job)) {
    await api.answerCallbackQuery({ callback_query_id: query.id, text: T('already_deleted') });
    return inList(query, job) ? listHere(query) : undefined;
  }
  // Mark it deleted first, so a step running right now stops uploading.
  await db.update(jobs).set({ status: 'deleted' }).where(eq(jobs.id, job.id));
  // An extension being built shares its pack's set: cancel it, never delete the set.
  const ownSet = job.setName && !job.appendTo;
  if (ownSet) {
    try {
      await api.deleteStickerSet({ name: job.setName });
    } catch (e) {
      // 400 also comes back for a set created moments ago that does exist:
      // only treat it as "already gone" if the set really can't be found.
      const stillThere = e instanceof BotApiError && e.code === 400 && await setExists(job.setName);
      if (!(e instanceof BotApiError) || e.code !== 400 || stillThere) {
        console.error(e);
        await db.update(jobs).set({ status: job.status }).where(eq(jobs.id, job.id)); // not deleted after all
        const text = stillThere ? T('too_fresh') : describeError(e, T.lang);
        return api.answerCallbackQuery({ callback_query_id: query.id, text, show_alert: true });
      }
    }
    // Extensions of this pack went with it.
    await db.run(sql`UPDATE jobs SET status = 'deleted' WHERE append_to = ${job.id}`);
  }
  await db.update(jobs).set({ status: 'deleted' }).where(eq(jobs.id, job.id));
  await api.answerCallbackQuery({ callback_query_id: query.id, text: T('deleted', job.cols, job.rows) });

  await editStatus(job, `🗑 ${T('deleted', job.cols, job.rows)}`, []);
  if (inList(query, job)) await listHere(query);
  await log('🗑', job.status === 'running' ? 'Сборка отменена' : 'Пак удалён', {
    user: query.from,
    lines: [`Пак: <code>${job.id}</code> · ${job.cols}×${job.rows}, было ${job.done} эмодзи`, job.setName ? `Имя: ${link(addLink(job.setName), job.setName)}` : null],
  });
}
