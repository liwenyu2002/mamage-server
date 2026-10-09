const assert = require('assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const faces = [
  { id: 777, photo_id: 1, person_id: 10, organization_id: 1, status: 'legacy_blocked' },
  { id: 888, photo_id: 2, person_id: 20, organization_id: 1, status: 'confirmed' },
];

function stub(relative, exports) {
  const filename = require.resolve(path.join(ROOT, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

async function query(sql, params = []) {
  const statement = String(sql).replace(/\s+/g, ' ').trim();
  if (statement.includes('FROM photos WHERE id = ?')) return [[{ id: params[0], organizationId: 1 }]];
  if (statement.includes('FROM face_persons WHERE id = ?')) return [[{ id: params[0], personNo: params[0] }]];
  if (statement.includes('FROM photo_faces')) {
    let selected = faces.slice();
    if (/WHERE pf\.id = \?/.test(statement)) selected = selected.filter((f) => f.id === Number(params[0]));
    if (/WHERE pf\.photo_id = \?/.test(statement)) selected = selected.filter((f) => f.photo_id === Number(params[0]));
    if (/WHERE pf\.person_id = \?/.test(statement)) selected = selected.filter((f) => f.person_id === Number(params[0]));
    if (statement.includes('legacy_blocked')) selected = selected.filter((f) => f.status !== 'legacy_blocked');
    if (statement.startsWith('SELECT DISTINCT')) return [selected.map((f) => ({ id: f.photo_id }))];
    return [selected];
  }
  throw new Error('unexpected policy test SQL: ' + statement);
}

stub('db', { pool: { query, getConnection: async () => { throw new Error('blocked face reached a write'); } } });
stub('lib/permissions', { requirePermission: () => (req, _res, next) => {
  req.user = { id: 1, organization_id: 1 }; next();
} });
stub('lib/workspace_access', { resolveWorkspace: async () => ({ enabled: false }),
  requireProjectAccess: async () => {}, requirePhotoAccess: async () => {}, sendWorkspaceError: () => false });
stub('lib/face_avatar', { getFaceAvatarDataUrl: async () => null });
stub('lib/media_access', { buildMediaUrl: (value) => value });

const express = require('express');
const app = express();
app.use(express.json());
app.use('/api', require('../routes/faces'));

async function main() {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  async function call(route, method = 'GET', body) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${route}`, {
      method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  try {
    for (const route of ['/faces?photoId=1', '/faces?personId=10', '/persons/10/faces', '/persons/10/photos']) {
      const result = await call(route);
      assert.equal(result.status, 200);
      assert.equal(result.body.total, 0, route + ' must hide blocked legacy results');
    }
    assert.equal((await call('/faces/777')).status, 404, 'old face IDs must not serve profiles');
    assert.equal((await call('/faces/label', 'POST', { faceId: 777, personId: 10 })).status, 404,
      'old cached clients must not reactivate a blocked face');
    const current = await call('/faces?photoId=2');
    assert.equal(current.body.total, 1, 'current results remain visible');
    assert.equal(current.body.faces[0].faceId, '888');
    console.log('face result policy: API lists, profiles, related photos and stale label requests passed');
  } finally { await new Promise((resolve) => server.close(resolve)); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
