#!/usr/bin/env node
/**
 * Minimal mock Moltbook server for local/testnet staging.
 *
 * Implements only the endpoints CHITIN backend uses:
 * - GET  /api/v1/agents/profile?name=...
 * - GET  /api/v1/posts/:id
 * - GET  /api/v1/posts?submolt=...&sort=new&limit=...&offset=...
 *
 * Plus a tiny admin API for tests:
 * - POST /__mock/reset
 * - POST /__mock/agent   { id, name, description?, is_claimed?, owner? }
 * - POST /__mock/post    { id, authorName, submolt, title?, content }
 */

import http from 'node:http';
import { randomUUID } from 'node:crypto';

function json(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length)
  });
  res.end(body);
}

function text(res, status, s) {
  const body = Buffer.from(String(s));
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(body.length) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function nowIso() {
  return new Date().toISOString();
}

/** @type {Map<string, any>} name -> agent */
const agentsByName = new Map();
/** @type {Map<string, any>} id -> agent */
const agentsById = new Map();

/** @type {Map<string, any>} id -> post */
const postsById = new Map();
/** @type {string[]} post ids newest-first */
let feed = [];

function ensureAgent(name) {
  const existing = agentsByName.get(name);
  if (existing) return existing;
  const a = {
    id: randomUUID(),
    name,
    description: null,
    is_claimed: false,
    owner: null
  };
  agentsByName.set(name, a);
  agentsById.set(a.id, a);
  return a;
}

function addAgent(agent) {
  if (!agent?.id || !agent?.name) throw new Error('agent requires id + name');
  agentsByName.set(agent.name, agent);
  agentsById.set(agent.id, agent);
  return agent;
}

function addPost(p) {
  if (!p?.id) throw new Error('post requires id');
  postsById.set(p.id, p);
  // newest first
  feed = [p.id, ...feed.filter((x) => x !== p.id)];
  return p;
}

function handle(req, res) {
  const u = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';

  // Health
  if (method === 'GET' && u.pathname === '/__mock/health') {
    return json(res, 200, { ok: true, agents: agentsByName.size, posts: postsById.size });
  }

  // Admin: reset
  if (method === 'POST' && u.pathname === '/__mock/reset') {
    agentsByName.clear();
    agentsById.clear();
    postsById.clear();
    feed = [];
    return json(res, 200, { ok: true });
  }

  // Admin: create/update agent
  if (method === 'POST' && u.pathname === '/__mock/agent') {
    return readBody(req)
      .then((raw) => {
        const body = raw ? JSON.parse(raw) : {};
        const agent = addAgent({
          id: String(body.id ?? randomUUID()),
          name: String(body.name ?? ''),
          description: body.description ?? null,
          is_claimed: Boolean(body.is_claimed ?? false),
          owner: body.owner ?? null
        });
        json(res, 200, { ok: true, agent });
      })
      .catch((e) => json(res, 400, { ok: false, error: String(e?.message ?? e) }));
  }

  // Admin: create post
  if (method === 'POST' && u.pathname === '/__mock/post') {
    return readBody(req)
      .then((raw) => {
        const body = raw ? JSON.parse(raw) : {};
        const id = String(body.id ?? randomUUID());
        const authorName = String(body.authorName ?? '');
        const submolt = String(body.submolt ?? 'chitin');
        const content = String(body.content ?? '');
        const title = body.title === undefined ? null : body.title;

        if (!authorName) throw new Error('authorName required');
        const author = ensureAgent(authorName);

        const post = addPost({
          id,
          title: title === null ? null : String(title),
          content,
          created_at: nowIso(),
          submolt: { name: submolt },
          author: { id: author.id, name: author.name }
        });

        json(res, 200, { ok: true, post });
      })
      .catch((e) => json(res, 400, { ok: false, error: String(e?.message ?? e) }));
  }

  // Moltbook: profile fetch by name
  if (method === 'GET' && u.pathname === '/api/v1/agents/profile') {
    const name = String(u.searchParams.get('name') ?? '').trim();
    if (!name) return json(res, 400, { success: false, error: 'missing_name' });
    const agent = ensureAgent(name);
    return json(res, 200, { success: true, agent });
  }

  // Moltbook: single post by id
  if (method === 'GET' && u.pathname.startsWith('/api/v1/posts/')) {
    const id = decodeURIComponent(u.pathname.slice('/api/v1/posts/'.length));
    const post = postsById.get(id);
    if (!post) return json(res, 404, { success: false });
    return json(res, 200, { success: true, post });
  }

  // Moltbook: posts listing (submolt feed)
  if (method === 'GET' && u.pathname === '/api/v1/posts') {
    const submolt = String(u.searchParams.get('submolt') ?? '').trim();
    const limit = Math.max(1, Math.min(100, Number(u.searchParams.get('limit') ?? '25') || 25));
    const offset = Math.max(0, Number(u.searchParams.get('offset') ?? '0') || 0);
    const sort = String(u.searchParams.get('sort') ?? 'new');

    if (!submolt) return json(res, 400, { success: false, error: 'missing_submolt' });
    if (sort !== 'new') {
      // CHITIN only uses sort=new today.
      return json(res, 400, { success: false, error: 'unsupported_sort' });
    }

    const all = feed
      .map((id) => postsById.get(id))
      .filter(Boolean)
      .filter((p) => String(p.submolt?.name ?? '') === submolt);

    const page = all.slice(offset, offset + limit);
    const nextOffset = offset + page.length;
    const hasMore = nextOffset < all.length;

    return json(res, 200, {
      success: true,
      posts: page,
      has_more: hasMore,
      next_offset: hasMore ? nextOffset : null
    });
  }

  return text(res, 404, 'not_found');
}

const port = Number(process.env.MOCK_MOLTBOOK_PORT ?? process.argv[2] ?? 8787);
const server = http.createServer(handle);
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`mock-moltbook listening on http://127.0.0.1:${port}\n`);
});

