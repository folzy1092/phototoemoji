// Plans:
//   free  — packs up to FREE_TILES emoji free, bigger ones for Stars;
//           FREE_LIMITS free packs and stickers per day (generous)
//   pro   — Telegram Stars subscription, PRO_PRICE per 30 days: no daily
//           limits, packs of any size free
//   vip   — the same as Pro, granted by the owner (/vip), forever or for N days
//   owner — everything
//
// There is no queue to jump: every request is processed right away in its own
// invocation, so the perks are limits, not priority.
//
// Price: 1 ⭐ costs a buyer about $0.013–0.02 (≈1.3–1.9 ₽), so 99 ⭐ ≈ $1.3–2
// a month. A big pack is 25 ⭐, so Pro pays off from the 4th big pack.

import { db } from 'sdk';
import { api } from './premium.js'; // premium emoji applied
import { sql } from 'sdk/db';
import { OWNER_ID, FREE_TILES, MAX_TILES } from './emojipack.js';
import { log, esc } from './log.js';

export const PRO_PRICE = 99;
export const PRO_PERIOD = 30 * 24 * 3600; // Telegram requires exactly 30 days for subscriptions
export const VIP_FOREVER = 4102444800;    // 2100-01-01
export const FREE_LIMITS = { pack: 10, sticker: 15 };

const now = () => Math.floor(Date.now() / 1000);
const today = () => new Date().toISOString().slice(0, 10);
export const fmtDate = (s) => {
  const d = new Date(s * 1000);
  return `${String(d.getUTCDate()).padStart(2, '0')}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${d.getUTCFullYear()}`;
};

/** { plan: 'owner' | 'vip' | 'pro' | 'free', until } */
export async function planOf(userId) {
  if (userId === OWNER_ID) return { plan: 'owner', until: VIP_FOREVER };
  const u = await db.get(sql`SELECT vip_until, pro_until FROM users WHERE id = ${userId}`);
  const t = now();
  if (u && u.vip_until > t) return { plan: 'vip', until: u.vip_until };
  if (u && u.pro_until > t) return { plan: 'pro', until: u.pro_until };
  return { plan: 'free', until: 0 };
}

export const isPaidPlan = async (userId) => (await planOf(userId)).plan !== 'free';

async function used(userId, kind) {
  const r = await db.get(sql`SELECT n FROM usage WHERE key = ${`${userId}:${today()}:${kind}`}`);
  return r ? r.n : 0;
}

/** Free plan's daily limit: { ok, used, limit } (always ok on paid plans). */
export async function checkLimit(userId, kind) {
  if (await isPaidPlan(userId)) return { ok: true, used: 0, limit: Infinity };
  const n = await used(userId, kind);
  return { ok: n < FREE_LIMITS[kind], used: n, limit: FREE_LIMITS[kind] };
}

export async function countUse(userId, kind) {
  await db.run(sql`INSERT INTO usage (key, n) VALUES (${`${userId}:${today()}:${kind}`}, 1)
    ON CONFLICT(key) DO UPDATE SET n = n + 1`);
}

// ---- the /pro screen ----

export async function proInvoiceLink(T) {
  return api.createInvoiceLink({
    title: T('pro_invoice_title'),
    description: T('pro_invoice_desc'),
    payload: 'pro',
    currency: 'XTR',
    prices: [{ label: T('pro_invoice_label'), amount: PRO_PRICE }],
    subscription_period: PRO_PERIOD,
  });
}

export async function planMessage(user, T) {
  const p = await planOf(user.id);
  const lines = [T('pro_info', { price: PRO_PRICE, free: FREE_TILES, max: MAX_TILES, packs: FREE_LIMITS.pack, stickers: FREE_LIMITS.sticker }), ''];
  if (p.plan === 'free') {
    lines.push(T('plan_free', await used(user.id, 'pack'), FREE_LIMITS.pack, await used(user.id, 'sticker'), FREE_LIMITS.sticker));
    return { text: lines.join('\n'), keyboard: [[{ text: T('btn_pro_buy', PRO_PRICE), url: await proInvoiceLink(T) }]] };
  }
  if (p.plan === 'pro') lines.push(T('plan_pro', fmtDate(p.until)));
  else lines.push(T('plan_vip', p.until >= VIP_FOREVER ? null : fmtDate(p.until)));
  return { text: lines.join('\n'), keyboard: [] };
}

/** A limit was hit: explain and offer Pro. */
export async function sendLimitHit(chatId, kind, limit, T) {
  return api.sendMessage({
    chat_id: chatId,
    text: T(kind === 'pack' ? 'limit_packs' : 'limit_stickers', limit),
    reply_markup: { inline_keyboard: [[{ text: T('btn_pro_more'), callback_data: 'pro:0' }]] },
  });
}

// ---- payments ----

/** successful_payment with payload 'pro': first payment or a monthly renewal. */
export async function onProPaid(message, T) {
  const p = message.successful_payment;
  const until = p.subscription_expiration_date || Math.max(now(), (await planOf(message.from.id)).until) + PRO_PERIOD;
  await db.run(sql`UPDATE users SET pro_until = ${until}, pro_charge = ${p.telegram_payment_charge_id},
    pro_stars = pro_stars + ${p.total_amount} WHERE id = ${message.from.id}`);
  const renewal = !!(p.is_recurring && !p.is_first_recurring);
  await api.sendMessage({ chat_id: message.chat.id, text: T(renewal ? 'pro_renewed' : 'pro_thanks', fmtDate(until)) });
  await log('⭐', renewal ? 'Pro продлён' : 'Pro подключён', {
    user: message.from,
    lines: [`До: ${fmtDate(until)}`, `Сумма: <b>${p.total_amount} ⭐️</b>`, `Charge: <code>${esc(p.telegram_payment_charge_id)}</code>`],
  });
}

// ---- owner: /vip ----

export async function setVip(userId, days) {
  const until = days ? now() + days * 86400 : VIP_FOREVER;
  await db.run(sql`UPDATE users SET vip_until = ${until} WHERE id = ${userId}`);
  return until;
}

export async function removeVip(userId) {
  await db.run(sql`UPDATE users SET vip_until = 0 WHERE id = ${userId}`);
}
