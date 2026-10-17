// Minimal zlib (RFC 1950/1951) in pure JS: inflate for reading PNGs,
// a fixed-Huffman LZ77 deflate for writing them. No npm in the runtime.

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// ---------- inflate ----------

function buildHuffman(lengths) {
  const count = new Uint16Array(16);
  const symbol = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  count[0] = 0;
  const offs = new Uint16Array(16);
  for (let len = 1; len < 15; len++) offs[len + 1] = offs[len] + count[len];
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) symbol[offs[lengths[i]]++] = i;
  return { count, symbol };
}

let FIXED_LIT = null;
let FIXED_DIST = null;
function fixedTables() {
  if (!FIXED_LIT) {
    const l = new Uint8Array(288);
    for (let i = 0; i < 144; i++) l[i] = 8;
    for (let i = 144; i < 256; i++) l[i] = 9;
    for (let i = 256; i < 280; i++) l[i] = 7;
    for (let i = 280; i < 288; i++) l[i] = 8;
    FIXED_LIT = buildHuffman(l);
    FIXED_DIST = buildHuffman(new Uint8Array(30).fill(5));
  }
}

/** Inflate a zlib stream (2-byte header, deflate data, adler32). */
export function zlibInflate(data) {
  return inflateRaw(data, 2);
}

export function inflateRaw(data, start = 0) {
  let pos = start;
  let bitBuf = 0;
  let bitCnt = 0;
  let out = new Uint8Array(Math.max(1024, data.length * 4));
  let outLen = 0;

  function ensure(n) {
    if (outLen + n <= out.length) return;
    let size = out.length * 2;
    while (size < outLen + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(out.subarray(0, outLen));
    out = next;
  }
  function bits(n) {
    while (bitCnt < n) {
      if (pos >= data.length) throw new Error('inflate: unexpected end of data');
      bitBuf |= data[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return v;
  }
  function decode(h) {
    let code = 0, first = 0, index = 0;
    for (let len = 1; len < 16; len++) {
      code |= bits(1);
      const count = h.count[len];
      if (code - count < first) return h.symbol[index + (code - first)];
      index += count;
      first += count;
      first <<= 1;
      code <<= 1;
    }
    throw new Error('inflate: bad huffman code');
  }
  function codes(lit, dist) {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
      } else if (sym === 256) {
        return;
      } else {
        sym -= 257;
        if (sym >= 29) throw new Error('inflate: bad length symbol');
        const len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dist);
        if (ds >= 30) throw new Error('inflate: bad distance symbol');
        const d = DBASE[ds] + bits(DEXT[ds]);
        if (d > outLen) throw new Error('inflate: distance too far');
        ensure(len);
        for (let i = 0; i < len; i++, outLen++) out[outLen] = out[outLen - d];
      }
    }
  }

  let last;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0;
      const len = data[pos] | (data[pos + 1] << 8);
      pos += 4;
      ensure(len);
      out.set(data.subarray(pos, pos + len), outLen);
      pos += len;
      outLen += len;
    } else if (type === 1) {
      fixedTables();
      codes(FIXED_LIT, FIXED_DIST);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      const cl = new Uint8Array(19);
      for (let i = 0; i < ncode; i++) cl[CLORDER[i]] = bits(3);
      const clh = buildHuffman(cl);
      const lengths = new Uint8Array(nlen + ndist);
      for (let i = 0; i < nlen + ndist;) {
        const sym = decode(clh);
        if (sym < 16) {
          lengths[i++] = sym;
        } else {
          let rep, val = 0;
          if (sym === 16) {
            if (i === 0) throw new Error('inflate: repeat with no previous length');
            val = lengths[i - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) {
            rep = 3 + bits(3);
          } else {
            rep = 11 + bits(7);
          }
          while (rep--) lengths[i++] = val;
        }
      }
      codes(buildHuffman(lengths.subarray(0, nlen)), buildHuffman(lengths.subarray(nlen)));
    } else {
      throw new Error('inflate: bad block type');
    }
  } while (!last);

  return out.subarray(0, outLen);
}

// ---------- deflate (fixed Huffman + LZ77) ----------

const LEN_SYM = new Uint16Array(259);
const LEN_IDX = new Uint8Array(259);
for (let i = 0; i < 29; i++) {
  const end = i < 28 ? LBASE[i + 1] : 259;
  for (let l = LBASE[i]; l < end && l < 259; l++) {
    LEN_SYM[l] = 257 + i;
    LEN_IDX[l] = i;
  }
}
LEN_SYM[258] = 285;
LEN_IDX[258] = 28;

function distIndex(d) {
  let i = 0;
  while (i < 29 && DBASE[i + 1] <= d) i++;
  return i;
}

function reverse(code, len) {
  let r = 0;
  for (let i = 0; i < len; i++) {
    r = (r << 1) | (code & 1);
    code >>= 1;
  }
  return r;
}

// Fixed literal/length codes, pre-reversed for an LSB-first bit writer.
const FIX_CODE = new Uint16Array(288);
const FIX_LEN = new Uint8Array(288);
for (let s = 0; s < 288; s++) {
  let code, len;
  if (s < 144) { code = 0x30 + s; len = 8; }
  else if (s < 256) { code = 0x190 + (s - 144); len = 9; }
  else if (s < 280) { code = s - 256; len = 7; }
  else { code = 0xc0 + (s - 280); len = 8; }
  FIX_CODE[s] = reverse(code, len);
  FIX_LEN[s] = len;
}
const DIST_CODE = new Uint8Array(30);
for (let i = 0; i < 30; i++) DIST_CODE[i] = reverse(i, 5);

export function adler32(data) {
  let a = 1, b = 0;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Compress into a zlib stream. */
export function zlibDeflate(data) {
  const out = new Uint8Array(data.length + (data.length >> 2) + 64);
  let op = 0;
  let bitBuf = 0;
  let bitCnt = 0;
  function put(v, n) {
    bitBuf |= v << bitCnt;
    bitCnt += n;
    while (bitCnt >= 8) {
      out[op++] = bitBuf & 0xff;
      bitBuf >>>= 8;
      bitCnt -= 8;
    }
  }
  function lit(s) {
    put(FIX_CODE[s], FIX_LEN[s]);
  }

  out[op++] = 0x78;
  out[op++] = 0x01;
  put(1, 1); // BFINAL
  put(1, 2); // BTYPE = fixed

  const WSIZE = 32768;
  const HSIZE = 1 << 15;
  const head = new Int32Array(HSIZE).fill(-1);
  const prev = new Int32Array(WSIZE);
  const n = data.length;
  const hash = (i) => (((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & (HSIZE - 1));
  const insert = (i) => {
    const h = hash(i);
    prev[i & (WSIZE - 1)] = head[h];
    head[h] = i;
  };

  let i = 0;
  while (i < n) {
    let bestLen = 0, bestDist = 0;
    if (i + 2 < n) {
      let cand = head[hash(i)];
      let chain = 64;
      const maxLen = Math.min(258, n - i);
      while (cand >= 0 && i - cand <= WSIZE && chain-- > 0) {
        if (data[cand + bestLen] === data[i + bestLen]) {
          let l = 0;
          while (l < maxLen && data[cand + l] === data[i + l]) l++;
          if (l > bestLen) {
            bestLen = l;
            bestDist = i - cand;
            if (l === maxLen) break;
          }
        }
        cand = prev[cand & (WSIZE - 1)];
      }
      insert(i);
    }
    if (bestLen >= 3) {
      lit(LEN_SYM[bestLen]);
      const li = LEN_IDX[bestLen];
      if (LEXT[li]) put(bestLen - LBASE[li], LEXT[li]);
      const di = distIndex(bestDist);
      put(DIST_CODE[di], 5);
      if (DEXT[di]) put(bestDist - DBASE[di], DEXT[di]);
      for (let k = 1; k < bestLen; k++) if (i + k + 2 < n) insert(i + k);
      i += bestLen;
    } else {
      lit(data[i]);
      i++;
    }
  }
  lit(256);
  if (bitCnt > 0) put(0, 8 - bitCnt);

  const a = adler32(data);
  out[op++] = a >>> 24;
  out[op++] = (a >>> 16) & 0xff;
  out[op++] = (a >>> 8) & 0xff;
  out[op++] = a & 0xff;
  return out.slice(0, op);
}
