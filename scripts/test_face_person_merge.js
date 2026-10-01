const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'face-merge-test';

const writes = { moved: [], updated: [], deleted: [], commits: 0, rollbacks: 0 };
const feedback = { events: [], samples: [], remaps: [], pairs: [] };
const persons = {
  10: { id: 10, name: '保留的人', note: null, coverFaceId: null },
  20: { id: 20, name: '重复的人', note: null, coverFaceId: null },
};

function person(id) {
  return persons[Number(id)] || null;
}

async function query(sql, params = []) {
  const statement = String(sql).replace(/\s+/g, ' ').trim();
  if (statement.startsWith('SELECT * FROM photo_faces')) return [[
    { id: 100, photo_id: 1, organization_id: 1, person_id: 10, normalized_embedding: [1, 0] },
    { id: 200, photo_id: 2, organization_id: 1, person_id: 20, normalized_embedding: [0.9, 0.1] },
  ]];
  if (statement.startsWith('INSERT INTO face_feedback_events')) { feedback.events.push(params); return [{ insertId: 7 }]; }
  if (statement.startsWith('INSERT INTO face_identity_feedback')) { feedback.samples.push(...params[0]); return [{ affectedRows: params[0].length }]; }
  if (statement.startsWith('UPDATE face_identity_feedback')) { feedback.remaps.push(params); return [{ affectedRows: 1 }]; }
  if (statement.includes('FROM face_person_separations') && statement.startsWith('SELECT')) return [[
    { person_low_id: 10, person_high_id: 20, event_id: 2 },
    { person_low_id: 20, person_high_id: 30, event_id: 3 },
  ]];
  if (statement.startsWith('INSERT INTO face_person_separations')) { feedback.pairs.push(params); return [{ affectedRows: 1 }]; }
  if (statement.includes('SELECT role FROM users')) return [[{ role: Number(params[0]) === 42 ? 'photographer' : 'admin' }]];
  if (statement.includes('SELECT organization_id FROM users')) return [[{ organization_id: 1 }]];
  if (statement.includes('role_permissions')) {
    return [params[0] === 'photographer' && params[1] === 'faces.merge' ? [] : [{ 1: 1 }]];
  }
  if (statement.startsWith('SELECT') && statement.includes('FROM face_persons WHERE organization_id = ? AND id = ?')) {
    return [[person(params[1])].filter(Boolean)];
  }
  if (statement.startsWith('SELECT') && statement.includes('FROM face_persons WHERE organization_id = ? AND id IN (?)')) {
    return [(params[1] || []).map(person).filter(Boolean)];
  }
  if (statement.startsWith("UPDATE photo_faces SET person_id = ?, status = 'confirmed'")) {
    writes.moved.push(params);
    return [{ affectedRows: 3 }];
  }
  if (statement.startsWith('UPDATE face_persons SET name = ?')) {
    writes.updated.push(params);
    return [{ affectedRows: 1 }];
  }
  if (statement.startsWith('DELETE FROM face_persons')) {
    writes.deleted.push(params);
    return [{ affectedRows: 1 }];
  }
  if (statement.includes('FROM face_persons WHERE id = ?')) {
    const row = person(params[0]);
    return [row ? [{ ...row, organizationId: 1, personId: String(row.id), personNo: row.id, createdAt: new Date(), updatedAt: new Date() }] : []];
  }
  return [[]];
}

const fakePool = {
  query,
  getConnection: async () => ({
    query,
    beginTransaction: async () => {},
    commit: async () => { writes.commits += 1; },
    rollback: async () => { writes.rollbacks += 1; },
    release: () => {},
  }),
};

const dbPath = require.resolve(path.join(ROOT, 'db'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: fakePool,
    buildUploadUrl: (value) => value,
    buildInternalMediaUrl: (value) => value,
  },
};

const avatarPath = require.resolve(path.join(ROOT, 'lib/face_avatar'));
require.cache[avatarPath] = {
  id: avatarPath, filename: avatarPath, loaded: true,
  exports: { getFaceAvatarDataUrl: async () => null, SIZE: 256 },
};

const express = require('express');
const router = require(path.join(ROOT, 'routes/faces'));
const app = express();
app.use(express.json());
app.use('/api', router);

async function call(server, method, url, token, body) {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function main() {
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  try {
    const admin = jwt.sign({ id: 1 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const photographer = jwt.sign({ id: 42 }, process.env.JWT_SECRET, { expiresIn: '5m' });
    const payload = { targetPersonId: 10, sourcePersonIds: [20], referenceFaceIds: [200] };

    assert.strictEqual((await call(server, 'POST', '/api/persons/merge', photographer, payload)).status, 403);
    assert.strictEqual((await call(server, 'POST', '/api/persons/merge', admin, { targetPersonId: 10, sourcePersonIds: [] })).status, 400);

    const merged = await call(server, 'POST', '/api/persons/merge', admin, payload);
    assert.strictEqual(merged.status, 200, JSON.stringify(merged.body));
    assert.strictEqual(merged.body.targetPersonId, '10');
    assert.deepStrictEqual(merged.body.sourcePersonIds, ['20']);
    assert.strictEqual(merged.body.movedFaces, 3);
    assert.strictEqual(merged.body.deletedPersons, 1);
    assert.strictEqual(merged.body.profile.person.personId, '10');
    assert.deepStrictEqual(writes.moved[0], [10, 1, [20]]);
    assert.deepStrictEqual(writes.deleted[0], [1, [20]]);
    assert.strictEqual(writes.commits, 1);
    assert.strictEqual(feedback.events[0][2], 'merge');
    assert.strictEqual(feedback.samples.length, 2);
    assert.strictEqual(feedback.samples.find((r) => r[2] === 200)[4], 'explicit');
    assert.strictEqual(feedback.samples.find((r) => r[2] === 100)[4], 'group');
    assert.deepStrictEqual(feedback.remaps[0], [10, 1, [20]]);
    assert.deepStrictEqual(feedback.pairs, [[1, 10, 30, 3]], 'merge removes self-separation and keeps external constraints');

    const missing = await call(server, 'POST', '/api/persons/merge', admin, { targetPersonId: 10, sourcePersonIds: [99] });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(writes.rollbacks, 1);
    assert.strictEqual(writes.commits, 1);
    console.log('✓ face person merge: authorization, transaction, missing-source rollback passed');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
