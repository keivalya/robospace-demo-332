/**
 * Can this MuJoCo WASM build load an image-file texture?
 *
 *   node --import ./test/register.mjs tools/check-texture-support.mjs
 *
 * Exists because the answer decides whether a vision policy can run in the
 * browser at all. Measured on the inference board, driving the same policy over
 * the same HTTP path and changing only what it is shown:
 *
 *   real image textures                         4/4
 *   flat white (what stripFileTextures leaves)  0/4
 *   flat, recoloured to each texture's mean     0/4
 *   procedural checker, 8 squares               3/8
 *   procedural checker, 24 / 64 / 128 squares   0/4 each
 *
 * So textures are worth about +100 points and nothing substitutes for them.
 * `examples/utils/robotPacks.js:stripFileTextures` exists solely to work around
 * this, and it also costs stretch_3 its ArUco fiducials and label decals.
 *
 * What this script pins down, so a rebuild can be checked in one command:
 *
 *   - procedural `builtin` textures work (the control)
 *   - every `<texture file="*.png">` fails, including one no material uses
 *   - it is not size: a 4x4, 120-byte PNG fails exactly like a 1024x1024 one
 *   - it is not staging: the bytes round-trip through MEMFS unchanged
 *   - MuJoCo prints NO diagnostic, where every other compile failure prints one
 *
 * That last asymmetry is the clue: mujocoLog.js recovers the XML compiler's real
 * error for other failures, and here the buffer is empty, which looks like an
 * abort rather than MuJoCo's error path. The binary does contain MuJoCo's PNG
 * diagnostics ("PNG texture too large", "Non-square PNG file ..."), so the
 * decoder is compiled in and something else is wrong.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import load_mujoco from '../dist/mujoco_wasm.js';
import { mujocoLogHooks, clearMjLog, drainMjLog } from '../examples/utils/mujocoLog.js';
import { compileModel } from '../examples/mujocoUtils.js';

// A minimal valid PNG, built here so the check needs no asset on disk.
function tinyPng(n = 4) {
  const crcTable = [...Array(256)].map((_, i) => {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(n, 0); ihdr.writeUInt32BE(n, 4);
  ihdr[8] = 8; ihdr[9] = 2;                       // 8-bit, truecolour RGB
  const raw = Buffer.concat([...Array(n)].map(() =>
    Buffer.concat([Buffer.from([0]), Buffer.alloc(n * 3, 128)])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

const mujoco = await load_mujoco(mujocoLogHooks);
mujoco.FS.mkdir('/working');

const png = tinyPng(4);
mujoco.FS.writeFile('/working/t.png', new Uint8Array(png));
const back = Buffer.from(mujoco.FS.readFile('/working/t.png'));
const roundTrips = back.equals(png);
console.log(`generated PNG: ${png.length} bytes, round-trips through MEMFS: ${roundTrips}`);

const scene = (asset) => `<mujoco><asset>${asset}</asset>` +
  `<worldbody><geom type="box" size=".1 .1 .1"${/material name="m"/.test(asset) ? ' material="m"' : ''}/></worldbody></mujoco>`;

const CASES = [
  ['builtin checker (control — must pass)',
   '<texture name="t" type="2d" builtin="checker" rgb1="1 0 0" rgb2="0 0 1" width="64" height="64"/><material name="m" texture="t"/>'],
  ['png, type=2d, used by a material',
   '<texture name="t" type="2d" file="t.png"/><material name="m" texture="t"/>'],
  ['png, type=cube, used by a material',
   '<texture name="t" type="cube" file="t.png"/><material name="m" texture="t"/>'],
  ['png, declared but referenced by nothing',
   '<texture name="t" type="2d" file="t.png"/>'],
];

let control = false, anyPng = false;
for (const [name, asset] of CASES) {
  mujoco.FS.writeFile('/working/t.xml', scene(asset));
  clearMjLog();
  try {
    const m = compileModel(mujoco, '/working/t.xml');
    console.log(`  PASS  ${name}   ntex=${m.ntex}`);
    if (name.startsWith('builtin')) control = true; else anyPng = true;
  } catch (e) {
    const log = drainMjLog().filter((l) => l && l.trim()).join(' | ');
    console.log(`  FAIL  ${name}`);
    console.log(`        mujoco said: ${log.slice(0, 300) || '(nothing — no diagnostic at all)'}`);
  }
}

console.log('');
if (!control) {
  console.log('VERDICT: the control failed, so this script is broken, not the build.');
  process.exit(2);
}
console.log(anyPng
  ? 'VERDICT: image textures LOAD. stripFileTextures() can be retired, and the\n'
    + '         vision demo should be re-measured in the browser.'
  : 'VERDICT: image textures do NOT load, procedural ones do. stripFileTextures()\n'
    + '         is still required, and a vision policy cannot see its scene here.');
process.exit(0);
