/**
 * Static file server for local development.
 *
 * Exists because of a specific trap. index.html loads `main.js?v=N` and main.js
 * propagates that N to every dynamic import(), but a *static* import resolves
 * without the query: `main.js?v=32` importing './utils/ParentBridge.js' asks for
 * the bare URL, so the browser happily serves a cached copy. Editing a statically
 * imported module then looks like a no-op, or worse, surfaces as a method that
 * "is not a function" on an object that plainly defines it.
 *
 * Bumping ?v=N cannot fix that. Not caching in the first place can, so every
 * response here is no-store.
 *
 *   node tools/dev-server.mjs [port]     (default 8000, or $PORT)
 */
import http from 'node:http';
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || process.env.PORT || 8000);

// .wasm must be exact or WebAssembly.instantiateStreaming refuses the response,
// which is the one MIME mistake that breaks MuJoCo outright.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.xml': 'text/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary',
  '.stl': 'model/stl',
  '.obj': 'model/obj',
  '.mtl': 'model/mtl',
  '.zip': 'application/zip',
};

// Text-ish formats worth compressing. Deliberately excludes already-compressed
// containers (png/jpg/gif/zip) where gzip costs CPU and saves nothing, and
// includes .obj/.mtl/.stl because MuJoCo meshes are ASCII and dominate the boot
// payload -- .obj alone is 33 MB of the bundled scene.
const COMPRESSIBLE = new Set([
  '.html', '.js', '.mjs', '.css', '.json', '.xml', '.txt', '.svg',
  '.obj', '.mtl', '.stl', '.wasm',
]);

// Per-request log, on by default. This is a dev server whose whole reason to
// exist is diagnosing what the browser actually fetched; guessing from the other
// side of a Network tab is how the 30 s boot timeout stayed unexplained. Prints
// status, bytes actually written, whether it was gzipped, and elapsed ms.
const QUIET = process.env.DEV_SERVER_QUIET === '1';

const server = http.createServer((req, res) => {
  const t0 = process.hrtime.bigint();
  if (!QUIET) {
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      // Track the decision on `res` rather than asking getHeader(): headers
      // passed to writeHead() are not visible to it, which made the first
      // version of this log claim nothing was ever compressed.
      const enc = res._sentGzip ? 'gz' : '--';
      const ae = /\bgzip\b/.test(req.headers['accept-encoding'] || '') ? '' : ' [no-AE]';
      const n = res._sentBytes ?? 0;
      console.log(`${res.statusCode} ${enc} ${String(n).padStart(9)}B `
        + `${ms.toFixed(0).padStart(6)}ms  ${req.url}${ae}`);
    });
  }

  let pathname;
  try {
    ({ pathname } = new URL(req.url, `http://${req.headers.host || 'localhost'}`));
  } catch {
    res.writeHead(400).end('bad request');
    return;
  }

  let rel = decodeURIComponent(pathname);
  if (rel.endsWith('/')) rel += 'index.html';

  // Resolve, then confirm the result is still inside ROOT: '..' segments are
  // normalised away by path.join, but a symlink or an encoded traversal is not.
  const file = path.join(ROOT, rel);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('404 ' + rel);
      return;
    }
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'content-type': TYPES[ext] || 'application/octet-stream',
      // The whole point of this server.
      'cache-control': 'no-store, must-revalidate',
    };

    // Compress, because the boot path is 33 MB of plain-text geometry.
    //
    // downloadExampleScenesFolder() fetches the 23 bundled UR5e files before the
    // app will start, and gives up after 30 s. Those are ASCII .obj meshes:
    // 32.9 MB raw, 6.4 MB gzipped, 5.1x. Over a tailnet link measured at about
    // 1.1 MB/s that is 30.0 s against 5.8 s -- i.e. uncompressed lands exactly
    // on the timeout, which is how this presented: boot failing at "downloading
    // the bundled example scenes" on a server that serves the same files to
    // loopback in 0.1 s.
    const compressible = COMPRESSIBLE.has(ext);
    const wantsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    if (compressible) headers.vary = 'accept-encoding';

    if (req.method === 'HEAD') {
      // Mirror what a GET would answer, minus the body. Notably: no
      // content-length when we would have compressed, because the raw size
      // would be a lie and the compressed size is not known without doing the
      // compression.
      if (compressible && wantsGzip) headers['content-encoding'] = 'gzip';
      else headers['content-length'] = st.size;
      res.writeHead(200, headers).end();
      return;
    }

    const count = (stream) => {
      res._sentBytes = 0;
      stream.on('data', (c) => { res._sentBytes += c.length; });
      return stream;
    };

    if (compressible && wantsGzip) {
      headers['content-encoding'] = 'gzip';       // length omitted -> chunked
      res._sentGzip = true;
      res.writeHead(200, headers);
      count(fs.createReadStream(file).pipe(zlib.createGzip({ level: 6 }))).pipe(res);
      return;
    }
    headers['content-length'] = st.size;
    res.writeHead(200, headers);
    count(fs.createReadStream(file)).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`rs-demo dev server  http://localhost:${PORT}/  (no-store, serving ${ROOT})`);
});
