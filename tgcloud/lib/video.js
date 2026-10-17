// Animated emoji from a video, GIF or round video. Telegram takes video custom
// emoji as VP9 WebM: 100×100, at most 3 s and 30 fps, up to 256 KB, no audio.
// Every step re-downloads the clip and runs ffmpeg (lib/ffmpeg) on its first
// CLIP seconds, framed exactly like a photo (crop start/center/end or fit).
//
// An invocation gets about 3 s of CPU. Decoding 3 s of 720p takes ~0.6 s and
// each tile ~0.13 s, so a step encodes tiles until its time budget is spent —
// usually fewer than the 20 uploads a run allows — and big videos are read
// from a smaller copy Telegram keeps (Video.qualities).

import { api, db } from 'sdk';
import { sql } from 'sdk/db';
import { ffmpegSession } from './ffmpeg/index.js';
import { decodePng } from './png.js';
import { framing, nearestSquare, DEFAULT_COLS, TILE } from './emojipack.js';
import { trimmedAxis } from './image.js';

// Telegram refuses a clip of 3.0 s or more (STICKER_VIDEO_LONG), and a file's
// length is frames / fps plus rounding — so the clip is cut by frame count, with
// a margin, not by time alone.
export const MAX_SECONDS = 3;        // what the user is told
const CLIP = 2.9;                    // seconds read from the source
const MAX_FPS = 30;
const MAX_DOWNLOAD = 20 * 1024 * 1024;
const MAX_PIXELS = 1280 * 736;       // decoding more per frame doesn't fit a step
const STEP_BUDGET_MS = 1900;         // decode + tiles, out of the ~3 s of CPU
// VP9 quality [crf, max kbps]; the next one is tried when a file comes out too big.
// Constrained quality is faster than plain bitrate here (~90 vs ~125 ms a tile),
// and realtime VP9 overshoots a plain bitrate twofold at 512 px.
const TILE_Q = [[24, 300], [34, 150]];
const STICKER_Q = [[36, 400], [44, 250]];
const MAX_BYTES = 255 * 1024;

const VIDEO_MIME = /^(video\/(mp4|webm|quicktime|x-matroska|mpeg|3gpp)|image\/gif)$/i;

/** The video in a message (animation, video, round video, video/GIF file), or null. */
export function videoOf(m) {
  const one = (v, w, h) => ({ id: v.file_id, w, h, size: v.file_size || 0 });
  if (m.animation) return [one(m.animation, m.animation.width, m.animation.height)];
  if (m.video) {
    const q = (m.video.qualities || []).filter((x) => x.codec !== 'av01').map((x) => one(x, x.width, x.height));
    return [one(m.video, m.video.width, m.video.height), ...q];
  }
  if (m.video_note) return [one(m.video_note, m.video_note.length, m.video_note.length)];
  if (m.document && VIDEO_MIME.test(m.document.mime_type || '')) return [one(m.document, 0, 0)];
  return null;
}

export const isVideoMessage = (m) => !!videoOf(m);

/** Copies a bot can download and decode in time; the original first. */
export function usableVariants(variants) {
  return variants.filter((v) => v.size <= MAX_DOWNLOAD && (!v.w || v.w * v.h <= MAX_PIXELS));
}

// The smallest copy that isn't upscaled much for this grid (jobs.files holds the list).
function pickVariant(job) {
  const all = JSON.parse(job.files || '[]');
  const ok = usableVariants(all);
  if (!ok.length) return all.length && all[0].size > MAX_DOWNLOAD ? null : all[0] || null;
  const need = Math.min(1280, Math.max(job.cols || DEFAULT_COLS, job.rows || 0) * TILE);
  const known = ok.filter((v) => v.w).sort((a, b) => a.w * a.h - b.w * b.h);
  if (!known.length) return ok[0];
  return known.find((v) => Math.max(v.w, v.h) >= need) || known[known.length - 1];
}

/** Lets Date.now() move: it is frozen while JS runs, between I/O calls. */
async function clock() {
  await db.get(sql`SELECT 1`);
  return Date.now();
}

/** Download the job's clip into a fresh ffmpeg session: { ff, info }. */
export async function openClip(job) {
  const v = pickVariant(job);
  if (!v) throw new Error('FILE_TOO_BIG');
  const bytes = await api.getFileContent(v.id);
  const ff = await ffmpegSession();
  ff.write('in', bytes);
  const info = ff.probe('in');
  if (!info.width || !info.height) throw new Error('VIDEO_UNREADABLE');
  if (info.width * info.height > MAX_PIXELS) throw new Error('VIDEO_HEAVY');
  // Whole frames per second (29.97 -> 30), at most 30.
  info.fps = Math.max(1, Math.min(MAX_FPS, Math.round(info.fps || MAX_FPS)));
  return { ff, info };
}

/** Output option capping the frame count: always under MAX_SECONDS at this fps. */
const frameCap = (info) => ['-frames:v', String(Math.max(1, Math.floor(info.fps * (MAX_SECONDS - 0.05))))];

const even = (n) => Math.max(2, n - (n % 2));

/**
 * Filter chain: the clip framed like the job, scaled to a W×H grid picture,
 * keeping only output rows [y0, y1). Fit mode pads with transparency (or
 * `padColor` for previews).
 */
function frameChain(job, info, W, H, y0 = 0, y1 = H, { flags = 'bicubic', padColor = null } = {}) {
  const { width: sw, height: sh } = info;
  const f = [`fps=${info.fps}`];
  const bandH = y1 - y0;
  if (job.crop === 'fit') {
    const k = Math.min(W / sw, H / sh);
    const dw = Math.max(1, Math.min(W, Math.round(sw * k)));
    const dh = Math.max(1, Math.min(H, Math.round(sh * k)));
    f.push(`scale=${dw}:${dh}:flags=${flags}`);
    if (dw < W || dh < H) {
      f.push(padColor ? 'format=yuv420p' : 'format=yuva420p');
      f.push(`pad=${W}:${H}:${Math.floor((W - dw) / 2)}:${Math.floor((H - dh) / 2)}:color=${padColor || 'black@0'}`);
    }
    if (bandH < H) f.push(`crop=${W}:${bandH}:0:${y0}:exact=1`);
    return f.join(',');
  }
  // Same crop as lib/image.js cropResize: the target aspect, `align` along the trimmed axis.
  const { align } = framing(job);
  let cw = sw, ch = sh;
  if (sw / sh > W / H) cw = (sh * W) / H;
  else ch = (sw * H) / W;
  const cx = (sw - cw) * align, cy = (sh - ch) * align;
  // Only the source rows that make output rows [y0, y1): less to scale.
  const top = cy + (ch * y0) / H, bottom = cy + (ch * y1) / H;
  const sx0 = Math.floor(cx), sx1 = Math.min(sw, Math.ceil(cx + cw));
  const sy0 = Math.floor(top), sy1 = Math.min(sh, Math.ceil(bottom));
  const kx = W / cw, ky = H / ch;
  const outW = Math.max(W, Math.round((sx1 - sx0) * kx));
  const outH = Math.max(bandH, Math.round((sy1 - sy0) * ky));
  const ox = Math.min(outW - W, Math.max(0, Math.round((cx - sx0) * kx)));
  const oy = Math.min(outH - bandH, Math.max(0, Math.round((top - sy0) * ky)));
  f.push(`crop=${sx1 - sx0}:${sy1 - sy0}:${sx0}:${sy0}:exact=1`);
  f.push(`scale=${outW}:${outH}:flags=${flags}`);
  if (outW !== W || outH !== bandH) f.push(`crop=${W}:${bandH}:${ox}:${oy}:exact=1`);
  return f.join(',');
}

/** Fit mode leaves transparent margins: tiles then carry an alpha channel. */
const hasAlpha = (job) => job.crop === 'fit' && !!trimmedAxis(job.srcW, job.srcH, job.cols, job.rows);

function previewTile(job) {
  return even(Math.max(16, Math.min(80, Math.floor(720 / Math.max(job.cols, job.rows)))));
}

/** The animated preview: the grid picture with tile lines, as MP4 (sent as an animation). */
export function previewMp4({ ff, info }, job) {
  const t = previewTile(job);
  const W = job.cols * t, H = job.rows * t;
  const f = [frameChain(job, info, W, H, 0, H, { flags: 'fast_bilinear', padColor: '0xDADADA' })];
  // Light line with a dark shadow, like the photo preview.
  for (let c = 1; c < job.cols; c++) {
    f.push(`drawbox=x=${c * t - 1}:y=0:w=1:h=${H}:color=black@0.35:t=fill`, `drawbox=x=${c * t}:y=0:w=1:h=${H}:color=white@0.7:t=fill`);
  }
  for (let r = 1; r < job.rows; r++) {
    f.push(`drawbox=x=0:y=${r * t - 1}:w=${W}:h=1:color=black@0.35:t=fill`, `drawbox=x=0:y=${r * t}:w=${W}:h=1:color=white@0.7:t=fill`);
  }
  f.push('format=yuv420p');
  ff.exec(['-t', String(CLIP), '-i', 'in', '-vf', f.join(','), ...frameCap(info), '-an',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-movflags', '+faststart', 'preview.mp4']);
  const out = ff.read('preview.mp4');
  ff.remove('preview.mp4');
  return out;
}

/** The first frame of the grid picture (RGBA, `tile` px per emoji) — for "👁 as in Telegram". */
export function firstFrame({ ff, info }, job, tile) {
  const chain = `${frameChain(job, info, job.cols * tile, job.rows * tile)},format=rgba`;
  ff.exec(['-t', String(CLIP), '-i', 'in', '-vf', chain, '-frames:v', '1', '-c:v', 'png', '-f', 'image2', 'frame.png']);
  const img = decodePng(ff.read('frame.png'));
  ff.remove('frame.png');
  return img;
}

function vp9(fmt, [crf, kbps]) {
  return ['-an', '-c:v', 'libvpx-vp9', '-pix_fmt', fmt, '-crf', String(crf), '-b:v', `${kbps}k`,
    '-deadline', 'realtime', '-cpu-used', '8', '-f', 'webm'];
}

// A tile's emoji: the colored square nearest to its first frame's average color
// (yuv420p / yuva420p planes, BT.601).
function tileEmojiYuv(raw, W, H, x0, y0, alpha) {
  const ySize = W * H, cSize = (W / 2) * (H / 2);
  let Y = 0, U = 0, V = 0, A = 0, n = 0;
  for (let y = y0; y < y0 + TILE; y += 2) {
    for (let x = x0; x < x0 + TILE; x += 2) {
      const a = alpha ? raw[ySize + 2 * cSize + y * W + x] : 255;
      const c = (y >> 1) * (W >> 1) + (x >> 1);
      Y += raw[y * W + x] * a; U += raw[ySize + c] * a; V += raw[ySize + cSize + c] * a; A += a; n++;
    }
  }
  if (A / n < 64) return '⬜'; // mostly transparent
  Y = Y / A - 16; U = U / A - 128; V = V / A - 128;
  const clamp = (v) => Math.max(0, Math.min(255, v));
  return nearestSquare(clamp(1.164 * Y + 1.596 * V), clamp(1.164 * Y - 0.392 * U - 0.813 * V), clamp(1.164 * Y + 2.017 * U));
}

/**
 * WebM emoji for tiles [from, to) in reading order: [{ webm, emoji }].
 * Stops early (after at least one tile) when the step's time is spent.
 */
export async function videoTiles(job, from, to) {
  const clip = await openClip(job);
  const { ff, info } = clip;
  const start = await clock();
  const W = job.cols * TILE;
  const r0 = Math.floor(from / job.cols), r1 = Math.ceil(to / job.cols);
  const bandH = (r1 - r0) * TILE;
  const alpha = hasAlpha(job);
  const fmt = alpha ? 'yuva420p' : 'yuv420p';

  ff.exec(['-t', String(CLIP), '-i', 'in', '-vf', `${frameChain(job, info, W, job.rows * TILE, r0 * TILE, r1 * TILE)},format=${fmt}`,
    ...frameCap(info), '-an', '-f', 'rawvideo', 'band.yuv']);
  ff.remove('in');
  const raw = ff.read('band.yuv');
  if (!raw || raw.length < W * bandH * (alpha ? 2.5 : 1.5)) throw new Error('VIDEO_UNREADABLE');

  const out = [];
  let decoded = 0;
  for (let i = from; i < to; i++) {
    const x = (i % job.cols) * TILE, y = (Math.floor(i / job.cols) - r0) * TILE;
    const input = ['-f', 'rawvideo', '-pix_fmt', fmt, '-s', `${W}x${bandH}`, '-r', String(info.fps), '-i', 'band.yuv',
      '-vf', `crop=${TILE}:${TILE}:${x}:${y}`];
    let webm = null;
    for (const q of TILE_Q) {
      ff.exec([...input, ...vp9(fmt, q), 'tile.webm']);
      webm = ff.read('tile.webm');
      if (webm.length <= MAX_BYTES) break;
    }
    if (webm.length > MAX_BYTES) throw new Error('VIDEO_TILE_BIG');
    out.push({ webm, emoji: tileEmojiYuv(raw, W, bandH, x, y, alpha) });

    if (i + 1 >= to) break;
    const spent = (await clock()) - start;
    if (!decoded) decoded = spent; // the first tile's time includes decoding
    const perTile = out.length > 1 ? (spent - decoded) / (out.length - 1) : Math.max(150, spent * 0.25);
    if (spent + perTile > STEP_BUDGET_MS) break;
  }
  return out;
}

/** 🎭 A video sticker: one side 512 px, the previewed framing. */
export async function videoStickerWebm(job, w, h) {
  const { ff, info } = await openClip(job);
  const fmt = hasAlpha(job) ? 'yuva420p' : 'yuv420p';
  ff.exec(['-t', String(CLIP), '-i', 'in', '-vf', `${frameChain(job, info, w, h)},format=${fmt}`, ...frameCap(info), '-an', '-f', 'rawvideo', 'frames.yuv']);
  ff.remove('in');
  const input = ['-f', 'rawvideo', '-pix_fmt', fmt, '-s', `${w}x${h}`, '-r', String(info.fps), '-i', 'frames.yuv'];
  for (const q of STICKER_Q) {
    ff.exec([...input, ...vp9(fmt, q), 'sticker.webm']);
    const webm = ff.read('sticker.webm');
    if (webm.length <= MAX_BYTES) return webm;
  }
  throw new Error('VIDEO_TILE_BIG');
}
