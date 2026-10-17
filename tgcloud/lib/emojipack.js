// Grid math, titles, tile emoji, prices and image loading for emoji packs.

import { api, BotApiError } from 'sdk';
import { decodeImage, probeSize, renderGrid } from './image.js';
import { renderBanner } from './font.js';

export const TILE = 100;
export const DEFAULT_COLS = 8;       // the emoji panel shows 8 per row
export const MAX_TILES = 200;        // custom emoji set limit
export const MAX_COLS = 20;
export const PLACEHOLDER = '⬛';
const MAX_PIXELS = 24e6;             // decoding guard for huge documents
const PREVIEW_PER_MESSAGE = 100;

// The bot owner: always free, sees /stats, is the "@owner" in pack titles.
export const OWNER_ID = 7878830498;
export const OWNER_USERNAME = 'cocainemodel';
// How the owner appears in log cards: a plain tag, so the log group doesn't ping them.
export const OWNER_TAG = 'DEV';

// Telegram Stars: packs up to FREE_TILES emoji are free, bigger ones cost PRICE_STARS.
export const FREE_TILES = 100;
export const PRICE_STARS = 25;
// Numbers the help text mentions (lib/i18n.js 'help').
export const HELP_PARAMS = { cols: DEFAULT_COLS, free: FREE_TILES, max: MAX_TILES, price: PRICE_STARS };

export function priceFor(tiles, userId) {
  if (userId === OWNER_ID) return 0;
  return tiles > FREE_TILES ? PRICE_STARS : 0;
}

let botUsername = null;
export async function getBotUsername() {
  if (!botUsername) botUsername = (await api.getMe()).username;
  return botUsername;
}

/** Bot API call that waits out 429 flood limits when the runtime can sleep. */
export async function call(method, params) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await api[method](params);
    } catch (e) {
      const wait = e instanceof BotApiError && e.code === 429 ? e.parameters?.retry_after : 0;
      if (!wait || attempt >= 5 || typeof setTimeout !== 'function') throw e;
      await new Promise((r) => setTimeout(r, wait * 1000 + 250));
    }
  }
}

const GRID_RE = /(^|\s)(\d{1,2})\s*[xх×*]\s*(\d{1,3})(?=\s|$)/i;
const COLS_RE = /(^|\s)(\d{1,2})(?=\s|$)/;
export const TITLE_MAX_CUSTOM = 40;

/**
 * Photo caption -> { cols?, rows?, title? }.
 * "8x10 Мой кот" -> grid 8x10, title "Мой кот"; "8" -> 8 columns; the rest is the title.
 */
export function parseCaption(text) {
  if (!text) return {};
  let rest = text;
  const out = {};
  let m = rest.match(GRID_RE);
  if (m) {
    out.cols = +m[2];
    out.rows = +m[3];
    rest = rest.replace(m[0], ' ');
  } else if ((m = rest.match(COLS_RE))) {
    out.cols = +m[2];
    rest = rest.replace(m[0], ' ');
  }
  rest = rest.replace(/^\s*(название|title)\s*:\s*/i, '').replace(/\s+/g, ' ').trim();
  if (rest) out.title = cleanTitle(rest);
  return out;
}

export function cleanTitle(text) {
  return String(text).replace(/[\r\n\t]+/g, ' ').trim().slice(0, TITLE_MAX_CUSTOM);
}

/** Choose a grid that fits the limits and the image's aspect ratio. */
export function fitGrid(width, height, want) {
  if (want.cols && want.rows) {
    // Explicit grid: shrink proportionally to fit the limits.
    const k = Math.min(1, MAX_COLS / want.cols, Math.sqrt(MAX_TILES / (want.cols * want.rows)));
    return { cols: Math.max(1, Math.floor(want.cols * k)), rows: Math.max(1, Math.floor(want.rows * k)) };
  }
  const cols = Math.min(Math.max(want.cols || DEFAULT_COLS, 1), MAX_COLS);
  return { cols, rows: autoRows(width, height, cols) };
}

export function autoRows(width, height, cols) {
  return Math.min(Math.max(1, Math.round((cols * height) / width)), Math.floor(MAX_TILES / cols));
}

export async function loadImage(fileId) {
  const bytes = await api.getFileContent(fileId);
  const size = probeSize(bytes);
  if (!size) throw new Error('UNSUPPORTED_FORMAT');
  if (size.width * size.height > MAX_PIXELS) throw new Error('TOO_LARGE');
  return decodeImage(bytes);
}

// The job id keeps names unique (Date.now() is frozen between I/O calls in the isolate).
export function makeSetName(userId, jobId, username) {
  return `px${userId}_${jobId}_by_${username}`;
}

const TITLE_MAX = 64;

/**
 * Pack title: "🧩 [custom · ]<author> × @owner · @bot" (the owner's own packs:
 * "🧩 @owner · @bot"). Usernames can be up to
 * 32 chars, so fall back to tighter variants until one fits the 64-char limit.
 *
 * The title must NOT start with "@": the platform's multipart upload (used
 * whenever a request carries files) hangs until the invocation is killed when
 * a string field begins with "@" (curl-style "@file" semantics). Hence the 🧩.
 */
export function packTitle(user, botUsername, custom = null) {
  const owner = `@${OWNER_USERNAME}`;
  const author = user.id === OWNER_ID ? owner : user.username ? `@${user.username}` : (user.first_name || 'emoji').slice(0, 24);
  const bot = `@${botUsername}`;
  const credits = author === owner
    ? [`${owner} · ${bot}`, `${owner}·${bot}`, owner]
    : [`${author} × ${owner} · ${bot}`, `${author}×${owner}·${bot}`, `${author} × ${owner}`, `${author}×${owner}`];
  const variants = [];
  for (const c of credits) {
    if (custom) variants.push(`🧩 ${custom} · ${c}`, `🧩${custom}·${c}`);
  }
  for (const c of credits) variants.push(`🧩 ${c}`, `🧩${c}`);
  if (custom) variants.push(`🧩 ${custom}`);
  return variants.find((t) => t.length <= TITLE_MAX) || variants[variants.length - 1].slice(0, TITLE_MAX);
}

// ---- rendering with a job's settings ----

const ALIGN = { start: 0, center: 0.5, end: 1, fit: 0.5 };
/** cropResize options for a job's framing (same as the preview shows). */
export const framing = (job) => ({ fit: job.crop === 'fit', align: ALIGN[job.crop] ?? 0.5 });

export function renderJob(img, job, tile = TILE) {
  if (job.source === 'text') return renderBanner(job.text, job.color, job.cols, job.rows, tile);
  return renderGrid(img, job.cols, job.rows, tile, {
    fit: job.crop === 'fit',
    align: ALIGN[job.crop] ?? 0.5,
    removeBg: !!job.removeBg,
  });
}

// Colored squares: a tile's emoji is the one nearest to its average color, so
// clients without Premium still see a rough mosaic instead of a black grid.
const SQUARES = [
  ['🟥', 221, 46, 68], ['🟧', 244, 144, 12], ['🟨', 253, 203, 88], ['🟩', 120, 177, 89],
  ['🟦', 85, 172, 238], ['🟪', 170, 142, 214], ['🟫', 193, 105, 79], ['⬛', 49, 55, 61], ['⬜', 230, 231, 232],
];

export function tileEmoji(big, cols, tile, i) {
  const r0 = Math.floor(i / cols) * tile, c0 = (i % cols) * tile;
  let r = 0, g = 0, b = 0, a = 0;
  for (let y = 0; y < tile; y += 2) {
    for (let x = 0; x < tile; x += 2) {
      const o = ((r0 + y) * big.width + c0 + x) * 4;
      const al = big.data[o + 3];
      r += big.data[o] * al; g += big.data[o + 1] * al; b += big.data[o + 2] * al; a += al;
    }
  }
  const n = (tile / 2) * (tile / 2);
  if (a / n < 64) return '⬜'; // mostly transparent
  return nearestSquare(r / a, g / a, b / a);
}

/** The colored square emoji closest to an RGB color. */
export function nearestSquare(r, g, b) {
  let best = SQUARES[0], bestD = Infinity;
  for (const s of SQUARES) {
    const d = (s[1] - r) ** 2 + (s[2] - g) ** 2 + (s[3] - b) ** 2;
    if (d < bestD) { bestD = d; best = s; }
  }
  return best[0];
}

/**
 * Messages that lay the emoji out as the picture: [{ text, entities }].
 * `stickers` are StickerSet.stickers (custom_emoji_id + emoji).
 */
export function previewMessages(stickers, cols, perMessage = PREVIEW_PER_MESSAGE) {
  const rowsPerMsg = Math.max(1, Math.floor(perMessage / cols));
  const messages = [];
  for (let start = 0; start < stickers.length; start += rowsPerMsg * cols) {
    messages.push(artMessage(stickers.slice(start, start + rowsPerMsg * cols), cols));
  }
  return messages;
}

export function artMessage(stickers, cols) {
  let text = '';
  const entities = [];
  stickers.forEach((s, i) => {
    if (i > 0 && i % cols === 0) text += '\n';
    const emoji = s.emoji || PLACEHOLDER;
    entities.push({ type: 'custom_emoji', offset: text.length, length: emoji.length, custom_emoji_id: s.custom_emoji_id });
    text += emoji;
  });
  return { text, entities };
}
