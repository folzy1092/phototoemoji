// Event cards for the shared log group, same scheme as lengubot's log_topic.py:
// the bot writes into its own forum topic ("PhotoEmoji"), errors go to
// "PhotoEmoji · Ошибки". Topics are created on first use with this bot's token
// and their ids are kept in `settings`. If a topic was deleted, it is created
// again. If topics can't be created (not a forum / no can_manage_topics), the
// card goes to General and creation is retried no sooner than RETRY_MS.
//
// Topic icons: the color can only be set when a topic is created, but the
// icon emoji can be changed any time (editForumTopic + an emoji from
// getForumTopicIconStickers). Every known topic gets its icon once; done is
// marked in settings as topic-icon:<chat>:<name> = "<thread>:<icon id>", a
// failure as "<thread>:fail:<unix>" and retried no sooner than ICON_RETRY_S.
// Same logic as lengubot's log_topic.py (_ensure_icon / apply_icons).
//
// Logging must never break the bot: every failure here is swallowed.

import { db } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { OWNER_ID, OWNER_TAG, OWNER_USERNAME } from './emojipack.js';

export const LOG_CHAT_ID = -1002276939424;
export const LOG_TOPIC = 'PhotoEmoji';
const ERROR_TOPIC = `${LOG_TOPIC} · Ошибки`;
const RETRY_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000;
const GONE = ['thread not found', 'topic_deleted', 'topic_id_invalid'];
const ARCHIVE_TOPIC = `${LOG_TOPIC} · архив`;
const ICON = { [LOG_TOPIC]: 16478047, [ERROR_TOPIC]: 16478047 }; // both red (the owner's choice)
// Icon emoji per topic, first one found in Telegram's topic icon set wins.
const TOPIC_EMOJI = {
  [LOG_TOPIC]: ['🎨', '🖼', '📷'],
  [ERROR_TOPIC]: ['❗', '‼', '🔥'],
  [ARCHIVE_TOPIC]: ['📁', '📚'],
};
const ICON_RETRY_S = 24 * 3600;

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const link = (url, text) => `<a href="${esc(url)}">${esc(text)}</a>`;

/**
 * "@user | ID: <code>1</code>" like lengubot's cards. The owner is shown as
 * DEV: an @mention in the log group would ping them.
 */
export function person(user) {
  if (!user) return 'неизвестно';
  if (user.id === OWNER_ID) return `${OWNER_TAG} | ID: <code>${user.id}</code>`;
  const handle = user.username ? `@${user.username}` : user.first_name || user.firstName;
  return handle ? `${esc(handle)} | ID: <code>${user.id}</code>` : `ID: <code>${user.id}</code>`;
}

export async function getSetting(key) {
  const r = await db.get(sql`SELECT value FROM settings WHERE key = ${key}`);
  return r ? r.value : null;
}

export async function setSetting(key, value) {
  await db.run(sql`INSERT INTO settings (key, value) VALUES (${key}, ${String(value)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
}

async function deleteSetting(key) {
  await db.run(sql`DELETE FROM settings WHERE key = ${key}`);
}

// ---- topic icons ----

const noVs = (s) => String(s || '').replace(/️/g, '');
let iconSet = null; // emoji (without VS16) -> custom_emoji_id, per invocation

async function iconIdFor(name) {
  if (!iconSet) {
    const stickers = await api.getForumTopicIconStickers();
    iconSet = new Map(stickers.map((s) => [noVs(s.emoji), s.custom_emoji_id]));
  }
  for (const e of TOPIC_EMOJI[name] || []) {
    const id = iconSet.get(noVs(e));
    if (id) return id;
  }
  return null;
}

async function ensureIcon(name, threadId) {
  if (!TOPIC_EMOJI[name] || !threadId) return;
  const key = `topic-icon:${LOG_CHAT_ID}:${name}`;
  const mark = await getSetting(key);
  const now = Math.floor(Date.now() / 1000);
  if (mark) {
    const [thread, value, at] = mark.split(':');
    if (+thread === +threadId && value !== 'fail') return;                 // done
    if (+thread === +threadId && now - +at < ICON_RETRY_S) return;         // failed recently
  }
  try {
    const id = await iconIdFor(name);
    if (!id) throw new Error('none of the icon emoji is in the topic icon set');
    await api.editForumTopic({ chat_id: LOG_CHAT_ID, message_thread_id: +threadId, icon_custom_emoji_id: id });
    await setSetting(key, `${threadId}:${id}`);
  } catch (e) {
    console.warn(`topic icon for "${name}" not set`, e);
    await setSetting(key, `${threadId}:fail:${now}`);
  }
}

/** Give every known topic its icon (cheap after the first time: just the marks). */
async function ensureAllIcons() {
  const prefix = `topic:${LOG_CHAT_ID}:`;
  const rows = await db.all(sql`SELECT key, value FROM settings
    WHERE key LIKE ${`${prefix}%`} AND key NOT LIKE '%:blocked' AND key NOT LIKE '%:lock'`);
  for (const r of rows) await ensureIcon(r.key.slice(prefix.length), r.value);
}

async function threadFor(name) {
  const key = `topic:${LOG_CHAT_ID}:${name}`;
  const known = await getSetting(key);
  if (known) return +known;
  const now = Date.now();
  if (now < +((await getSetting(`${key}:blocked`)) || 0)) return null;

  // One creator at a time, or two invocations could make two topics.
  const lockKey = `${key}:lock`;
  const claim = await db.run(sql`INSERT INTO settings (key, value) VALUES (${lockKey}, ${String(now)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(settings.value AS INTEGER) < ${now - LOCK_STALE_MS}`);
  if (!claim.rowsAffected) return null;
  try {
    const again = await getSetting(key);
    if (again) return +again;
    const topic = await api.createForumTopic({ chat_id: LOG_CHAT_ID, name, icon_color: ICON[name] });
    await setSetting(key, topic.message_thread_id);
    await ensureIcon(name, topic.message_thread_id);
    return topic.message_thread_id;
  } catch (e) {
    console.warn(`log topic "${name}" not created`, e);
    await setSetting(`${key}:blocked`, now + RETRY_MS);
    return null;
  } finally {
    await deleteSetting(lockKey);
  }
}

async function sendInTopic(name, method, params) {
  const thread = await threadFor(name);
  const send = (t) => api[method]({ chat_id: LOG_CHAT_ID, ...params, ...(t ? { message_thread_id: t } : {}) });
  try {
    return await send(thread);
  } catch (e) {
    const gone = thread && GONE.some((g) => String(e.description || e.message).toLowerCase().includes(g));
    if (!gone) throw e;
  }
  await deleteSetting(`topic:${LOG_CHAT_ID}:${name}`);
  return send(await threadFor(name));
}

/**
 * Post an event card.
 * log('🧩', 'Пак создан', { user, lines: ['Пак: …'], photo: fileId, error: false })
 * `lines` are HTML (escape user text with esc()).
 */
export async function log(icon, event, { user = null, lines = [], photo = null, error = false } = {}) {
  try {
    try { await ensureAllIcons(); } catch (e) { console.warn('topic icons', e); }
    const parts = [`${icon} <b>${esc(event)}</b>`];
    if (user) parts.push(`Кто: ${person(user)}`);
    parts.push(...lines.filter(Boolean));
    // Pack titles quote the owner's @username; in the log group that would ping them.
    const text = parts.join('\n').replace(new RegExp(`@${OWNER_USERNAME}\\b`, 'gi'), OWNER_TAG);
    const topic = error ? ERROR_TOPIC : LOG_TOPIC;
    if (photo && text.length <= 1024) {
      try {
        await sendInTopic(topic, 'sendPhoto', { photo, caption: text, parse_mode: 'HTML' });
        return;
      } catch (e) {
        console.warn('log photo failed, sending text', e); // e.g. a document's file_id
      }
    }
    await sendInTopic(topic, 'sendMessage', {
      text: text.slice(0, 4096), parse_mode: 'HTML', link_preview_options: { is_disabled: true },
    });
  } catch (e) {
    console.warn('log failed', e);
  }
}

export const logError = (event, opts = {}) => log('❌', event, { ...opts, error: true });
