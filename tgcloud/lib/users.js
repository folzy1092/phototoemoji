// Who writes to the bot: users table upkeep, referrals, bans and /stats.

import { db } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { getBotUsername } from './emojipack.js';
import { tr } from './i18n.js';
import { log, person } from './log.js';

export const REF_STEP = 3; // friends per free big pack

/** Upsert the user; true if this is their first message ever. */
export async function trackUser(u) {
  const ins = await db.run(sql`INSERT INTO users (id, username, first_name, lang_code)
    VALUES (${u.id}, ${u.username || null}, ${u.first_name || null}, ${u.language_code || null})
    ON CONFLICT(id) DO NOTHING`);
  if (ins.rowsAffected) return true;
  await db.run(sql`UPDATE users SET username = ${u.username || null}, first_name = ${u.first_name || null},
    lang_code = coalesce(${u.language_code || null}, lang_code), blocked = 0, last_seen = unixepoch() WHERE id = ${u.id}`);
  return false;
}

export async function isBanned(userId) {
  const r = await db.get(sql`SELECT banned FROM users WHERE id = ${userId}`);
  return !!(r && r.banned);
}

/**
 * "@name" or a numeric id -> users row, or null. With `create`, an unknown
 * numeric id gets a row, so the owner can ban or gift someone who hasn't
 * written to the bot yet.
 */
export async function resolveUser(arg, { create = false } = {}) {
  const s = String(arg || '').trim();
  if (/^\d+$/.test(s)) {
    if (create) await db.run(sql`INSERT INTO users (id) VALUES (${+s}) ON CONFLICT(id) DO NOTHING`);
    return db.get(sql`SELECT * FROM users WHERE id = ${+s}`);
  }
  const name = s.replace(/^@/, '').toLowerCase();
  if (!name) return null;
  return db.get(sql`SELECT * FROM users WHERE lower(username) = ${name}`);
}

export const refLink = async (userId) => `https://t.me/${await getBotUsername()}?start=ref_${userId}`;

/**
 * A new user came with /start ref_<id>: remember who invited them; every
 * REF_STEP friends give the inviter one free big pack.
 */
export async function handleReferral(newUser, payload) {
  const m = /^ref_(\d+)$/.exec(payload || '');
  if (!m || +m[1] === newUser.id) return;
  const inviter = await db.get(sql`SELECT id, username, first_name FROM users WHERE id = ${+m[1]}`);
  if (!inviter) return;
  await db.run(sql`UPDATE users SET referred_by = ${inviter.id} WHERE id = ${newUser.id}`);
  const res = await db.run(sql`UPDATE users SET ref_count = ref_count + 1,
    credits = credits + (CASE WHEN (ref_count + 1) % ${REF_STEP} = 0 THEN 1 ELSE 0 END)
    WHERE id = ${inviter.id} RETURNING ref_count, credits`);
  const r = res.rows[0];
  const rewarded = r.ref_count % REF_STEP === 0;
  const T = await tr(inviter.id);
  try {
    await api.sendMessage({
      chat_id: inviter.id,
      text: rewarded ? T('ref_reward', r.credits) : T('ref_friend', REF_STEP - (r.ref_count % REF_STEP)),
    });
  } catch (_) { /* the inviter may have blocked the bot */ }
  await log('🤝', rewarded ? 'Реферал: подарок выдан' : 'Реферал', {
    user: newUser,
    lines: [`Пригласил: ${person(inviter)}`, `Всего приглашено: ${r.ref_count} · подарков: ${r.credits}`],
  });
}

/** /ref: the user's link, counters and a share button. */
export async function refMessage(user) {
  const T = await tr(user.id, user.language_code);
  const link = await refLink(user.id);
  const r = await db.get(sql`SELECT ref_count, credits FROM users WHERE id = ${user.id}`);
  const share = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(T('ref_share_text'))}`;
  return {
    text: T('ref_text', link, r ? r.ref_count : 0, r ? r.credits : 0),
    keyboard: [[{ text: T('ref_share_btn'), url: share }]],
  };
}

export async function statsText() {
  const day = Math.floor(Date.now() / 1000) - 86400;
  const u = await db.get(sql`SELECT count(*) AS total,
    sum(first_seen > ${day}) AS fresh, sum(last_seen > ${day}) AS active,
    sum(referred_by IS NOT NULL) AS referred, sum(credits) AS credits, sum(banned) AS banned, sum(blocked) AS blocked,
    sum(vip_until > unixepoch()) AS vip, sum(pro_until > unixepoch()) AS pro, sum(pro_stars) AS pro_stars
    FROM users`);
  const j = await db.get(sql`SELECT
    sum(status = 'done') AS done,
    sum(status = 'done' AND finished_at > ${day}) AS done24,
    sum(CASE WHEN status IN ('done', 'appended') THEN cols * rows ELSE 0 END) AS emoji,
    sum(status = 'done' AND source = 'text') AS texts,
    sum(status = 'done' AND source = 'album') AS albums,
    sum(status = 'appended') AS appended,
    sum(status = 'running') AS running,
    sum(status = 'draft') AS drafts,
    sum(status = 'failed' AND created_at > ${day}) AS failed24,
    sum(status = 'deleted') AS deleted,
    sum(paid_stars) AS stars,
    sum(CASE WHEN created_at > ${day} THEN paid_stars ELSE 0 END) AS stars24,
    sum(used_credit) AS gifts
    FROM jobs`);
  const n = (v) => v || 0;
  return [
    '📊 Статистика',
    '',
    `👤 Пользователи: ${n(u.total)} (новых за 24ч: ${n(u.fresh)}, активных: ${n(u.active)})`,
    `🤝 По рефссылкам: ${n(u.referred)} · неиспользованных подарков: ${n(u.credits)}`,
    `🚫 Забанено: ${n(u.banned)} · заблокировали бота: ${n(u.blocked)}`,
    `👑 VIP: ${n(u.vip)} · ⭐ Pro активных: ${n(u.pro)} · Stars за Pro всего: ${n(u.pro_stars)}`,
    '',
    `🧩 Паков готово: ${n(j.done)} (за 24ч: ${n(j.done24)}), эмодзи: ${n(j.emoji)}`,
    `   из них надписей: ${n(j.texts)}, коллажей: ${n(j.albums)}, дополнений: ${n(j.appended)}`,
    `⏳ Собирается: ${n(j.running)} · превью без ответа: ${n(j.drafts)}`,
    `❌ Ошибок за 24ч: ${n(j.failed24)} · 🗑 удалено: ${n(j.deleted)}`,
    `⭐ Stars: ${n(j.stars)} (за 24ч: ${n(j.stars24)}) · 🎁 подарков потрачено: ${n(j.gifts)}`,
  ].join('\n');
}
