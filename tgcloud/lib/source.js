// Where a job's picture comes from:
//   photo — job.fileId (a photo or an image document)
//   album — job.files, a JSON list of file_ids, laid out as a collage
//   text  — job.text, drawn as a pixel-font banner (lib/font.js)
//   video — not a picture: lib/video.js runs ffmpeg on job.files (copies of the clip)
// Every step re-creates the picture from here (nothing big is stored).

import { loadImage } from './emojipack.js';
import { cropResize } from './image.js';

export const MAX_ALBUM = 9;
const CELL = 600;

/** The source image, or null for text jobs (they are drawn per tile size). */
export async function loadSource(job) {
  if (job.source === 'text') return null;
  if (job.source === 'album') {
    const ids = JSON.parse(job.files || '[]').slice(0, MAX_ALBUM);
    const imgs = [];
    for (const id of ids) imgs.push(await loadImage(id));
    return collage(imgs);
  }
  return loadImage(job.fileId);
}

/** 2-3 photos in a row, more in a square-ish grid; each cell center-cropped square. */
export function collageSize(n) {
  const cols = n <= 3 ? n : Math.ceil(Math.sqrt(n));
  return { cols, rows: Math.ceil(n / cols) };
}

export function collage(imgs) {
  const { cols, rows } = collageSize(imgs.length);
  const W = cols * CELL, H = rows * CELL;
  const data = new Uint8Array(W * H * 4);
  imgs.forEach((img, i) => {
    const cell = cropResize(img, CELL, CELL);
    const ox = (i % cols) * CELL, oy = Math.floor(i / cols) * CELL;
    for (let y = 0; y < CELL; y++) {
      data.set(cell.data.subarray(y * CELL * 4, (y + 1) * CELL * 4), ((oy + y) * W + ox) * 4);
    }
  });
  return { width: W, height: H, data };
}
