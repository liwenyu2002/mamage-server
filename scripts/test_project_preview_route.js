const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
let queries = 0, revoked = false;
const moduleFixture = { exports: {} };
const db = { query: async sql => {
  queries++;
  if (sql.includes('FROM photos')) return [[{ id: 11, thumbUrl: '/private-thumb.jpg' }]];
  if (sql.includes('ai_image_embeddings')) return [[{ photo_id: 11, embedding: [1, 0] }]];
  throw new Error(`Unexpected fixture query: ${sql}`);
} };
const workspace = {
  resolveWorkspace: async () => ({ enabled: true }),
  requireProjectAccess: async (req, id, action) => {
    assert.equal(action, 'read');
    if (revoked || !req.user || req.user.organization_id !== 2 || id !== 1) {
      const error = new Error('PROJECT_NOT_FOUND'); error.status = 404; throw error;
    }
    return { id: 1, organization_id: 2 };
  },
  sendWorkspaceError: (res, error) => { if (!error.status) return false; res.status(error.status).json({ error: error.message }); return true; },
};
const mocks = {
  '../db': { pool: db }, '../config/keys': { UPLOAD_BASE_URL: 'https://fixture.invalid' },
  uuid: { v4: () => 'test-only' }, '../lib/cos_storage': {}, '../lib/face_result_policy': {},
  '../lib/external_import_jobs': {}, '../lib/external_import_worker': {},
  '../lib/workspace_access': workspace,
  '../lib/media_access': { buildMediaUrl: (_key, options) => `/signed/${options.photoId}?viewer=${options.userId}` },
  '../lib/permissions': { requirePermission: permission => (req, res, next) => {
    if (permission === 'photos.view' && req.get('x-deny-photos')) return res.status(403).json({ error: 'FORBIDDEN' });
    return next();
  } },
};
const source = fs.readFileSync(path.join(__dirname, '../routes/projects.js'), 'utf8');
new Function('require', 'module', 'exports', '__dirname', source)(name => {
  if (Object.hasOwn(mocks, name)) return mocks[name];
  return require(name);
}, moduleFixture, moduleFixture.exports, path.join(__dirname, '../routes'));

(async () => {
  const app = express();
  app.use((req, _res, next) => { if (req.get('x-test-user')) req.user = { id: Number(req.get('x-test-user')), organization_id: Number(req.get('x-test-org') || 2) }; next(); });
  app.use('/api/projects', moduleFixture.exports);
  const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/projects/1/previews`;
    assert.equal((await fetch(url)).status, 404);
    assert.equal((await fetch(url, { headers: { 'x-test-user': '1', 'x-test-org': '3' } })).status, 404);
    assert.equal((await fetch(url, { headers: { 'x-test-user': '1', 'x-deny-photos': '1' } })).status, 403);
    assert.equal(queries, 0, 'denied requests must not read preview data');
    const first = await fetch(url, { headers: { 'x-test-user': '1' } });
    assert.equal(first.headers.get('cache-control'), 'private, no-store');
    const body = await first.json();
    assert.equal(body.list[0].thumbUrl, '/signed/11?viewer=1');
    assert.equal(body.photos, undefined); assert.equal(body.list[0].embedding, undefined);
    const second = await fetch(url, { headers: { 'x-test-user': '3' } });
    assert.equal((await second.json()).list[0].thumbUrl, '/signed/11?viewer=3');
    assert.equal(queries, 2, 'cache rows, never user-specific signatures');
    revoked = true;
    assert.equal((await fetch(url, { headers: { 'x-test-user': '1' } })).status, 404);
    console.log('PASS: private preview route, organization/permission guards, fresh per-user signatures and revocation before cache');
  } finally { await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
