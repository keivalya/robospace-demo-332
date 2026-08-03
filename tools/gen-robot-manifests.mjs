// Regenerates examples/utils/robotManifests.js from mujoco_menagerie.
//
//   node tools/gen-robot-manifests.mjs
//
// Needs network access. To move to a newer menagerie revision, bump COMMIT — it
// is pinned deliberately: an unpinned @main would let an upstream asset change
// silently invalidate every cached pack and every saved project that references
// it, and jsDelivr only serves immutable long-lived caching for a pinned commit.
//
// Deliberately dependency-free (regex, not a DOM parser) so it runs with bare
// node. The extraction is narrow — `file=` attributes and compiler asset dirs —
// and the output is verified against the file list in the git tree, so a missed
// or malformed reference shows up as a "not in tree" error rather than silently
// producing a short manifest.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = '71f066ad0be9cd271f7ed58c030243ef157af9f4';
const REPO = 'google-deepmind/mujoco_menagerie';
const JSDELIVR_FILE_LIMIT = 20 * 1024 * 1024;

const PACKS = {
  franka_panda: { upstreamDir: 'franka_emika_panda', entry: 'panda.xml' },
  stretch_3: { upstreamDir: 'hello_robot_stretch_3', entry: 'stretch.xml' },
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'examples', 'utils', 'robotManifests.js');

const cdnUrl = (repoPath) => `https://cdn.jsdelivr.net/gh/${REPO}@${COMMIT}/${repoPath}`;

const dirOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
function joinRel(base, rel) {
  const out = [];
  for (const seg of `${base ? `${base}/` : ''}${rel}`.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return out.join('/');
}

async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

const attr = (tagBody, name) => {
  const m = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tagBody);
  return m ? m[1] : null;
};
const tags = (xml, name) => {
  const found = [];
  const re = new RegExp(`<${name}\\b([^>]*)>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) found.push(m[1]);
  return found;
};

console.log(`fetching git tree at ${COMMIT.slice(0, 8)} ...`);
const treeRes = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${COMMIT}?recursive=1`);
const tree = await treeRes.json();
if (!tree.tree) throw new Error(`GitHub tree API returned: ${JSON.stringify(tree).slice(0, 200)}`);
const sizeByPath = new Map(tree.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.size]));

const results = [];
for (const [id, { upstreamDir, entry }] of Object.entries(PACKS)) {
  const xmlFiles = [];
  const assets = new Set();
  let assetRoot = '';

  const visit = async (relXml) => {
    if (xmlFiles.includes(relXml)) return;
    xmlFiles.push(relXml);
    const xml = await fetchText(cdnUrl(`${upstreamDir}/${relXml}`));

    for (const body of tags(xml, 'compiler')) {
      const dir = attr(body, 'assetdir') || attr(body, 'meshdir');
      if (dir) assetRoot = dir;
    }
    for (const body of tags(xml, 'include')) {
      const file = attr(body, 'file');
      if (file) await visit(joinRel(dirOf(relXml), file));
    }
    for (const tag of ['mesh', 'texture', 'hfield', 'skin']) {
      for (const body of tags(xml, tag)) {
        const file = attr(body, 'file');
        if (file) assets.add(joinRel(assetRoot, file));
      }
    }
  };
  await visit(entry);

  const files = [];
  for (const rel of [...xmlFiles, ...[...assets].sort()]) {
    const size = sizeByPath.get(`${upstreamDir}/${rel}`);
    if (size === undefined) throw new Error(`${id}: ${rel} is referenced but not in the git tree at ${COMMIT}`);
    files.push({ path: rel, size, viaRaw: size > JSDELIVR_FILE_LIMIT });
  }
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0);
  console.log(`  ${id}: ${files.length} files, ${(totalBytes / 1048576).toFixed(1)} MB`);
  results.push({ id, upstreamDir, entry, assetRoot, totalBytes, files });
}

const lines = [
  '// examples/utils/robotManifests.js',
  '//',
  '// GENERATED — do not hand-edit. Regenerate with tools/gen-robot-manifests.mjs.',
  '//',
  '// One entry per robot pack: the exact files the entry XML transitively needs,',
  "// derived by resolving <include>, <mesh file>, <texture file> and <skin file>",
  "// against the pack's <compiler assetdir|meshdir>. Only these files are fetched —",
  '// the upstream directories also carry READMEs, preview images, .mtl files MuJoCo',
  '// never parses, and MJX variants, none of which are needed at runtime.',
  '//',
  '// `size` drives the download progress readout. `viaRaw` marks files that exceed',
  "// jsDelivr's 20 MB per-file cap and must come from raw.githubusercontent.com.",
  '',
  `export const MENAGERIE_COMMIT = ${JSON.stringify(COMMIT)};`,
  '',
  'export const ROBOT_MANIFESTS = {',
];
for (const pack of results) {
  lines.push(`  ${pack.id}: {`);
  lines.push(`    upstreamDir: ${JSON.stringify(pack.upstreamDir)},`);
  lines.push(`    entry: ${JSON.stringify(pack.entry)},`);
  lines.push(`    assetRoot: ${JSON.stringify(pack.assetRoot)},`);
  lines.push(`    totalBytes: ${pack.totalBytes},   // ${(pack.totalBytes / 1048576).toFixed(1)} MB`);
  lines.push('    files: [');
  for (const f of pack.files) {
    lines.push(`      { path: ${JSON.stringify(f.path)}, size: ${f.size}${f.viaRaw ? ', viaRaw: true' : ''} },`);
  }
  lines.push('    ],');
  lines.push('  },');
}
lines.push('};', '');

fs.writeFileSync(OUT, lines.join('\n'));
console.log(`wrote ${path.relative(process.cwd(), OUT)}`);
