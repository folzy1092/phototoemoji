// ffmpeg in the isolate: @ffmpeg/core (single thread). The emscripten glue is
// vendored in ./core.js; the 32 MB wasm is downloaded from a CDN on first use
// and the compiled module is kept for the isolate's lifetime.
//
// A fetch body in the isolate is capped at a few MB, so the wasm comes in 4 MB
// Range pieces. Not every CDN edge serves ranges of the raw file (cdn/gcore
// jsDelivr answer ranges of a compressed copy), and the bot can't fetch its own
// static host — hence the mirror list and the Content-Range check.
//
// The build's stack is emscripten's default 64 KB; libvpx-vp9 needs more and
// overflows it ("memory access out of bounds" on most pictures), so every run
// gets an 8 MB stack malloc'ed on the heap.
//
//   const ff = await ffmpegSession();
//   ff.write('in.mp4', bytes);
//   ff.exec(['-i', 'in.mp4', 'out.webm']);
//   ff.read('out.webm') // Uint8Array, or null

import { fetch } from 'sdk';
import createFFmpegCore from './core.js';

const PKG = '@ffmpeg/core@0.12.10/dist/esm/ffmpeg-core.wasm';
const MIRRORS = [`https://fastly.jsdelivr.net/npm/${PKG}`, `https://unpkg.com/${PKG}`];
const WASM_SIZE = 32232419;
const PIECE = 4 * 1024 * 1024;
const STACK = 8 * 1024 * 1024;

let compiled = null;

async function fetchPiece(from) {
  const to = Math.min(WASM_SIZE, from + PIECE) - 1;
  let last = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}`, 'Accept-Encoding': 'identity' } });
      const chunks = [];
      let n = 0;
      for await (const c of res.body) { chunks.push(c); n += c.length; }
      const range = res.headers.get('content-range') || '';
      if (res.status === 206 && range === `bytes ${from}-${to}/${WASM_SIZE}` && n === to - from + 1) {
        const out = new Uint8Array(n);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        return out;
      }
      last = `${res.status} ${range} ${n}`;
    } catch (e) {
      last = String(e && e.message);
    }
  }
  throw new Error(`FFMPEG_FETCH ${from}: ${last}`);
}

async function wasmModule() {
  if (compiled) return compiled;
  const buf = new Uint8Array(WASM_SIZE);
  const starts = [];
  for (let s = 0; s < WASM_SIZE; s += PIECE) starts.push(s);
  // Four at a time: fast, without every piece in flight at once.
  for (let i = 0; i < starts.length; i += 4) {
    const batch = starts.slice(i, i + 4);
    const got = await Promise.all(batch.map(fetchPiece));
    got.forEach((g, k) => buf.set(g, batch[k]));
  }
  compiled = new WebAssembly.Module(buf);
  return compiled;
}

// What the glue expects from a browser worker. Date.now() is frozen while JS
// runs, and emscripten's usleep busy-waits on performance.now() (ffmpeg sleeps
// whenever an output isn't ready yet) — so this clock moves 1 ms per call.
let clock = 0;
if (typeof globalThis.performance === 'undefined') {
  globalThis.performance = { now: () => (clock = Math.max(clock + 1, Date.now())) };
}

/**
 * One ffmpeg instance; run commands on it one after another (ffmpeg.wasm resets
 * its state between runs). One output file per command: with two or more
 * outputs this single-thread build never finishes — put several streams into
 * one .mkv and split it with `-c copy` runs instead.
 */
export async function ffmpegSession() {
  const module = await wasmModule();
  const core = await createFFmpegCore({
    instantiateWasm(imports, receive) {
      const inst = new WebAssembly.Instance(module, imports);
      receive(inst, module);
      return inst.exports;
    },
  });
  const stackTop = (core._malloc(STACK) + STACK) & ~15;
  let log = [];
  core.setLogger(({ message }) => { log.push(message); if (log.length > 80) log.shift(); });

  /** Exit code and log lines of one command (without -hide_banner/-loglevel). */
  function run(args) {
    log = [];
    core.reset();
    const saved = core.stackSave();
    core.stackRestore(stackTop);
    try {
      return { code: core.exec('-nostats', ...args), log };
    } finally {
      core.stackRestore(saved);
    }
  }

  return {
    write: (name, bytes) => core.FS.writeFile(name, bytes),
    read: (name) => { try { return core.FS.readFile(name); } catch (_) { return null; } },
    remove: (name) => { try { core.FS.unlink(name); } catch (_) { /* gone */ } },
    run,
    /** Run quietly; throws FFMPEG_FAILED (log tail in .detail) on a non-zero exit. */
    exec(args) {
      const r = run(['-hide_banner', '-loglevel', 'error', ...args]);
      if (r.code !== 0) {
        const e = new Error('FFMPEG_FAILED');
        e.detail = r.log.slice(-8).join('\n');
        throw e;
      }
    },
    /** Duration (s), width, height (as shown, rotation applied) and fps of a file's first video stream. */
    probe(name) {
      const text = run(['-hide_banner', '-i', name]).log.join('\n'); // "At least one output file must be specified": fine
      const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(text);
      const v = /Stream #[^\n]*Video:[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*/.exec(text);
      const fps = v && (/([\d.]+) fps/.exec(v[0]) || /([\d.]+)k? tbr/.exec(v[0]));
      // Phone videos carry a rotation: the picture is shown turned by 90°.
      const rot = /rotation of (-?[\d.]+) degrees|rotate\s*:\s*(-?\d+)/.exec(text);
      const turned = rot && Math.abs(Math.round(+(rot[1] || rot[2]) / 90)) % 2 === 1;
      return {
        duration: d ? +d[1] * 3600 + +d[2] * 60 + +d[3] : null,
        width: v ? +(turned ? v[2] : v[1]) : null,
        height: v ? +(turned ? v[1] : v[2]) : null,
        fps: fps ? +fps[1] : null,
      };
    },
  };
}
