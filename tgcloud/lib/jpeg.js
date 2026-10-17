// JPEG decoder in pure JS: baseline + progressive Huffman, any chroma
// subsampling, restart intervals, grayscale / YCbCr / Adobe RGB / CMYK / YCCK.
// Output: { width, height, data: Uint8Array RGBA }.

const ZIGZAG = new Int32Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

// IDCT basis: IDCT_T[x * 8 + u] = C(u) * cos((2x + 1) u pi / 16) / 2
const IDCT_T = new Float32Array(64);
for (let x = 0; x < 8; x++) {
  for (let u = 0; u < 8; u++) {
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    IDCT_T[x * 8 + u] = (cu * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
  }
}

export function isJpeg(bytes) {
  return bytes[0] === 0xff && bytes[1] === 0xd8;
}

function buildHuffman(counts, symbols) {
  const maxcode = new Int32Array(18);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0, k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1];
    k += counts[l - 1];
    maxcode[l] = counts[l - 1] ? code - 1 : -1;
    code <<= 1;
  }
  maxcode[17] = 0x7fffffff;
  return { maxcode, valptr, mincode, symbols };
}

export function decodeJpeg(data) {
  if (!isJpeg(data)) throw new Error('not a JPEG');
  const len = data.length;
  let pos = 2;
  const qt = [];
  const dcTables = [];
  const acTables = [];
  let frame = null;
  let restartInterval = 0;
  let adobe = null;

  const u16 = (p) => (data[p] << 8) | data[p + 1];

  // ---- bit reader over entropy-coded data ----
  let bitBuf = 0, bitCnt = 0;
  function readBit() {
    if (bitCnt === 0) {
      let b = 0;
      if (pos < len) {
        b = data[pos];
        if (b === 0xff) {
          if (data[pos + 1] === 0) pos += 2;
          else b = 0; // reached a marker: feed zeros, stay put
        } else {
          pos++;
        }
      }
      bitBuf = b;
      bitCnt = 8;
    }
    bitCnt--;
    return (bitBuf >> bitCnt) & 1;
  }
  function receive(n) {
    let v = 0;
    while (n-- > 0) v = (v << 1) | readBit();
    return v;
  }
  function extend(v, n) {
    return v < 1 << (n - 1) ? v - (1 << n) + 1 : v;
  }
  function decodeHuff(t) {
    let code = readBit();
    let l = 1;
    while (code > t.maxcode[l]) {
      code = (code << 1) | readBit();
      if (++l > 16) return 0; // corrupt data; degrade gracefully
    }
    return t.symbols[t.valptr[l] + code - t.mincode[l]];
  }

  function decodeScan(comps, ss, se, ah, al) {
    const progressive = frame.progressive;
    let eobrun = 0;

    function baseline(c, off) {
      const co = c.coeffs;
      const t = decodeHuff(c.dc);
      c.pred += t === 0 ? 0 : extend(receive(t), t);
      co[off] = c.pred;
      let k = 1;
      while (k < 64) {
        const rs = decodeHuff(c.ac);
        const s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) break;
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        co[off + ZIGZAG[k]] = extend(receive(s), s);
        k++;
      }
    }
    function dcFirst(c, off) {
      const t = decodeHuff(c.dc);
      c.pred += t === 0 ? 0 : extend(receive(t), t);
      c.coeffs[off] = c.pred * (1 << al);
    }
    function dcRefine(c, off) {
      if (readBit()) c.coeffs[off] |= 1 << al;
    }
    function acFirst(c, off) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      const co = c.coeffs;
      let k = ss;
      while (k <= se) {
        const rs = decodeHuff(c.ac);
        const s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = receive(r) + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        if (k > 63) break;
        co[off + ZIGZAG[k]] = extend(receive(s), s) * (1 << al);
        k++;
      }
    }
    function acRefine(c, off) {
      const co = c.coeffs;
      const p1 = 1 << al, m1 = -1 << al;
      let k = ss;
      if (eobrun === 0) {
        for (; k <= se; k++) {
          const rs = decodeHuff(c.ac);
          let r = rs >> 4;
          let s = rs & 15;
          if (s) {
            s = readBit() ? p1 : m1;
          } else if (r !== 15) {
            eobrun = 1 << r;
            if (r) eobrun += receive(r);
            break;
          }
          do {
            const z = off + ZIGZAG[k];
            if (co[z] !== 0) {
              if (readBit() && (co[z] & p1) === 0) co[z] += co[z] >= 0 ? p1 : m1;
            } else {
              if (--r < 0) break;
            }
            k++;
          } while (k <= se);
          if (s && k <= 63) co[off + ZIGZAG[k]] = s;
        }
      }
      if (eobrun > 0) {
        for (; k <= se; k++) {
          const z = off + ZIGZAG[k];
          if (co[z] !== 0 && readBit() && (co[z] & p1) === 0) co[z] += co[z] >= 0 ? p1 : m1;
        }
        eobrun--;
      }
    }

    let fn;
    if (!progressive) fn = baseline;
    else if (ss === 0) fn = ah === 0 ? dcFirst : dcRefine;
    else fn = ah === 0 ? acFirst : acRefine;

    for (const c of comps) c.pred = 0;
    bitCnt = 0;

    const single = comps.length === 1;
    const total = single
      ? comps[0].blocksPerLine * comps[0].blocksPerColumn
      : frame.mcusPerLine * frame.mcusPerColumn;
    const interval = restartInterval || total;

    for (let m = 0; m < total; m++) {
      if (m > 0 && m % interval === 0) {
        // Expect an RSTn marker: realign and reset predictors.
        bitCnt = 0;
        while (pos + 1 < len && !(data[pos] === 0xff && data[pos + 1] >= 0xd0 && data[pos + 1] <= 0xd7)) pos++;
        if (pos + 1 < len) pos += 2;
        for (const c of comps) c.pred = 0;
        eobrun = 0;
      }
      if (single) {
        const c = comps[0];
        const row = (m / c.blocksPerLine) | 0;
        const col = m % c.blocksPerLine;
        fn(c, (row * c.stride + col) * 64);
      } else {
        const mRow = (m / frame.mcusPerLine) | 0;
        const mCol = m % frame.mcusPerLine;
        for (const c of comps) {
          for (let j = 0; j < c.v; j++) {
            for (let i = 0; i < c.h; i++) {
              fn(c, ((mRow * c.v + j) * c.stride + mCol * c.h + i) * 64);
            }
          }
        }
      }
    }
    // Skip to the next real marker.
    bitCnt = 0;
    while (pos + 1 < len) {
      if (data[pos] === 0xff) {
        const n = data[pos + 1];
        if (n !== 0 && n !== 0xff && !(n >= 0xd0 && n <= 0xd7)) break;
      }
      pos++;
    }
  }

  // ---- marker loop ----
  while (pos < len) {
    if (data[pos] !== 0xff) {
      pos++;
      continue;
    }
    const marker = data[pos + 1];
    pos += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0xff) {
      if (marker === 0xff) pos--;
      continue;
    }
    if (marker === 0xd9) break;
    const segLen = u16(pos);
    const segEnd = pos + segLen;
    let p = pos + 2;

    if (marker === 0xdb) {
      while (p < segEnd) {
        const pq = data[p] >> 4, tq = data[p] & 15;
        p++;
        const table = new Int32Array(64);
        for (let i = 0; i < 64; i++) {
          table[ZIGZAG[i]] = pq ? u16(p) : data[p];
          p += pq ? 2 : 1;
        }
        qt[tq] = table;
      }
    } else if (marker === 0xc4) {
      while (p < segEnd) {
        const tc = data[p] >> 4, th = data[p] & 15;
        p++;
        const counts = data.subarray(p, p + 16);
        p += 16;
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        const symbols = data.slice(p, p + total);
        p += total;
        (tc === 0 ? dcTables : acTables)[th] = buildHuffman(counts, symbols);
      }
    } else if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      const height = u16(p + 1);
      const width = u16(p + 3);
      const n = data[p + 5];
      p += 6;
      const components = [];
      for (let i = 0; i < n; i++) {
        components.push({ id: data[p], h: data[p + 1] >> 4, v: data[p + 1] & 15, tq: data[p + 2] });
        p += 3;
      }
      if (!width || !height) throw new Error('JPEG: bad dimensions');
      const maxH = Math.max(...components.map((c) => c.h));
      const maxV = Math.max(...components.map((c) => c.v));
      const mcusPerLine = Math.ceil(width / (8 * maxH));
      const mcusPerColumn = Math.ceil(height / (8 * maxV));
      for (const c of components) {
        c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / maxH) / 8);
        c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / maxV) / 8);
        c.stride = mcusPerLine * c.h;
        c.rows = mcusPerColumn * c.v;
        c.coeffs = new Int16Array(c.stride * c.rows * 64);
        c.pred = 0;
      }
      frame = { width, height, components, maxH, maxV, mcusPerLine, mcusPerColumn, progressive: marker === 0xc2 };
    } else if (marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      throw new Error('JPEG: unsupported coding (lossless/arithmetic)');
    } else if (marker === 0xdd) {
      restartInterval = u16(p);
    } else if (marker === 0xee) {
      if (data[p] === 0x41 && data[p + 1] === 0x64 && data[p + 2] === 0x6f && data[p + 3] === 0x62 && data[p + 4] === 0x65) {
        adobe = { transform: data[p + 11] };
      }
    } else if (marker === 0xda) {
      if (!frame) throw new Error('JPEG: scan before frame');
      const ns = data[p++];
      const comps = [];
      for (let i = 0; i < ns; i++) {
        const c = frame.components.find((x) => x.id === data[p]);
        if (!c) throw new Error('JPEG: bad scan component');
        c.dc = dcTables[data[p + 1] >> 4];
        c.ac = acTables[data[p + 1] & 15];
        comps.push(c);
        p += 2;
      }
      const ss = data[p], se = data[p + 1], ah = data[p + 2] >> 4, al = data[p + 2] & 15;
      pos = segEnd;
      decodeScan(comps, ss, se, ah, al);
      continue;
    }
    pos = segEnd;
  }

  if (!frame) throw new Error('JPEG: no frame');
  return toRgba(frame, qt, adobe);
}

function componentPlane(c, q) {
  const w = c.stride * 8;
  const plane = new Uint8Array(w * c.rows * 8);
  const blk = new Float32Array(64);
  const tmp = new Float32Array(64);
  for (let br = 0; br < c.blocksPerColumn; br++) {
    for (let bc = 0; bc < c.blocksPerLine; bc++) {
      const off = (br * c.stride + bc) * 64;
      for (let i = 0; i < 64; i++) blk[i] = c.coeffs[off + i] * q[i];
      // rows: tmp[v][x] = sum_u T[x][u] * F[v][u]
      for (let v = 0; v < 8; v++) {
        for (let x = 0; x < 8; x++) {
          let s = 0;
          for (let u = 0; u < 8; u++) s += IDCT_T[x * 8 + u] * blk[v * 8 + u];
          tmp[v * 8 + x] = s;
        }
      }
      // columns: out[y][x] = sum_v T[y][v] * tmp[v][x]
      for (let y = 0; y < 8; y++) {
        const rowOut = (br * 8 + y) * w + bc * 8;
        for (let x = 0; x < 8; x++) {
          let s = 0;
          for (let v = 0; v < 8; v++) s += IDCT_T[y * 8 + v] * tmp[v * 8 + x];
          const val = Math.round(s + 128);
          plane[rowOut + x] = val < 0 ? 0 : val > 255 ? 255 : val;
        }
      }
    }
  }
  return { plane, w };
}

function clamp8(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

// A component plane at image resolution. Subsampled (chroma) planes are
// upsampled bilinearly ("fancy upsampling") so colour edges don't look blocky.
function fullResPlane({ plane, w }, c, frame) {
  const { width, height, maxH, maxV } = frame;
  const out = new Uint8Array(width * height);
  if (c.h === maxH && c.v === maxV) {
    for (let y = 0; y < height; y++) out.set(plane.subarray(y * w, y * w + width), y * width);
    return out;
  }
  const sx = c.h / maxH, sy = c.v / maxV;
  const cw = Math.ceil(width * sx), ch = Math.ceil(height * sy);
  const x0 = new Int32Array(width), x1 = new Int32Array(width), fx = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    const p = Math.min(Math.max((x + 0.5) * sx - 0.5, 0), cw - 1);
    x0[x] = Math.floor(p);
    x1[x] = Math.min(x0[x] + 1, cw - 1);
    fx[x] = p - x0[x];
  }
  for (let y = 0; y < height; y++) {
    const p = Math.min(Math.max((y + 0.5) * sy - 0.5, 0), ch - 1);
    const r0 = Math.floor(p) * w;
    const r1 = Math.min(Math.floor(p) + 1, ch - 1) * w;
    const fy = p - Math.floor(p);
    for (let x = 0; x < width; x++) {
      const top = plane[r0 + x0[x]] * (1 - fx[x]) + plane[r0 + x1[x]] * fx[x];
      const bot = plane[r1 + x0[x]] * (1 - fx[x]) + plane[r1 + x1[x]] * fx[x];
      out[y * width + x] = Math.round(top * (1 - fy) + bot * fy);
    }
  }
  return out;
}

function toRgba(frame, qt, adobe) {
  const { width, height, components, maxH, maxV } = frame;
  const planes = components.map((c) => {
    const q = qt[c.tq];
    if (!q) throw new Error('JPEG: missing quantization table');
    return componentPlane(c, q);
  });
  const n = components.length;
  const out = new Uint8Array(width * height * 4);
  const full = components.map((c, i) => fullResPlane(planes[i], c, frame));
  // Adobe transform: 0 = none (RGB/CMYK), 1 = YCbCr, 2 = YCCK. Without Adobe, 3 comps = YCbCr.
  const transform = adobe ? adobe.transform : n === 3 ? 1 : 0;
  const s = new Float32Array(4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let i = 0; i < n; i++) s[i] = full[i][y * width + x];
      let r, g, b;
      if (n === 1) {
        r = g = b = s[0];
      } else if (n === 3) {
        if (transform) {
          const Y = s[0], cb = s[1] - 128, cr = s[2] - 128;
          r = clamp8(Y + 1.402 * cr);
          g = clamp8(Y - 0.344136 * cb - 0.714136 * cr);
          b = clamp8(Y + 1.772 * cb);
        } else {
          r = s[0];
          g = s[1];
          b = s[2];
        }
      } else if (n === 4) {
        let c0 = s[0], c1 = s[1], c2 = s[2];
        const k = s[3];
        if (transform === 2) {
          const Y = c0, cb = c1 - 128, cr = c2 - 128;
          c0 = clamp8(Y + 1.402 * cr);
          c1 = clamp8(Y - 0.344136 * cb - 0.714136 * cr);
          c2 = clamp8(Y + 1.772 * cb);
        }
        // Adobe CMYK/YCCK JPEGs store inverted values.
        if (adobe) {
          r = clamp8((c0 * k) / 255);
          g = clamp8((c1 * k) / 255);
          b = clamp8((c2 * k) / 255);
        } else {
          r = clamp8(((255 - c0) * (255 - k)) / 255);
          g = clamp8(((255 - c1) * (255 - k)) / 255);
          b = clamp8(((255 - c2) * (255 - k)) / 255);
        }
      } else {
        throw new Error('JPEG: unsupported component count');
      }
      const o = (y * width + x) * 4;
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}
