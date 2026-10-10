const assert = require('node:assert/strict');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = 'face-person-name-test';
const { isUsableFaceResult } = require('../lib/face_result_policy');
const people = [
  { id: 20, organization_id: 1, name: '空档案姓名' },
  { id: 10, organization_id: 1, name: null },
  { id: 30, organization_id: 1, name: '停用档案姓名' },
  { id: 40, organization_id: 1, name: '已有有效人物' },
  { id: 50, organization_id: 2, name: '其他学院姓名' },
  { id: 60, organization_id: 1, name: '失效档案姓名' },
];
const faces = [
  { id: 101, person_id: 10, organization_id: 1, photo_id: 1, status: 'confirmed' },
  { id: 102, person_id: 10, organization_id: 1, photo_id: 2, status: 'confirmed' },
  { id: 301, person_id: 30, organization_id: 1, photo_id: 3, status: 'legacy_blocked' },
  { id: 401, person_id: 40, organization_id: 1, photo_id: 4, status: 'confirmed' },
  { id: 501, person_id: 50, organization_id: 2, photo_id: 5, status: 'confirmed' },
  { id: 601, person_id: 60, organization_id: 1, photo_id: 6, status: 'rejected' },
  { id: 602, person_id: 60, organization_id: 1, photo_id: 7, status: 'deleted' },
];
const activeCount = (id) => faces.filter((face) => face.person_id === id && isUsableFaceResult(face)).length;
const feedback = [];

// Exercise the real HTTP handlers against the same empty/inactive profile pattern as production.
async function query(sql, params = []) {
  const statement = String(sql).replace(/\s+/g, ' ').trim();
  if (statement.includes('SELECT role FROM users')) return [[{ role: 'admin' }]];
  if (statement.includes('SELECT organization_id FROM users')) return [[{ organization_id: 1 }]];
  if (statement.includes('role_permissions')) return [[{ 1: 1 }]];
  if (statement.startsWith('SELECT id FROM face_persons WHERE name = ?')) {
    const duplicate = statement.includes('id <> ?');
    const org = params[duplicate ? 2 : 1];
    let rows = people.filter((person) => person.name === params[0] && person.organization_id === org
      && (!duplicate || person.id !== params[1]));
    const exists = statement.indexOf('EXISTS');
    const order = statement.indexOf('ORDER BY');
    if (exists >= 0 && (order < 0 || exists < order)) rows = rows.filter((person) => activeCount(person.id) > 0);
    if (order >= 0 && exists > order) rows.sort((a, b) => activeCount(b.id) - activeCount(a.id));
    return [rows.slice(0, 1).map(({ id }) => ({ id }))];
  }
  if (statement.includes('FROM face_persons fp') && statement.includes('fp.name LIKE ?')) {
    const term = String(params[1]).slice(1, -1);
    const rows = people.filter((person) => person.organization_id === params[0]
      && activeCount(person.id) > 0 && person.name?.includes(term));
    if (statement.startsWith('SELECT COUNT(*)')) return [[{ total: rows.length }]];
    return [rows.map((person) => ({ ...person, faceCount: activeCount(person.id), personNo: person.id }))];
  }
  if (statement.startsWith('UPDATE face_persons SET name = ?')) {
    const person = people.find((row) => row.id === params[1] && row.organization_id === params[2]);
    if (!person) return [{ affectedRows: 0 }];
    person.name = params[0];
    return [{ affectedRows: 1 }];
  }
  if (statement.includes('FROM face_persons WHERE id = ?')) {
    return [people.filter((person) => person.id === params[0] && person.organization_id === params[1])
      .map((person) => ({ ...person, organizationId: person.organization_id, personNo: person.id }))];
  }
  if (statement.startsWith('SELECT * FROM photo_faces WHERE person_id = ?')) {
    return [faces.filter((face) => face.person_id === params[0] && face.organization_id === params[1] && isUsableFaceResult(face))];
  }
  if (statement.startsWith('SELECT * FROM photo_faces WHERE id = ?')) {
    return [faces.filter((face) => face.id === params[0] && face.organization_id === params[1] && isUsableFaceResult(face)).map((face) => ({ ...face }))];
  }
  if (statement.includes('FROM photo_faces pf') && statement.includes('WHERE pf.id = ?')) {
    return [faces.filter((face) => face.id === params[0] && face.organization_id === params[1] && isUsableFaceResult(face)).map((face) => ({ ...face }))];
  }
  if (statement.startsWith('UPDATE photo_faces SET person_id = ?, status = ? WHERE id = ?')) {
    const face = faces.find((row) => row.id === params[2]);
    face.person_id = params[0]; face.status = params[1];
    return [{ affectedRows: 1 }];
  }
  if (statement.startsWith('INSERT INTO face_feedback_events')) { feedback.push(params); return [{ insertId: feedback.length }]; }
  if (statement.startsWith('INSERT INTO face_identity_feedback')) return [{ affectedRows: params[0].length }];
  if (statement.includes('SELECT DISTINCT') && statement.includes('FROM photo_faces pf')) return [[]];
  throw new Error(`Unexpected test SQL: ${statement}`);
}
const pool = { query, getConnection: async () => ({ query,
  beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
}) };
for (const [modulePath, exports] of [
  ['db', { pool, buildUploadUrl: (value) => value, buildInternalMediaUrl: (value) => value }],
  ['lib/face_avatar', { getFaceAvatarDataUrl: async () => null }],
]) {
  const id = require.resolve(path.join(ROOT, modulePath));
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const express = require('express');
const app = express();
app.use(express.json());
app.use('/api', require('../routes/faces'));

async function main() {
  const server = await new Promise((resolve) => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
  const token = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
  const call = async (method, url, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  try {
    const snapshot = JSON.stringify(faces);
    for (const personName of ['空档案姓名', '停用档案姓名', '失效档案姓名', '其他学院姓名']) {
      const search = await call('GET', `/persons?q=${encodeURIComponent(personName)}`);
      assert.equal(search.status, 200);
      assert.equal(search.body.list.length, 0);
      const renamed = await call('PATCH', '/persons/10', { personName });
      assert.equal(renamed.status, 200, `hidden/inactive profiles must not reserve names: ${JSON.stringify(renamed.body)}`);
      assert.equal(renamed.body.person.personId, '10');
      assert.equal(renamed.body.person.name, personName);
    }
    assert.equal(JSON.stringify(faces), snapshot, 'renaming must not restore or move any faces');
    const conflict = await call('PATCH', '/persons/10', { personName: '已有有效人物' });
    assert.equal(conflict.status, 409);
    assert.match(conflict.body.message, /姓名|人物/);
    const search = await call('GET', `/persons?q=${encodeURIComponent('已有有效人物')}`);
    assert.deepEqual(search.body.list.map((person) => person.personId), ['40']);
    assert.equal(String(conflict.body.existingPersonId), '40');
    assert.equal((await call('PATCH', '/persons/999', { personName: '新姓名' })).status, 404);
    assert.equal((await call('PATCH', '/persons/10', { personName: '' })).status, 400);

    // Invalid face selection deliberately stops the split after its duplicate-name guard.
    const split = await call('POST', '/persons/10/split', { newPersonName: '停用档案姓名', moveFaceIds: [999] });
    assert.equal(split.status, 400, 'inactive name must pass the split duplicate-name guard');
    assert.match(split.body.error, /do not belong/);
    const splitConflict = await call('POST', '/persons/10/split', { newPersonName: '已有有效人物', moveFaceIds: [101] });
    assert.equal(splitConflict.status, 409);
    assert.equal(String(splitConflict.body.existingPersonId), '40');

    await call('PATCH', '/persons/10', { personName: '空档案姓名' });
    const labeled = await call('POST', '/faces/label', { faceId: 401, personName: '空档案姓名' });
    assert.equal(labeled.status, 200, JSON.stringify(labeled.body));
    assert.equal(labeled.body.person.personId, '10', 'labeling must prefer the active profile over the older empty profile');
    assert.equal(faces.find((face) => face.id === 401).person_id, 10);
    assert.equal(people.find((person) => person.id === 20).name, '空档案姓名', 'retain old profile and audit history');
    assert.equal(faces.find((face) => face.id === 301).status, 'legacy_blocked');
    assert.equal(feedback.length, 1);
    console.log('face person names: empty/inactive reuse, active conflict/search, scope, split guard and label lookup passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
