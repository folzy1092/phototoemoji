// PNG decode (to RGBA) and encode (from RGBA) in pure JS.

import { zlibInflate, zlibDeflate } from './zlib.js';

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(bytes, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function isPng(bytes) {
  return SIGNATURE.every((b, i) => bytes[i] === b);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/** Decode a PNG into { width, height, data: Uint8Array RGBA }. */
export function decodePng(bytes) {
  if (!isPng(bytes)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  let idatLen = 0;

  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const body = bytes.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = view.getUint32(body.byteOffset - bytes.byteOffset);
      height = view.getUint32(body.byteOffset - bytes.byteOffset + 4);
      depth = body[8];
      colorType = body[9];
      interlace = body[12];
    } else if (type === 'PLTE') {
      palette = body;
    } else if (type === 'tRNS') {
      trns = body;
    } else if (type === 'IDAT') {
      idat.push(body);
      idatLen += body.length;
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG: missing IHDR');
  if (interlace) throw new Error('PNG: interlaced images are not supported');

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('PNG: bad color type');

  const zdata = new Uint8Array(idatLen);
  let off = 0;
  for (const part of idat) {
    zdata.set(part, off);
    off += part.length;
  }
  const raw = zlibInflate(zdata);

  const bpp = Math.max(1, (channels * depth) >> 3);
  const stride = (width * channels * depth + 7) >> 3;
  const lines = new Uint8Array(stride * height);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const cur = y * stride;
    const prv = cur - stride;
    for (let x = 0; x < stride; x++) {
      const v = raw[rp++];
      const a = x >= bpp ? lines[cur + x - bpp] : 0;
      const b = y > 0 ? lines[prv + x] : 0;
      const c = x >= bpp && y > 0 ? lines[prv + x - bpp] : 0;
      let p;
      switch (filter) {
        case 0: p = 0; break;
        case 1: p = a; break;
        case 2: p = b; break;
        case 3: p = (a + b) >> 1; break;
        case 4: p = paeth(a, b, c); break;
        default: throw new Error('PNG: bad filter');
      }
      lines[cur + x] = (v + p) & 0xff;
    }
  }

  // Read sample n of a line as 8-bit (scaling low bit depths, truncating 16-bit).
  const maxVal = (1 << depth) - 1;
  function sample(line, n, scale) {
    if (depth === 8) return lines[line + n];
    if (depth === 16) return lines[line + n * 2];
    const bitPos = n * depth;
    const v = (lines[line + (bitPos >> 3)] >> (8 - depth - (bitPos & 7))) & maxVal;
    return scale ? Math.round((v * 255) / maxVal) : v;
  }
  function sample16(line, n) {
    return depth === 16 ? (lines[line + n * 2] << 8) | lines[line + n * 2 + 1] : sample(line, n, false);
  }

  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const line = y * stride;
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r, g, b, a = 255;
      if (colorType === 0) {
        r = g = b = sample(line, x, true);
        if (trns && trns.length >= 2 && sample16(line, x) === ((trns[0] << 8) | trns[1])) a = 0;
      } else if (colorType === 2) {
        r = sample(line, x * 3, true);
        g = sample(line, x * 3 + 1, true);
        b = sample(line, x * 3 + 2, true);
        if (trns && trns.length >= 6 &&
          sample16(line, x * 3) === ((trns[0] << 8) | trns[1]) &&
          sample16(line, x * 3 + 1) === ((trns[2] << 8) | trns[3]) &&
          sample16(line, x * 3 + 2) === ((trns[4] << 8) | trns[5])) a = 0;
      } else if (colorType === 3) {
        const i = sample(line, x, false);
        if (!palette || i * 3 + 2 >= palette.length) throw new Error('PNG: bad palette index');
        r = palette[i * 3];
        g = palette[i * 3 + 1];
        b = palette[i * 3 + 2];
        if (trns && i < trns.length) a = trns[i];
      } else if (colorType === 4) {
        r = g = b = sample(line, x * 2, true);
        a = sample(line, x * 2 + 1, true);
      } else {
        r = sample(line, x * 4, true);
        g = sample(line, x * 4 + 1, true);
        b = sample(line, x * 4 + 2, true);
        a = sample(line, x * 4 + 3, true);
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}

/** Encode RGBA pixels as PNG. Drops the alpha channel if fully opaque. */
export function encodePng({ width, height, data }) {
  let opaque = true;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] !== 255) {
      opaque = false;
      break;
    }
  }
  const ch = opaque ? 3 : 4;
  const stride = width * ch;
  const px = new Uint8Array(stride * height);
  for (let i = 0, j = 0; i < data.length; i += 4) {
    px[j++] = data[i];
    px[j++] = data[i + 1];
    px[j++] = data[i + 2];
    if (!opaque) px[j++] = data[i + 3];
  }

  // Per-row filter choice by minimum sum of absolute differences.
  const raw = new Uint8Array((stride + 1) * height);
  const cand = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = y * stride;
    const prv = cur - stride;
    let bestSum = Infinity;
    let bestFilter = 0;
    let best = null;
    for (let f = 0; f < 5; f++) {
      let sum = 0;
      for (let x = 0; x < stride; x++) {
        const v = px[cur + x];
        const a = x >= ch ? px[cur + x - ch] : 0;
        const b = y > 0 ? px[prv + x] : 0;
        const c = x >= ch && y > 0 ? px[prv + x - ch] : 0;
        let p = 0;
        if (f === 1) p = a;
        else if (f === 2) p = b;
        else if (f === 3) p = (a + b) >> 1;
        else if (f === 4) p = paeth(a, b, c);
        const d = (v - p) & 0xff;
        cand[x] = d;
        sum += d < 128 ? d : 256 - d;
      }
      if (sum < bestSum) {
        bestSum = sum;
        bestFilter = f;
        best = cand.slice();
      }
    }
    const ro = y * (stride + 1);
    raw[ro] = bestFilter;
    raw.set(best, ro + 1);
  }

  const idat = zlibDeflate(raw);
  const ihdr = new Uint8Array(13);
  const hv = new DataView(ihdr.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = opaque ? 2 : 6;

  const chunks = [['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]];
  let total = 8;
  for (const [, body] of chunks) total += 12 + body.length;
  const out = new Uint8Array(total);
  const ov = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let p = 8;
  for (const [type, body] of chunks) {
    ov.setUint32(p, body.length);
    for (let i = 0; i < 4; i++) out[p + 4 + i] = type.charCodeAt(i);
    out.set(body, p + 8);
    ov.setUint32(p + 8 + body.length, crc32(out, p + 4, p + 8 + body.length));
    p += 12 + body.length;
  }
  return out;
}
