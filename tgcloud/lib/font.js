// /text banners: a 5x7 pixel font (Latin, Cyrillic, digits, a little
// punctuation) drawn straight at the final resolution so letters stay crisp.

const G = {
  A: '.###. #...# #...# ##### #...# #...# #...#',
  B: '####. #...# #...# ####. #...# #...# ####.',
  C: '.###. #...# #.... #.... #.... #...# .###.',
  D: '####. #...# #...# #...# #...# #...# ####.',
  E: '##### #.... #.... ####. #.... #.... #####',
  F: '##### #.... #.... ####. #.... #.... #....',
  G: '.###. #...# #.... #.### #...# #...# .###.',
  H: '#...# #...# #...# ##### #...# #...# #...#',
  I: '.###. ..#.. ..#.. ..#.. ..#.. ..#.. .###.',
  J: '..### ...#. ...#. ...#. ...#. #..#. .##..',
  K: '#...# #..#. #.#.. ##... #.#.. #..#. #...#',
  L: '#.... #.... #.... #.... #.... #.... #####',
  M: '#...# ##.## #.#.# #.#.# #...# #...# #...#',
  N: '#...# #...# ##..# #.#.# #..## #...# #...#',
  O: '.###. #...# #...# #...# #...# #...# .###.',
  P: '####. #...# #...# ####. #.... #.... #....',
  Q: '.###. #...# #...# #...# #.#.# #..#. .##.#',
  R: '####. #...# #...# ####. #.#.. #..#. #...#',
  S: '.#### #.... #.... .###. ....# ....# ####.',
  T: '##### ..#.. ..#.. ..#.. ..#.. ..#.. ..#..',
  U: '#...# #...# #...# #...# #...# #...# .###.',
  V: '#...# #...# #...# #...# #...# .#.#. ..#..',
  W: '#...# #...# #...# #.#.# #.#.# #.#.# .#.#.',
  X: '#...# #...# .#.#. ..#.. .#.#. #...# #...#',
  Y: '#...# #...# .#.#. ..#.. ..#.. ..#.. ..#..',
  Z: '##### ....# ...#. ..#.. .#... #.... #####',
  0: '.###. #...# #..## #.#.# ##..# #...# .###.',
  1: '..#.. .##.. ..#.. ..#.. ..#.. ..#.. .###.',
  2: '.###. #...# ....# ...#. ..#.. .#... #####',
  3: '####. ....# ....# .###. ....# ....# ####.',
  4: '...#. ..##. .#.#. #..#. ##### ...#. ...#.',
  5: '##### #.... ####. ....# ....# #...# .###.',
  6: '.###. #.... #.... ####. #...# #...# .###.',
  7: '##### ....# ...#. ..#.. .#... .#... .#...',
  8: '.###. #...# #...# .###. #...# #...# .###.',
  9: '.###. #...# #...# .#### ....# ....# .###.',
  Б: '##### #.... #.... ####. #...# #...# ####.',
  Г: '##### #.... #.... #.... #.... #.... #....',
  Д: '.###. .#.#. .#.#. .#.#. .#.#. ##### #...#',
  Ё: '.#.#. ##### #.... ####. #.... #.... #####',
  Ж: '#.#.# #.#.# .###. ..#.. .###. #.#.# #.#.#',
  З: '.###. #...# ....# ..##. ....# #...# .###.',
  И: '#...# #...# #..## #.#.# ##..# #...# #...#',
  Й: '.###. #...# #..## #.#.# ##..# #...# #...#',
  Л: '..### .#..# .#..# .#..# .#..# .#..# #...#',
  П: '##### #...# #...# #...# #...# #...# #...#',
  У: '#...# #...# #...# .#### ....# ....# .###.',
  Ф: '..#.. .###. #.#.# #.#.# #.#.# .###. ..#..',
  Ц: '#..#. #..#. #..#. #..#. #..#. ##### ....#',
  Ч: '#...# #...# #...# .#### ....# ....# ....#',
  Ш: '#.#.# #.#.# #.#.# #.#.# #.#.# #.#.# #####',
  Щ: '#.#.# #.#.# #.#.# #.#.# #.#.# ##### ....#',
  Ъ: '##... .#... .#... .###. .#..# .#..# .###.',
  Ы: '#...# #...# #...# ##..# #.#.# #.#.# ##..#',
  Ь: '#.... #.... #.... ####. #...# #...# ####.',
  Э: '.###. #...# ....# ..### ....# #...# .###.',
  Ю: '#..#. #.#.# #.#.# ###.# #.#.# #.#.# #..#.',
  Я: '.#### #...# #...# .#### ..#.# .#..# #...#',
  '!': '..#.. ..#.. ..#.. ..#.. ..#.. ..... ..#..',
  '?': '.###. #...# ....# ...#. ..#.. ..... ..#..',
  '.': '..... ..... ..... ..... ..... ..... ..#..',
  ',': '..... ..... ..... ..... ..... ..#.. .#...',
  '-': '..... ..... ..... .###. ..... ..... .....',
  '+': '..... ..#.. ..#.. ##### ..#.. ..#.. .....',
  ':': '..... ..#.. ..... ..... ..... ..#.. .....',
  '♥': '..... .#.#. ##### ##### .###. ..#.. .....',
};
// Cyrillic letters drawn like Latin ones.
for (const [cy, la] of Object.entries({ А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X' })) G[cy] = G[la];
G['❤'] = G['♥'];

const GLYPH_W = 5, GLYPH_H = 7, SPACE_W = 3, GAP = 1, LINE_GAP = 2, PAD = 1;
export const MAX_TEXT = 40;
export const MAX_LINES = 3;

function glyphFor(ch) {
  const up = ch.toUpperCase();
  if (G[up]) return G[up];
  // Accented Latin (é, ñ, ü, ç…) -> base letter.
  const base = up.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return G[base] || null;
}

/** Split and validate: { lines } or { bad: 'chars that can't be drawn' }. */
export function parseBanner(raw) {
  const lines = String(raw || '').split(/\n|\|/).map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (!lines.length) return { empty: true };
  if (lines.length > MAX_LINES || lines.join('').length > MAX_TEXT) return { tooLong: true };
  const bad = new Set();
  for (const ch of lines.join('')) if (ch !== ' ' && !glyphFor(ch)) bad.add(ch);
  if (bad.size) return { bad: [...bad].join(' ') };
  return { lines };
}

function lineCells(line) {
  let w = 0;
  [...line].forEach((ch, i) => { w += (ch === ' ' ? SPACE_W : GLYPH_W) + (i ? GAP : 0); });
  return w;
}

function measure(lines) {
  const w = Math.max(...lines.map(lineCells)) + PAD * 2;
  const h = lines.length * GLYPH_H + (lines.length - 1) * LINE_GAP + PAD * 2;
  return { w, h };
}

/** Columns needed to show `text` at `rows` tile rows, or null if it can't fit. */
export function bannerCols(text, rows, tile = 100, maxCols = 20) {
  const { lines } = parseBanner(text);
  if (!lines) return null;
  const { w, h } = measure(lines);
  const cell = Math.floor((rows * tile) / h);
  if (cell < 1) return null;
  const cols = Math.max(1, Math.ceil((w * cell) / tile));
  return cols <= maxCols ? cols : null;
}

/** Default size: 2 tile rows per line, fewer if the text is too wide. */
export function bannerGrid(text, maxCols = 20, maxTiles = 200) {
  const { lines } = parseBanner(text);
  if (!lines) return null;
  for (let rows = lines.length * 2; rows >= lines.length; rows--) {
    const cols = bannerCols(text, rows, 100, maxCols);
    if (cols && cols * rows <= maxTiles) return { cols, rows };
  }
  return null;
}

// Colors: [swatch, rgb | 'rainbow'].
export const COLORS = [
  ['🟥', [235, 64, 52]], ['🟧', [255, 149, 0]], ['🟨', [255, 214, 10]], ['🟩', [52, 199, 89]],
  ['🟦', [10, 132, 255]], ['🟪', [175, 82, 222]], ['⬜', [255, 255, 255]], ['🌈', 'rainbow'],
];

function hue(t) {
  const h = t * 6, x = 1 - Math.abs((h % 2) - 1);
  const [r, g, b] = h < 1 ? [1, x, 0] : h < 2 ? [x, 1, 0] : h < 3 ? [0, 1, x] : h < 4 ? [0, x, 1] : h < 5 ? [x, 0, 1] : [1, 0, x];
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

/**
 * The banner as an RGBA image of exactly cols*tile x rows*tile, text centered,
 * with a thin dark outline so light colors stay readable on a white theme.
 */
export function renderBanner(text, colorIdx, cols, rows, tile) {
  return drawBanner(text, colorIdx, cols * tile, rows * tile);
}

/** The banner centered on a transparent W x H canvas. */
export function drawBanner(text, colorIdx, W, H) {
  const { lines } = parseBanner(text);
  const data = new Uint8Array(W * H * 4);
  if (!lines) return { width: W, height: H, data };
  const { w, h } = measure(lines);
  const cell = Math.max(1, Math.min(Math.floor(H / h), Math.floor(W / w)));
  const ox = Math.floor((W - w * cell) / 2) + PAD * cell;
  const oy = Math.floor((H - h * cell) / 2) + PAD * cell;
  const color = (COLORS[colorIdx] || COLORS[0])[1];
  const outline = Math.max(1, Math.round(cell / 6));

  const cells = [];
  lines.forEach((line, li) => {
    let cx = Math.floor((w - PAD * 2 - lineCells(line)) / 2); // center each line
    const cy = li * (GLYPH_H + LINE_GAP);
    [...line].forEach((ch) => {
      if (ch === ' ') { cx += SPACE_W + GAP; return; }
      const rowsBits = glyphFor(ch).split(' ');
      for (let y = 0; y < GLYPH_H; y++) {
        for (let x = 0; x < GLYPH_W; x++) if (rowsBits[y][x] === '#') cells.push([cx + x, cy + y]);
      }
      cx += GLYPH_W + GAP;
    });
  });

  const fill = (x0, y0, x1, y1, rgbAt) => {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const [r, g, b] = rgbAt(x);
        const o = (y * W + x) * 4;
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 255;
      }
    }
  };
  const dark = () => [20, 20, 24];
  const paint = color === 'rainbow' ? (x) => hue(Math.min(0.999, Math.max(0, (x - ox) / (w * cell)))) : () => color;
  for (const [x, y] of cells) {
    const px = ox + x * cell, py = oy + y * cell;
    fill(px - outline, py - outline, px + cell + outline, py + cell + outline, dark);
  }
  for (const [x, y] of cells) {
    const px = ox + x * cell, py = oy + y * cell;
    fill(px, py, px + cell, py + cell, paint);
  }
  return { width: W, height: H, data };
}
