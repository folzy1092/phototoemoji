import { table, integer, text, index, uniqueIndex, sql } from 'sdk/db';

// One row per incoming photo. `key` (chat:message) makes a re-delivered update
// a no-op instead of a second sticker set.
//
// Lifecycle: draft (preview with settings buttons) -> running -> done.
// Side exits: failed, deleted, expired (draft never confirmed), abandoned
// (running for a day without finishing; cleaned up by lib/cleanup.js).
//
// The platform allows only 20 file uploads per invocation, so a pack is built
// in steps: each step re-downloads the photo (`file_id`), renders it with the
// job's settings and uploads the next tiles; `done` counts tiles in the set.
export const jobs = table('jobs', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  key:        text('key').notNull().unique(),
  userId:     integer('user_id').notNull(),
  setName:    text('set_name'),
  cols:       integer('cols'),
  rows:       integer('rows'),
  status:     text('status').notNull().default('running'),
  created:    integer('created_at', { mode: 'timestamp' }).default(sql`(unixepoch())`),
  fileId:     text('file_id'),
  chatId:     integer('chat_id'),
  statusMsg:  integer('status_msg'),
  done:       integer('done').notNull().default(0),
  leaseUntil: integer('lease_until').notNull().default(0), // ms; a step in progress
  // Draft settings (chosen on the preview).
  srcW:       integer('src_w'),
  srcH:       integer('src_h'),
  crop:       text('crop').notNull().default('center'), // start | center | end | fit
  removeBg:   integer('remove_bg').notNull().default(0),
  title:      text('title'),                            // custom part of the pack title
  previewMsg: integer('preview_msg'),
  awaitTitle: integer('await_title').notNull().default(0),
  // Telegram Stars.
  paidStars:  integer('paid_stars').notNull().default(0),
  chargeId:   text('charge_id'),
  finishedAt: integer('finished_at'),                   // unix seconds
  // Where the picture comes from (lib/source.js): 'photo' (file_id),
  // 'album' (files: JSON list of file_ids, collage), 'text' (banner) or 'video'
  // (files: JSON list of the clip's copies, see lib/video.js).
  source:     text('source').notNull().default('photo'),
  files:      text('files'),
  text:       text('text'),
  color:      integer('color').notNull().default(0),    // banner color index
  // Appending to an existing pack: the target job and its sticker count at start.
  appendTo:   integer('append_to'),
  base:       integer('base').notNull().default(0),
  extra:      integer('extra').notNull().default(0),    // stickers appended to THIS pack later
  usedCredit: integer('used_credit').notNull().default(0),
}, (t) => ({
  userIdx: index('idx_jobs_user').on(t.userId),
  statusIdx: index('idx_jobs_status').on(t.status),
}));

// Everyone who wrote to the bot (for /stats and "new user" logs).
export const users = table('users', {
  id:        integer('id').primaryKey(),
  username:  text('username'),
  firstName: text('first_name'),
  firstSeen: integer('first_seen').notNull().default(sql`(unixepoch())`),
  lastSeen:  integer('last_seen').notNull().default(sql`(unixepoch())`),
  lang:      text('lang'),      // chosen bot language (lib/i18n.js), null until chosen
  langCode:  text('lang_code'), // Telegram app language, the fallback
  referredBy: integer('referred_by'),
  refCount:  integer('ref_count').notNull().default(0),
  credits:   integer('credits').notNull().default(0),  // free big packs (referrals, /gift)
  banned:    integer('banned').notNull().default(0),
  blocked:   integer('blocked').notNull().default(0),  // the user blocked the bot (seen on broadcast)
  pending:   text('pending'),                          // 'append:<jobId>' while waiting for a picture
  // Plans (lib/plan.js): VIP is granted by the owner, Pro is a Stars subscription.
  vipUntil:  integer('vip_until').notNull().default(0), // unix seconds; VIP_FOREVER = no end
  proUntil:  integer('pro_until').notNull().default(0), // unix seconds, from the subscription
  proCharge: text('pro_charge'),                       // last subscription payment
  proStars:  integer('pro_stars').notNull().default(0), // Stars paid for Pro in total
});

// Daily usage of the free plan: key "<user>:<YYYY-MM-DD>:<kind>".
export const usage = table('usage', {
  key: text('key').primaryKey(),
  n:   integer('n').notNull().default(0),
});

// Photos of one album (media_group_id): each arrives as its own update.
export const albums = table('albums', {
  groupId:   text('group_id').primaryKey(),
  userId:    integer('user_id').notNull(),
  chatId:    integer('chat_id').notNull(),
  statusMsg: integer('status_msg'),
  created:   integer('created_at').notNull().default(sql`(unixepoch())`),
});

export const albumItems = table('album_items', {
  id:      integer('id').primaryKey({ autoIncrement: true }),
  groupId: text('group_id').notNull(),
  fileId:  text('file_id').notNull(),
  msgId:   integer('msg_id').notNull(),
}, (t) => ({
  // One row per album message even if Telegram re-delivers the update.
  groupMsg: uniqueIndex('uidx_album_items_group_msg').on(t.groupId, t.msgId),
}));

// Owner's broadcasts: a message copied to every user in batches.
export const broadcasts = table('broadcasts', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  fromChat:  integer('from_chat').notNull(),
  messageId: integer('message_id').notNull(),
  cursor:    integer('cursor').notNull().default(0),   // last user id done
  sent:      integer('sent').notNull().default(0),
  failed:    integer('failed').notNull().default(0),
  status:    text('status').notNull().default('ready'), // ready | running | done | cancelled
  created:   integer('created_at').notNull().default(sql`(unixepoch())`),
});

// Small key/value store: log topic ids, cleanup timestamps, locks.
export const settings = table('settings', {
  key:   text('key').primaryKey(),
  value: text('value'),
});
