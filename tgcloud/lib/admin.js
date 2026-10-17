// Owner-only commands (Russian, not in the public menu):
//   /admin                  this list
//   /broadcast              as a reply to any message: copy it to every user
//   /gift <@user|id> [n]    n free big packs (default 1)
//   /refund <pack id | charge id>   refund the Stars paid for a pack
//   /ban <@user|id>, /unban <@user|id>
// A numeric id works even for someone who hasn't written to the bot yet.
//   /user <@user|id>        what we know about a user
//   /vip <@user|id> [days]  VIP (= Pro for free) forever or for N days · /unvip
//
// A broadcast goes out in batches of BATCH users per button press: the
// runtime has ~30 s per invocation and no timers.

import { db, BotApiError } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { OWNER_ID } from './emojipack.js';
import { resolveUser } from './users.js';
import { getJob } from './pack.js';
import { tr } from './i18n.js';
import { planOf, setVip, removeVip, fmtDate, VIP_FOREVER } from './plan.js';
import { log, esc, person } from './log.js';

const BATCH = 200;
const LOCK_MS = 60 * 1000;

const HELP = [
  '🛠 Админка',
  '',
  '/broadcast — ответом на сообщение: разослать его всем',
  '/gift @user|ID [n] — подарить n бесплатных больших паков',
  '/refund <номер пака | charge id> — вернуть Stars за пак',
  '/ban @user|ID · /unban @user|ID',
  '/user @user|ID — информация (там же оплаченные паки)',
  '/vip @user|ID [дней] — VIP: всё как в Pro, бесплатно (без дней — навсегда)',
  '/unvip @user|ID — снять VIP',
  '',
  'ID — числовой Telegram ID, работает и для тех, кто ещё не писал боту.',
  '/stats — статистика',
].join('\n');

export const isOwner = (user) => user && user.id === OWNER_ID;

export async function adminCommand(message, command) {
  const chatId = message.chat.id;
  const args = (message.text || '').split(/\s+/).slice(1);
  const say = (text, extra = {}) => api.sendMessage({ chat_id: chatId, text, ...extra });

  switch (command) {
    case '/admin':
      return say(HELP);

    case '/broadcast': {
      const src = message.reply_to_message;
      if (!src) return say('Ответь командой /broadcast на сообщение, которое нужно разослать.');
      const res = await db.run(sql`INSERT INTO broadcasts (from_chat, message_id) VALUES (${chatId}, ${src.message_id}) RETURNING id`);
      const id = res.rows[0].id;
      const n = await db.get(sql`SELECT count(*) AS n FROM users WHERE banned = 0 AND blocked = 0`);
      return say(`📣 Разослать это сообщение ${n.n} пользователям?\nОтправка идёт пачками по ${BATCH}.`, {
        reply_parameters: { message_id: src.message_id },
        reply_markup: { inline_keyboard: [[{ text: '✅ Начать', callback_data: `bc:${id}` }, { text: '✖️ Отмена', callback_data: `bcx:${id}` }]] },
      });
    }

    case '/gift': {
      const u = await resolveUser(args[0], { create: true });
      const n = Math.max(1, Math.min(100, parseInt(args[1] || '1', 10) || 1));
      if (!u) return say('Пользователь не найден. Укажи @username (если он писал боту) или числовой ID.');
      await db.run(sql`UPDATE users SET credits = credits + ${n} WHERE id = ${u.id}`);
      const T = await tr(u.id);
      try { await api.sendMessage({ chat_id: u.id, text: T('gift_received', n) }); } catch (_) { /* blocked */ }
      await log('🎁', 'Подарок выдан', { user: message.from, lines: [`Кому: ${who(u)}`, `Паков: ${n}`] });
      return say(`🎁 ${who(u, false)}: +${n} бесплатных больших паков.`);
    }

    case '/refund': {
      const key = String(args[0] || '').trim();
      if (!key) return say('Укажи номер пака или charge id: /refund 123');
      // A pack number, or the charge id from the «⭐ Оплата» log card.
      const job = (/^\d+$/.test(key) && (await getJob(+key)))
        || (await db.get(sql`SELECT * FROM jobs WHERE charge_id = ${key}`).then((r) => r && getJob(r.id)));
      if (!job) return say('Пак не найден. Номер пака и charge id — в логах («⭐ Оплата») и в /user.');
      if (!job.paidStars || !job.chargeId) return say('За этот пак не платили (или уже вернули).');
      try {
        await api.refundStarPayment({ user_id: job.userId, telegram_payment_charge_id: job.chargeId });
      } catch (e) {
        return say(`❌ Telegram отказал: ${e.description || e.message}`);
      }
      await db.run(sql`UPDATE jobs SET paid_stars = 0 WHERE id = ${job.id}`);
      await log('↩️', 'Возврат Stars (вручную)', { user: message.from, lines: [`Пак: <code>${job.id}</code>`, `Сумма: <b>${job.paidStars} ⭐️</b>`] });
      return say(`↩️ Вернул ${job.paidStars} ⭐ за пак ${job.id}.`);
    }

    case '/ban': case '/unban': {
      const u = await resolveUser(args[0], { create: command === '/ban' });
      if (!u) return say('Пользователь не найден. Укажи @username (если он писал боту) или числовой ID.');
      if (u.id === OWNER_ID) return say('Себя забанить нельзя 🙂');
      const ban = command === '/ban' ? 1 : 0;
      await db.run(sql`UPDATE users SET banned = ${ban} WHERE id = ${u.id}`);
      await log(ban ? '🚫' : '✅', ban ? 'Бан' : 'Разбан', { user: message.from, lines: [`Кого: ${who(u)}`] });
      return say(`${ban ? '🚫 Забанен' : '✅ Разбанен'}: ${who(u, false)}`);
    }

    case '/vip': {
      const u = await resolveUser(args[0], { create: true });
      if (!u) return say('Пользователь не найден. Укажи @username (если он писал боту) или числовой ID.');
      const days = parseInt(args[1] || '0', 10) || 0;
      const until = await setVip(u.id, days);
      const shown = until >= VIP_FOREVER ? null : fmtDate(until);
      const T = await tr(u.id);
      try { await api.sendMessage({ chat_id: u.id, text: T('vip_granted', shown) }); } catch (_) { /* hasn't started the bot */ }
      await log('👑', 'VIP выдан', { user: message.from, lines: [`Кому: ${who(u)}`, `До: ${shown || 'навсегда'}`] });
      return say(`👑 VIP для ${who(u, false)}: ${shown ? `до ${shown}` : 'навсегда'}.`);
    }

    case '/unvip': {
      const u = await resolveUser(args[0]);
      if (!u) return say('Пользователь не найден.');
      await removeVip(u.id);
      await log('👑', 'VIP снят', { user: message.from, lines: [`Кого: ${who(u)}`] });
      return say(`VIP снят: ${who(u, false)}.`);
    }

    case '/user': {
      const u = await resolveUser(args[0]);
      if (!u) return say('Пользователь не найден.');
      const j = await db.get(sql`SELECT sum(status = 'done') AS done, sum(paid_stars) AS stars, count(*) AS all_jobs FROM jobs WHERE user_id = ${u.id}`);
      const paid = await db.all(sql`SELECT id, cols, rows, paid_stars FROM jobs WHERE user_id = ${u.id} AND paid_stars > 0 ORDER BY id DESC LIMIT 10`);
      const d = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace('T', ' ');
      return say([
        `👤 ${who(u, false)}`,
        `Язык: ${u.lang || '—'} (Telegram: ${u.lang_code || '—'})`,
        await planLine(u.id),
        `Первый раз: ${d(u.first_seen)} · последний: ${d(u.last_seen)}`,
        `Паков: ${j.done || 0} (всего задач: ${j.all_jobs || 0}) · Stars: ${j.stars || 0}`,
        `Пригласил: ${u.ref_count} · подарков: ${u.credits}${u.referred_by ? ` · пришёл от ${u.referred_by}` : ''}`,
        paid.length ? `Оплаченные паки (для /refund): ${paid.map((p) => `${p.id} (${p.cols}×${p.rows}, ${p.paid_stars}⭐)`).join(', ')}` : null,
        u.banned ? '🚫 Забанен' : null,
        u.blocked ? '⛔ Заблокировал бота' : null,
      ].filter(Boolean).join('\n'));
    }
    default:
      return say(HELP);
  }
}

async function planLine(userId) {
  const p = await planOf(userId);
  if (p.plan === 'free') return 'План: бесплатный';
  if (p.plan === 'pro') return `План: ⭐ Pro до ${fmtDate(p.until)}`;
  if (p.plan === 'vip') return `План: 👑 VIP ${p.until >= VIP_FOREVER ? 'навсегда' : `до ${fmtDate(p.until)}`}`;
  return 'План: владелец';
}

function who(u, html = true) {
  if (html) return person(u); // log cards: the owner shows as DEV
  const name = u.username ? `@${u.username}` : u.first_name || 'без имени';
  return `${name} (${u.id})`;
}

/** Broadcast buttons: `bc:<id>` sends the next batch, `bcx:<id>` cancels. */
export async function onBroadcastButton(query, action, id) {
  const answer = (text) => api.answerCallbackQuery({ callback_query_id: query.id, text });
  if (!isOwner(query.from)) return answer();
  const b = await db.get(sql`SELECT * FROM broadcasts WHERE id = ${id}`);
  if (!b || b.status === 'done' || b.status === 'cancelled') return answer('Рассылка уже закончена.');
  const edit = (text, keyboard = []) => api.editMessageText({
    chat_id: query.message.chat.id, message_id: query.message.message_id, text, reply_markup: { inline_keyboard: keyboard },
  }).catch(() => {});

  if (action === 'bcx') {
    await db.run(sql`UPDATE broadcasts SET status = 'cancelled' WHERE id = ${id}`);
    await answer('Отменено');
    return edit(`✖️ Рассылка отменена. Отправлено: ${b.sent}, ошибок: ${b.failed}.`);
  }

  // One batch at a time.
  const now = Date.now();
  const lock = await db.run(sql`INSERT INTO settings (key, value) VALUES (${`bc_lock:${id}`}, ${String(now)})
    ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE CAST(settings.value AS INTEGER) < ${now - LOCK_MS}`);
  if (!lock.rowsAffected) return answer('Уже отправляю, подожди…');
  await answer('Отправляю…');

  let { cursor, sent, failed } = b;
  let limited = false;
  try {
    const users = await db.all(sql`SELECT id FROM users WHERE id > ${cursor} AND banned = 0 AND blocked = 0 ORDER BY id LIMIT ${BATCH}`);
    for (const u of users) {
      try {
        await api.copyMessage({ chat_id: u.id, from_chat_id: b.from_chat, message_id: b.message_id });
        sent++;
      } catch (e) {
        if (e instanceof BotApiError && e.code === 429) { limited = true; break; } // retry this user next batch
        if (e instanceof BotApiError && e.code === 403) await db.run(sql`UPDATE users SET blocked = 1 WHERE id = ${u.id}`);
        failed++;
      }
      cursor = u.id;
    }
    const left = await db.get(sql`SELECT count(*) AS n FROM users WHERE id > ${cursor} AND banned = 0 AND blocked = 0`);
    const done = left.n === 0;
    await db.run(sql`UPDATE broadcasts SET cursor = ${cursor}, sent = ${sent}, failed = ${failed},
      status = ${done ? 'done' : 'running'} WHERE id = ${id}`);
    if (done) {
      await log('📣', 'Рассылка завершена', { user: query.from, lines: [`Отправлено: ${sent}`, `Ошибок / заблокировали: ${failed}`] });
      return edit(`✅ Рассылка завершена.\nОтправлено: ${sent} · ошибок: ${failed}.`);
    }
    return edit(
      `📣 Отправлено: ${sent} · ошибок: ${failed} · осталось: ${left.n}.${limited ? '\nTelegram попросил притормозить — нажми чуть позже.' : ''}`,
      [[{ text: `▶️ Следующие ${BATCH}`, callback_data: `bc:${id}` }, { text: '✖️ Остановить', callback_data: `bcx:${id}` }]],
    );
  } finally {
    // Even if the batch dies midway, nobody gets the message twice.
    await db.run(sql`UPDATE broadcasts SET cursor = ${cursor}, sent = ${sent}, failed = ${failed} WHERE id = ${id}`);
    await db.run(sql`DELETE FROM settings WHERE key = ${`bc_lock:${id}`}`);
  }
}
