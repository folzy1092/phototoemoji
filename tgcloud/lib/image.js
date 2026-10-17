// Image helpers: decode, crop/fit + resample, background removal, sharpening,
// the grid preview and slicing into square PNG tiles. All images are
// { width, height, data: Uint8Array RGBA }.

import { decodeJpeg, isJpeg } from './jpeg.js';
import { decodePng, isPng, encodePng } from './png.js';

/** Read width/height from the header without decoding, or null. */
export function probeSize(bytes) {
  if (isPng(bytes)) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (isJpeg(bytes)) {
    let p = 2;
    while (p + 9 < bytes.length) {
      if (bytes[p] !== 0xff) return null;
      const m = bytes[p + 1];
      if (m === 0xff) { p++; continue; }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { height: (bytes[p + 5] << 8) | bytes[p + 6], width: (bytes[p + 7] << 8) | bytes[p + 8] };
      }
      p += 2 + ((bytes[p + 2] << 8) | bytes[p + 3]);
    }
  }
  return null;
}

export function decodeImage(bytes) {
  if (isJpeg(bytes)) return decodeJpeg(bytes);
  if (isPng(bytes)) return decodePng(bytes);
  throw new Error('UNSUPPORTED_FORMAT');
}

// For each output pixel along one axis: [srcIndex, weight, srcIndex, weight, ...].
// Area averaging when shrinking, bilinear when enlarging.
function axisTaps(srcStart, srcLen, outLen, srcMax) {
  const span = srcLen / outLen;
  const taps = [];
  for (let o = 0; o < outLen; o++) {
    const t = [];
    if (span > 1) {
      const a = srcStart + o * span;
      const b = a + span;
      for (let s = Math.floor(a); s < Math.ceil(b); s++) {
        const w = Math.min(b, s + 1) - Math.max(a, s);
        if (w > 0) t.push(Math.min(Math.max(s, 0), srcMax - 1), w);
      }
    } else {
      let c = srcStart + (o + 0.5) * span - 0.5;
      c = Math.min(Math.max(c, 0), srcMax - 1);
      const s0 = Math.floor(c);
      const f = c - s0;
      t.push(s0, 1 - f);
      if (f > 0) t.push(Math.min(s0 + 1, srcMax - 1), f);
    }
    let sum = 0;
    for (let i = 1; i < t.length; i += 2) sum += t[i];
    for (let i = 1; i < t.length; i += 2) t[i] /= sum;
    taps.push(t);
  }
  return taps;
}

/** Resample the source rect (cx, cy, cw, ch) to outW x outH, premultiplied alpha. */
function resample(img, cx, cy, cw, ch, outW, outH) {
  const { width: sw, height: sh, data } = img;
  const xt = axisTaps(cx, cw, outW, sw);
  const yt = axisTaps(cy, ch, outH, sh);
  const y0 = Math.max(0, Math.floor(cy));
  const y1 = Math.min(sh, Math.ceil(cy + ch) + 1);

  const rows = y1 - y0;
  const mid = new Float32Array(outW * rows * 4);
  for (let y = 0; y < rows; y++) {
    const src = (y + y0) * sw * 4;
    for (let x = 0; x < outW; x++) {
      const t = xt[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < t.length; i += 2) {
        const p = src + t[i] * 4;
        const w = t[i + 1];
        const al = data[p + 3] * w;
        r += data[p] * al;
        g += data[p + 1] * al;
        b += data[p + 2] * al;
        a += al;
      }
      const o = (y * outW + x) * 4;
      mid[o] = r;
      mid[o + 1] = g;
      mid[o + 2] = b;
      mid[o + 3] = a;
    }
  }

  const out = new Uint8Array(outW * outH * 4);
  for (let y = 0; y < outH; y++) {
    const t = yt[y];
    for (let x = 0; x < outW; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let i = 0; i < t.length; i += 2) {
        const p = ((t[i] - y0) * outW + x) * 4;
        const w = t[i + 1];
        r += mid[p] * w;
        g += mid[p + 1] * w;
        b += mid[p + 2] * w;
        a += mid[p + 3] * w;
      }
      const o = (y * outW + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = Math.round(a);
    }
  }
  return { width: outW, height: outH, data: out };
}

/**
 * Make an outW x outH image from `img`.
 * - fit=false: crop to the target aspect; `align` (0..1) picks which part of the
 *   trimmed axis stays (0 = top/left, 0.5 = center, 1 = bottom/right).
 * - fit=true: the whole image, centered, on a transparent canvas.
 */
export function cropResize(img, outW, outH, { fit = false, align = 0.5 } = {}) {
  const { width: sw, height: sh } = img;
  if (!fit) {
    let cw = sw, ch = sh;
    if (sw / sh > outW / outH) cw = (sh * outW) / outH;
    else ch = (sw * outH) / outW;
    return resample(img, (sw - cw) * align, (sh - ch) * align, cw, ch, outW, outH);
  }
  const scale = Math.min(outW / sw, outH / sh);
  const dw = Math.max(1, Math.min(outW, Math.round(sw * scale)));
  const dh = Math.max(1, Math.min(outH, Math.round(sh * scale)));
  const inner = resample(img, 0, 0, sw, sh, dw, dh);
  const out = new Uint8Array(outW * outH * 4);
  const ox = Math.floor((outW - dw) / 2);
  const oy = Math.floor((outH - dh) / 2);
  for (let y = 0; y < dh; y++) {
    out.set(inner.data.subarray(y * dw * 4, (y + 1) * dw * 4), ((oy + y) * outW + ox) * 4);
  }
  return { width: outW, height: outH, data: out };
}

/** Which axis a crop trims for this image and grid: 'x', 'y' or null. */
export function trimmedAxis(width, height, cols, rows) {
  const a = width / height, g = cols / rows;
  if (Math.abs(a - g) / g < 0.01) return null;
  return a > g ? 'x' : 'y';
}

/**
 * Make a uniform background transparent: flood fill from the borders through
 * pixels close to the dominant border color, with a soft edge.
 * Returns null when the border has no dominant color (nothing to remove).
 */
export function removeBackground(img, tolerance = 40) {
  const { width: w, height: h, data } = img;
  const border = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);

  // Dominant border color: most common 4-bit-per-channel bucket.
  const buckets = new Map();
  for (const i of border) {
    const p = i * 4;
    if (data[p + 3] < 128) continue;
    const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  let bestKey = -1, bestCount = 0;
  for (const [k, c] of buckets) if (c > bestCount) { bestKey = k; bestCount = c; }
  if (bestKey < 0 || bestCount < border.length * 0.3) return null;

  let br = 0, bg = 0, bb = 0, n = 0;
  for (const i of border) {
    const p = i * 4;
    const key = ((data[p] >> 4) << 8) | ((data[p + 1] >> 4) << 4) | (data[p + 2] >> 4);
    if (key === bestKey) { br += data[p]; bg += data[p + 1]; bb += data[p + 2]; n++; }
  }
  br /= n; bg /= n; bb /= n;
  const dist = (p) => Math.hypot(data[p] - br, data[p + 1] - bg, data[p + 2] - bb);

  const out = new Uint8Array(data);
  const seen = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0, tail = 0;
  for (const i of border) {
    if (!seen[i] && (data[i * 4 + 3] === 0 || dist(i * 4) < tolerance)) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    out[i * 4 + 3] = 0;
    const x = i % w, y = (i / w) | 0;
    const next = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1];
    for (const j of next) {
      if (j < 0 || seen[j]) continue;
      if (data[j * 4 + 3] === 0 || dist(j * 4) < tolerance) {
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  if (tail === 0) return null;

  // Soft edge: neighbours of the removed area that are still close-ish to the background.
  for (let i = 0; i < w * h; i++) {
    if (seen[i]) continue;
    const x = i % w, y = (i / w) | 0;
    const touches = (x > 0 && seen[i - 1]) || (x < w - 1 && seen[i + 1]) || (y > 0 && seen[i - w]) || (y < h - 1 && seen[i + w]);
    if (!touches) continue;
    const d = dist(i * 4);
    if (d < tolerance * 2) out[i * 4 + 3] = Math.round(out[i * 4 + 3] * Math.max(0.15, (d - tolerance) / tolerance));
  }
  return { width: w, height: h, data: out };
}

/** Unsharp mask (3x3 box blur), in place on RGB of visible pixels. */
export function sharpen(img, amount = 0.5) {
  const { width: w, height: h, data } = img;
  const src = new Uint8Array(data);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const o = (y * w + x) * 4;
      if (src[o + 3] === 0) continue;
      for (let c = 0; c < 3; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const row = ((y + dy) * w + x) * 4 + c;
          s += src[row - 4] + src[row] + src[row + 4];
        }
        const v = src[o + c] + amount * (src[o + c] - s / 9);
        data[o + c] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
      }
    }
  }
  return img;
}

/**
 * The whole grid as one image: cols*tile x rows*tile.
 * opts: { fit, align, removeBg, sharpen }.
 */
export function renderGrid(img, cols, rows, tile, opts = {}) {
  let src = img;
  if (opts.removeBg) src = removeBackground(img) || img;
  const big = cropResize(src, cols * tile, rows * tile, { fit: opts.fit, align: opts.align ?? 0.5 });
  if (opts.sharpen !== false) sharpen(big, 0.5);
  return big;
}

/** PNG bytes for tiles [from, to) of a rendered grid, in reading order. */
export function sliceTiles(big, cols, tile, from, to) {
  const tiles = [];
  for (let i = from; i < to; i++) {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const px = new Uint8Array(tile * tile * 4);
    for (let y = 0; y < tile; y++) {
      const src = ((r * tile + y) * big.width + c * tile) * 4;
      px.set(big.data.subarray(src, src + tile * 4), y * tile * 4);
    }
    tiles.push(encodePng({ width: tile, height: tile, data: px }));
  }
  return tiles;
}

/** Back-compat helper: render with defaults and slice. */
export function sliceToPngTiles(img, cols, rows, size = 100, from = 0, to = cols * rows) {
  return sliceTiles(renderGrid(img, cols, rows, size), cols, size, from, to);
}

/**
 * Preview: the rendered grid over a checkerboard (shows transparency) with
 * tile borders drawn on top. Returns opaque PNG bytes.
 */
export function previewPng(big, cols, rows, tile) {
  const { width: w, height: h, data } = big;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const check = ((x >> 3) + (y >> 3)) & 1 ? 205 : 245;
      const a = data[o + 3] / 255;
      out[o] = Math.round(data[o] * a + check * (1 - a));
      out[o + 1] = Math.round(data[o + 1] * a + check * (1 - a));
      out[o + 2] = Math.round(data[o + 2] * a + check * (1 - a));
      out[o + 3] = 255;
    }
  }
  // Grid lines: light line with a dark shadow so they show on any picture.
  const blend = (o, v, k) => {
    out[o] = Math.round(out[o] * (1 - k) + v * k);
    out[o + 1] = Math.round(out[o + 1] * (1 - k) + v * k);
    out[o + 2] = Math.round(out[o + 2] * (1 - k) + v * k);
  };
  for (let c = 1; c < cols; c++) {
    const x = c * tile;
    for (let y = 0; y < h; y++) {
      blend((y * w + x) * 4, 255, 0.7);
      blend((y * w + x - 1) * 4, 0, 0.35);
    }
  }
  for (let r = 1; r < rows; r++) {
    const y = r * tile;
    for (let x = 0; x < w; x++) {
      blend((y * w + x) * 4, 255, 0.7);
      blend(((y - 1) * w + x) * 4, 0, 0.35);
    }
  }
  return encodePng({ width: w, height: h, data: out });
}

/**
 * "How it looks in Telegram": the tiles as a message shows them, with small
 * gaps between emoji, on the dark theme (top) and the light theme (bottom).
 */
export function telegramViewPng(big, cols, rows, tile) {
  const gap = Math.max(2, Math.round(tile * 0.1));
  const pad = Math.round(tile * 0.5);
  const pw = cols * tile + (cols - 1) * gap + pad * 2;
  const ph = rows * tile + (rows - 1) * gap + pad * 2;
  const W = pw, H = ph * 2;
  const out = new Uint8Array(W * H * 4);
  const themes = [[24, 33, 43], [255, 255, 255]];
  themes.forEach((bg, p) => {
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < W; x++) {
        const o = ((p * ph + y) * W + x) * 4;
        out[o] = bg[0]; out[o + 1] = bg[1]; out[o + 2] = bg[2]; out[o + 3] = 255;
      }
    }
    for (let i = 0; i < cols * rows; i++) {
      const tc = i % cols, tr = Math.floor(i / cols);
      const dx = pad + tc * (tile + gap), dy = p * ph + pad + tr * (tile + gap);
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const s = ((tr * tile + y) * big.width + tc * tile + x) * 4;
          const a = big.data[s + 3] / 255;
          if (!a) continue;
          const o = ((dy + y) * W + dx + x) * 4;
          out[o] = Math.round(big.data[s] * a + out[o] * (1 - a));
          out[o + 1] = Math.round(big.data[s + 1] * a + out[o + 1] * (1 - a));
          out[o + 2] = Math.round(big.data[s + 2] * a + out[o + 2] * (1 - a));
        }
      }
    }
  });
  return encodePng({ width: W, height: H, data: out });
}
