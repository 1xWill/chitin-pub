#!/usr/bin/env node
/**
 * Minimal Moltx mock server for CHITIN staging tests.
 *
 * - GET  /__mock/health
 * - POST /__mock/reset
 * - POST /__mock/post   { id, author_id, author_name, content }
 * - GET  /v1/posts/:id
 */

import http from 'node:http';

const port = Number(process.argv[2] || 8788);

let posts = new Map();

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && u.pathname === '/__mock/health') {
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/__mock/reset') {
      posts = new Map();
      return json(res, 200, { ok: true });
    }

    if (req.method === 'POST' && u.pathname === '/__mock/post') {
      const body = await readBody(req);
      if (!body?.id || !body?.author_id) return json(res, 400, { ok: false, error: 'missing_fields' });
      posts.set(String(body.id), {
        id: String(body.id),
        author_id: String(body.author_id),
        author_name: String(body.author_name ?? 'mock'),
        content: body.content ?? null,
        created_at: new Date().toISOString()
      });
      return json(res, 200, { ok: true });
    }

    const m = u.pathname.match(/^\/v1\/posts\/([0-9a-fA-F-]{36})$/);
    if (req.method === 'GET' && m) {
      const id = m[1];
      const post = posts.get(id);
      if (!post) return json(res, 404, { success: false, error: 'not_found' });
      return json(res, 200, { success: true, data: { post } });
    }

    return json(res, 404, { ok: false, error: 'not_found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: e?.message || String(e) });
  }
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock-moltx listening on http://127.0.0.1:${port}\n`);
});

