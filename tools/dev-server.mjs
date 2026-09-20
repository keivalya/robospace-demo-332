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

const server = http.createServer((req, res) => {
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
    const headers = {
      'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': st.size,
      // The whole point of this server.
      'cache-control': 'no-store, must-revalidate',
    };
    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`rs-demo dev server  http://localhost:${PORT}/  (no-store, serving ${ROOT})`);
});
