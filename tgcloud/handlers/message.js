// handlers/message.js — photos/albums/videos/texts become previews, commands, title
// input, payments, owner commands.

import { db } from 'sdk';
import { api } from '../lib/premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { HELP_PARAMS } from '../lib/emojipack.js';
import { packList } from '../lib/pack.js';
import { createDraft, createTextDraft, createVideoDraft, maybeSetTitle, onPaid, isImageMessage } from '../lib/draft.js';
import { isVideoMessage } from '../lib/video.js';
import { parseBanner, bannerGrid } from '../lib/font.js';
import { setSetting } from '../lib/log.js';
import { onAlbumPhoto } from '../lib/album.js';
import { trackUser, isBanned, handleReferral, refMessage, statsText } from '../lib/users.js';
import { adminCommand, isOwner } from '../lib/admin.js';
import { maybeSweep } from '../lib/cleanup.js';
import { tr, hasChosenLang, langKeyboard } from '../lib/i18n.js';
import { planMessage } from '../lib/plan.js';
import { log, logError, esc } from '../lib/log.js';

const ADMIN_COMMANDS = ['/admin', '/broadcast', '/gift', '/refund', '/ban', '/unban', '/user', '/vip', '/unvip'];

export default async function (message) {
  if (message.chat.type !== 'private' || !message.from) return;
  try {
    await route(message);
  } catch (e) {
    // Never fail silently: the user should always get an answer.
    console.error(e);
    await logError('Ошибка в обработчике сообщений', { user: message.from, lines: [esc(e && e.message)] });
    const T = await tr(message.from.id, message.from.language_code);
    await api.sendMessage({ chat_id: message.chat.id, text: T('internal_error', e && e.message) });
  }
  await maybeSweep();
}

async function route(message) {
  const user = message.from;
  const chatId = message.chat.id;
  const text = message.text || '';
  const isNew = await trackUser(user);
  if (await isBanned(user.id)) return; // silently ignored
  const T = await tr(user.id, user.language_code);
  const command = text.startsWith('/') ? text.split(/[\s@]/)[0].toLowerCase() : null;
  // Everything after the first word ("/text@bot ПРИВЕТ\nМИР" -> "ПРИВЕТ\nМИР").
  const arg = command ? text.slice(text.split(/\s/)[0].length).trim() : '';

  if (isNew) {
    await log('👋', 'Новый пользователь', {
      user,
      lines: [
        `Имя: ${esc([user.first_name, user.last_name].filter(Boolean).join(' '))}`,
        user.language_code ? `Язык Telegram: <code>${esc(user.language_code)}</code>` : null,
        command ? `Первая команда: <code>${esc(text.slice(0, 100))}</code>` : null,
      ],
    });
    if (command === '/start' && arg) await handleReferral(user, arg);
  }

  if (message.successful_payment) return onPaid(message);
  if (isImageMessage(message)) return message.media_group_id ? onAlbumPhoto(message) : createDraft(message);
  if (isVideoMessage(message)) return createVideoDraft(message); // a video in an album: a draft of its own
  if (message.document || message.sticker || message.video || message.animation || message.video_note) {
    return api.sendMessage({ chat_id: chatId, text: T('unsupported_file') });
  }

  if (command) {
    if (!(isNew && command === '/start')) {
      await log(command === '/start' ? '▶️' : '⌨️', `Команда ${command}`, {
        user,
        lines: arg ? [`Текст: <code>${esc(arg.slice(0, 200))}</code>`] : [],
      });
    }
    if (command === '/start') await db.run(sql`UPDATE users SET pending = NULL WHERE id = ${user.id}`);
    if (isOwner(user) && ADMIN_COMMANDS.includes(command)) return adminCommand(message, command);
    if (command === '/stats' && isOwner(user)) return api.sendMessage({ chat_id: chatId, text: await statsText() });

    // First start (or /lang): ask for the language, in the user's Telegram language.
    if (command === '/lang' || (command === '/start' && !(await hasChosenLang(user.id)))) {
      return api.sendMessage({ chat_id: chatId, text: T('lang_prompt'), reply_markup: { inline_keyboard: langKeyboard() } });
    }
    if (command === '/packs') return listPacks(message);
    if (command === '/text') return createTextDraft(message, arg);
    if (command === '/pro' || command === '/vip') {
      const { text: planText, keyboard } = await planMessage(user, T);
      return api.sendMessage({ chat_id: chatId, text: planText, reply_markup: { inline_keyboard: keyboard } });
    }
    if (command === '/ref') {
      const { text: refText, keyboard } = await refMessage(user);
      return api.sendMessage({ chat_id: chatId, text: refText, link_preview_options: { is_disabled: true }, reply_markup: { inline_keyboard: keyboard } });
    }
    return api.sendMessage({ chat_id: chatId, text: T('help', HELP_PARAMS) });
  }

  if (text && (await maybeSetTitle(message))) return;
  if (text) await log('💬', 'Сообщение', { user, lines: [`Текст: <i>${esc(text.slice(0, 300))}</i>`] });
  if (text && (await offerBanner(message, T))) return;
  return api.sendMessage({ chat_id: chatId, text: T('help', HELP_PARAMS) });
}

/**
 * Plain text the bot doesn't understand: offer to draw it as an emoji banner
 * (if the pixel font can). The text is kept in `settings` because a button's
 * callback_data is limited to 64 bytes.
 */
async function offerBanner(message, T) {
  const parsed = parseBanner(message.text);
  if (!parsed.lines || !bannerGrid(message.text)) return false;
  const short = parsed.lines.join(' ');
  await setSetting(`suggest:${message.chat.id}:${message.message_id}`, `${Math.floor(Date.now() / 1000)}\n${message.text}`);
  await api.sendMessage({
    chat_id: message.chat.id,
    text: T('text_offer'),
    reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [
      [{ text: T('btn_make_text', short.length > 24 ? `${short.slice(0, 23)}…` : short), callback_data: `tx:${message.message_id}` }],
      [{ text: T('btn_help'), callback_data: 'hlp:0' }],
    ] },
  });
  return true;
}

async function listPacks(message) {
  const { text, keyboard } = await packList(message.from.id);
  await api.sendMessage({
    chat_id: message.chat.id,
    text,
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: keyboard },
  });
}
