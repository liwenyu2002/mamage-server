const assert = require('node:assert/strict');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const workspace = { enabled: true, orgId: 1, unitId: 3, userId: 17, collegeAdmin: false };
const calls = [];
let avatars = 0;
const photos = Array.from({ length: 246 }, (_, i) => ({ id: 1000 - i, projectId: 9, projectName: 'Album',
  url: `original-${i}.jpg`, thumbUrl: `thumb-${i}.jpg`, title: `Photo ${i}`, createdAt: '2026-10-01' }));
const face = { id: 101, photo_id: 1000, person_id: 1, face_no: 1, organization_id: 1,
  bbox_x: .2, bbox_y: .3, bbox_w: .1, bbox_h: .2, bbox_unit: 'ratio', photo_url: 'original.jpg',
  photo_thumb_url: 'thumb.jpg', embedding: JSON.stringify(Array(512).fill(.123456789)), normalized_embedding: JSON.stringify(Array(512).fill(.123456789)) };
async function query(sql, params = []) {
  const text = String(sql).replace(/\s+/g, ' ').trim(); calls.push({ text, params });
  if (text.includes('FROM face_search_grants')) return [[{ college_wide: 1 }]];
  if (text.startsWith('INSERT INTO organization_access_audit')) return [{ affectedRows: 1 }];
  if (text.includes('FROM face_persons WHERE id = ?')) return [[{ id: 1, name: 'Person', coverFaceId: 102 }]];
  if (text.includes('WHERE pf.id = ?')) {
    assert(text.includes('pf.organization_id = ?')); assert(text.includes('pr.restricted_to_user_id'));
    assert(text.includes('s.target_unit_id = ?')); assert(params.includes(workspace.unitId));
    return [params[0] === 101 ? [face] : []];
  }
  if (text.includes('WHERE pf.person_id = ?')) {
    assert(text.includes('pf.organization_id = ?')); assert(text.includes('pr.restricted_to_user_id'));
    assert(text.includes('s.target_unit_id = ?')); assert(params.includes(workspace.unitId));
    if (text.startsWith('SELECT COUNT(DISTINCT p.id)')) return [[{ total: photos.length }]];
    const limit = text.includes('LIMIT ?') ? params[text.includes('OFFSET ?') ? params.length - 2 : params.length - 1] : photos.length;
    const offset = text.includes('OFFSET ?') ? params.at(-1) : 0;
    return [photos.slice(offset, offset + limit)];
  }
  throw new Error(`Unexpected SQL: ${text}`);
}
const mocks = [
  ['db', { pool: { query }, buildInternalMediaUrl: value => value }],
  ['lib/media_access', { buildMediaUrl: value => value }],
  ['lib/permissions', { requirePermission: () => (req, res, next) => { req.user = { id: 17, organization_id: 1 }; next(); } }],
  ['lib/workspace_access', { resolveWorkspace: async req => { req.workspace = workspace; return workspace; }, sendWorkspaceError: () => false }],
  ['lib/face_avatar', { getFaceAvatarDataUrl: async () => { avatars++; await new Promise(resolve => setTimeout(resolve, 250)); return 'data:image/jpeg;base64,dGVzdA=='; } }],
];
for (const [name, exports] of mocks) { const id = require.resolve(path.join(ROOT, name)); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const express = require('express'); const app = express(); app.use('/api', require('../routes/faces'));
async function main() {
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const call = async url => { const start = performance.now(); const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`); return { status: response.status, body: await response.json(), elapsedMs: performance.now() - start }; };
  try {
    const compact = await call('/faces/101/person?compact=1&pageSize=24&includeAvatar=0');
    assert.equal(compact.status, 200); assert.equal(avatars, 0, 'Opening a profile must not wait for avatar generation');
    assert(compact.elapsedMs < 200); assert.equal(compact.body.relatedPhotos.length, 24);
    assert.equal(compact.body.total, 246); assert.equal(compact.body.hasMore, true); assert.equal(compact.body.page, 1);
    assert.equal(compact.body.avatarFaceId, '101', 'Do not expose an inaccessible cover face');
    assert(!compact.body.face.embedding); assert(!compact.body.face.normalizedEmbedding);
    assert(!compact.body.photos, 'Do not serialize the photo list twice');
    assert(Buffer.byteLength(JSON.stringify(compact.body)) < 131072);
    const next = await call('/persons/1/photos?page=2&pageSize=24');
    assert.equal(next.body.photos.length, 24); assert.equal(next.body.total, 246); assert.equal(next.body.page, 2);
    assert.equal(next.body.photos[0].id, String(photos[24].id));
    const last = await call('/persons/1/photos?page=11&pageSize=24');
    assert.equal(last.body.photos.length, 6); assert.equal(last.body.hasMore, false);
    const clamp = await call('/persons/1/photos?page=1&pageSize=999999');
    assert(clamp.body.photos.length <= 72); assert.equal(clamp.body.pageSize, 72);
    const avatar = await call('/faces/101/avatar'); assert.equal(avatar.status, 200); assert(avatar.body.avatarDataUrl);
    assert.equal((await call('/faces/102/avatar')).status, 404);
    const legacy = await call('/faces/101/person'); assert.equal(legacy.body.relatedPhotos.length, 246); assert(legacy.body.photos); assert(legacy.body.avatarDataUrl);
    assert.equal((await call('/persons/1/photos?limit=5')).body.photos.length, 5);
    console.log(JSON.stringify({ compact: true, total: 246, firstPage: 24, pagination: true, scopedAvatar: true, legacyCompatible: true, initialMs: Math.round(compact.elapsedMs), initialBytes: Buffer.byteLength(JSON.stringify(compact.body)) }));
  } finally { await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
