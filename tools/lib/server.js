// tools/lib/server.js
//
// A tiny static file server, written by hand (no `serve`/`http-server` package —
// see specs/001-init-scaffold.md and the order constraints: Playwright is the
// only heavyweight dependency this repo is allowed to add). Every tool that
// needs to load a game in a browser (verifiers, the playtest harness) serves
// the game's directory with this and gets back a base URL plus a `close()`.
//
// Deliberately minimal: GET/HEAD only, path-traversal-safe, a small MIME table,
// no caching headers, no directory listing. Games are static single HTML files
// with no other assets in the common case, so this is all that is needed.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Serve `rootDir` (a directory on disk) over HTTP on 127.0.0.1, on an
 * OS-assigned free port. Resolves once listening.
 *
 * @param {string} rootDir absolute path to the directory to serve
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export function serveDir(rootDir) {
  const root = normalize(rootDir);
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      try {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405, { 'content-type': 'text/plain' });
          res.end('method not allowed');
          return;
        }
        let pathname = '/';
        try {
          pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        } catch {
          res.writeHead(400); res.end('bad request'); return;
        }
        if (pathname.endsWith('/')) pathname += 'index.html';
        // Path-traversal guard: resolve, then require the result stays under root.
        const filePath = normalize(join(root, pathname));
        if (filePath !== root && !filePath.startsWith(root + sep)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        let st;
        try { st = await stat(filePath); } catch {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        if (st.isDirectory()) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
          return;
        }
        const type = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
        const body = await readFile(filePath);
        res.writeHead(200, { 'content-type': type, 'content-length': body.length });
        if (req.method === 'HEAD') res.end();
        else res.end(body);
      } catch (err) {
        try {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('internal error: ' + (err && err.message));
        } catch { /* response may already be closed */ }
      }
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((res) => server.close(() => res()))
      });
    });
  });
}

// Allow `node tools/lib/server.js <dir>` for manual poking during development.
if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2] || process.cwd();
  const { url } = await serveDir(dir);
  console.log(`serving ${dir} at ${url}`);
}
