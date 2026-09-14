// 人物拆分（"系统认错人了？"）集成测试：
// 用假 DB pool 与假头像裁剪替身驱动真实路由处理器，验证拆分预览的智能二分、
// 执行拆分的事务写入、权限与参数校验。不连真实 MySQL / 不真裁图。
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'face-split-test';

// 维度 8 的两组正交向量：A 组=真身，B 组=被误并进来的另一个人
const vA = [1, 0, 0, 0, 0, 0, 0, 0];
const vA2 = [0.98, 0.02, 0, 0, 0, 0, 0, 0];
const vB = [0, 1, 0, 0, 0, 0, 0, 0];
const vB2 = [0, 0.97, 0.03, 0, 0, 0, 0, 0];

// id 101..104 属于真身；201..203 属于被认错的人；205 无 embedding（判不了）
function faceRow(id, vec, personId = 77) {
  return {
    id,
    photo_id: 1000 + id,
    project_id: 5,
    organization_id: 1,
    person_id: personId,
    face_no: 1,
    bbox_x: 0.1, bbox_y: 0.1, bbox_w: 0.2, bbox_h: 0.2, bbox_unit: 'ratio',
    image_width: 4000, image_height: 3000,
    detection_score: 0.9, quality_score: 0.8,
    embedding: null,
    normalized_embedding: vec ? JSON.stringify(vec) : null,
    model_name: 'mobilefacenet_arcface', model_version: null,
    status: 'confirmed', face_hash: null, extra: null,
    created_at: new Date('2026-09-01T00:00:00Z'), updated_at: new Date('2026-09-01T00:00:00Z'),
    photo_title: `照片-${id}`,
    photo_description: null,
    photo_project_id: 5,
    project_name: '测试相册',
    photo_url: '/photos/original.jpg',
    photo_thumb_url: '/photos/thumb.jpg',
  };
}

const personFaces = [
  faceRow(101, vA), faceRow(102, vA2), faceRow(103, vA), faceRow(104, vA2),
  faceRow(201, vB), faceRow(202, vB2), faceRow(203, vB),
  faceRow(205, null),
];

const personRow = {
  id: 77, person_no: 7, name: '张三', note: null, cover_face_id: 201,
  organization_id: 1, created_at: new Date(), updated_at: new Date(),
};

const calls = { updates: [], inserts: [], personUpdates: [] };

function rowsFor(sql, params) {
  sql = String(sql);
  if (/SELECT role FROM users/i.test(sql)) return [[{ role: params && params[0] === 42 ? 'photographer' : 'admin' }], null];
  if (/SELECT organization_id FROM users/i.test(sql)) return [[{ organization_id: 1 }], null];
  if (/role_permissions/i.test(sql)) {
    const role = params && params[0];
    const perm = params && params[1];
    if (role === 'photographer' && perm === 'faces.merge') return [[], null]; // photographer 无权拆分
    return [[{ 1: 1 }], null];
  }
  if (/SELECT COUNT\(\*\) AS total FROM photo_faces/i.test(sql)) return [[{ total: personFaces.length }], null];
  if (/FROM photo_faces pf\s+JOIN photos p ON p\.id = pf\.photo_id/i.test(sql)) return [personFaces, null];
  if (/SELECT id, person_no, name, note, cover_face_id FROM face_persons/i.test(sql)) {
    const pid = Number(params && params[0]);
    return [[pid === 77 ? personRow : null].filter(Boolean), null];
  }
  if (/SELECT id, cover_face_id FROM photo_faces WHERE person_id = \? AND organization_id = \?/i.test(sql)) {
    return [personFaces.map((f) => ({ id: f.id, cover_face_id: null })), null];
  }
  if (/COALESCE\(MAX\(person_no\), 0\) AS maxNo/i.test(sql)) return [[{ maxNo: 10 }], null];
  if (/^INSERT INTO face_persons/i.test(String(sql).trim())) return [{ insertId: 999 }, null];
  if (/SELECT id, extra FROM photo_faces WHERE id IN \(\?\)/i.test(sql)) {
    const wanted = new Set((params && params[0]) || []);
    return [personFaces.filter((f) => wanted.has(f.id)).map((f) => ({ id: f.id, extra: f.extra })), null];
  }
  if (/SELECT id\s+FROM photo_faces\s+WHERE person_id = \? AND organization_id = \?\s+ORDER BY detection_score DESC/i.test(sql)) {
    // 新人物封面取搬走组最高分；原人物封面补选剩余最高分
    const pid = params && params[0];
    const pool2 = pid === 999 ? personFaces.filter((f) => [201, 202, 203].includes(f.id)) : personFaces.filter((f) => [101, 102, 103, 104].includes(f.id));
    return [pool2.slice(0, 1).map((f) => ({ id: f.id })), null];
  }
  if (/SELECT id,\s+organization_id AS organizationId[\s\S]*FROM face_persons WHERE id = \?/i.test(sql)) {
    const pid = Number(params && params[0]);
    if (pid === 77) return [[{ id: 77, organizationId: 1, personNo: 7, name: '张三', note: null, coverFaceId: 104, createdAt: new Date(), updatedAt: new Date() }], null];
    if (pid === 999) return [[{ id: 999, organizationId: 1, personNo: 11, name: null, note: 'split from #77', coverFaceId: 201, createdAt: new Date(), updatedAt: new Date() }], null];
    return [[], null];
  }
  if (/SELECT DISTINCT[\s\S]*FROM photo_faces pf\s+JOIN photos p ON pf\.photo_id = p\.id/i.test(sql)) return [[], null];
  if (/SELECT\s+pf\.,\s+fp\.name AS person_name[\s\S]*WHERE pf\.id = \?/i.test(sql)) return [[], null];
  if (/SELECT pf\.\*,\s+fp\.name AS person_name[\s\S]*FROM photo_faces pf[\s\S]*WHERE pf\.photo_id = \?/i.test(sql)) return [[], null];
  if (/SELECT id FROM face_persons WHERE name = \? AND id <> \?/i.test(sql)) return [[], null];
  return [[], null];
}

const fakePool = {
  query: async (sql, params) => {
    if (/^UPDATE photo_faces SET person_id = \?, status = 'confirmed', extra = \?/i.test(String(sql).trim())) {
      calls.updates.push({ sql: String(sql), params: params.slice() });
      return [{ affectedRows: 1 }, null];
    }
    if (/^UPDATE face_persons SET cover_face_id = \? WHERE id = \?/i.test(String(sql).trim())) {
      calls.personUpdates.push({ params: params.slice() });
      return [{ affectedRows: 1 }, null];
    }
    return rowsFor(sql, params);
  },
  getConnection: async () => {
    const conn = {
      beginTransaction: async () => null,
      commit: async () => null,
      rollback: async () => null,
      release: () => null,
      query: async (sql, params) => {
        if (/^INSERT INTO face_persons/i.test(String(sql).trim())) {
          calls.inserts.push({ sql: String(sql), params: params.slice() });
          return [{ insertId: 999 }, null];
        }
        if (/^UPDATE photo_faces SET person_id = \?, status = 'confirmed', extra = \?/i.test(String(sql).trim())) {
          calls.updates.push({ sql: String(sql), params: params.slice() });
          return [{ affectedRows: 1 }, null];
        }
        if (/^UPDATE face_persons SET cover_face_id = \? WHERE id = \?/i.test(String(sql).trim())) {
          calls.personUpdates.push({ params: params.slice() });
          return [{ affectedRows: 1 }, null];
        }
        return rowsFor(sql, params);
      },
    };
    return conn;
  },
};

const dbPath = require.resolve(path.join(ROOT, 'db'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: fakePool,
    buildUploadUrl: (rel) => `https://mamage.test${rel}`,
    buildInternalMediaUrl: (rel) => `http://127.0.0.1:9000${rel}`,
  },
};

// 头像裁剪替身：直接返回 null（前端会回退照片缩略图），避免真实 fetch/sharp
const avatarPath = require.resolve(path.join(ROOT, 'lib/face_avatar'));
require.cache[avatarPath] = {
  id: avatarPath, filename: avatarPath, loaded: true,
  exports: { getFaceAvatarDataUrl: async () => null, SIZE: 256 },
};

const express = require('express');
const facesRouter = require(path.join(ROOT, 'routes/faces.js'));

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', facesRouter);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(server, method, url, { token, body } = {}) {
  const port = server.address().port;
  const opts = { method, headers: {} };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`http://127.0.0.1:${port}${url}`, opts);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* keep text */ }
  return { status: resp.status, json, text };
}

async function main() {
  const admin = signToken({ id: 1 });
  const photographer = signToken({ id: 42 });

  // 1. GET /persons/:id/faces —— 列表 + 分页字段
  {
    const server = await listen(makeApp());
    const noAuth = await call(server, 'GET', '/api/persons/77/faces', {});
    assert.strictEqual(noAuth.status, 401, 'no token should 401');

    const ok = await call(server, 'GET', '/api/persons/77/faces?pageSize=12', { token: admin });
    assert.strictEqual(ok.status, 200, `expected 200 got ${ok.status}: ${ok.text}`);
    assert.strictEqual(ok.json.total, personFaces.length);
    assert.ok(Array.isArray(ok.json.faces) && ok.json.faces.length === 8);
    assert.strictEqual(ok.json.faces[0].faceId, '101');
    assert.strictEqual(typeof ok.json.faces[0].thumbUrl, 'string');
    server.close();
  }

  // 2. split-preview —— 智能二分：B 组种子应带走整组 B，A 组留下
  {
    const server = await listen(makeApp());
    const noPerm = await call(server, 'POST', '/api/persons/77/split-preview', {
      token: photographer, body: { seedFaceIds: [201] },
    });
    assert.strictEqual(noPerm.status, 403, 'photographer (no faces.merge) should 403');

    const ok = await call(server, 'POST', '/api/persons/77/split-preview', {
      token: admin, body: { seedFaceIds: [201] },
    });
    assert.strictEqual(ok.status, 200, `expected 200 got ${ok.status}: ${ok.text}`);
    const moveIds = ok.json.moveFaces.map((f) => Number(f.faceId)).sort((a, b) => a - b);
    const keepIds = ok.json.keepFaces.map((f) => Number(f.faceId)).sort((a, b) => a - b);
    const undecidedIds = ok.json.undecidedFaces.map((f) => Number(f.faceId));
    assert.deepStrictEqual(moveIds, [201, 202, 203], `B 组应整体拆出，实际 ${JSON.stringify(moveIds)}`);
    assert.deepStrictEqual(keepIds, [101, 102, 103, 104], `A 组应留下，实际 ${JSON.stringify(keepIds)}`);
    assert.deepStrictEqual(undecidedIds, [205], '无 embedding 的脸应列为拿不准');
    assert.strictEqual(ok.json.stats.seedCount, 1);
    assert.strictEqual(ok.json.stats.moveCount, 3);
    server.close();
  }

  // 3. split-preview 参数校验
  {
    const server = await listen(makeApp());
    const foreign = await call(server, 'POST', '/api/persons/77/split-preview', {
      token: admin, body: { seedFaceIds: [201, 9999] },
    });
    assert.strictEqual(foreign.status, 400, '外来 faceId 应 400');

    const all = await call(server, 'POST', '/api/persons/77/split-preview', {
      token: admin, body: { seedFaceIds: personFaces.map((f) => f.id) },
    });
    assert.strictEqual(all.status, 400, '把所有脸标为认错应 400');

    const empty = await call(server, 'POST', '/api/persons/77/split-preview', {
      token: admin, body: { seedFaceIds: [] },
    });
    assert.strictEqual(empty.status, 400, '空种子应 400');
    server.close();
  }

  // 4. split 执行 —— 新人物落库、搬走脸改挂、封面修复
  {
    calls.updates.length = 0;
    calls.inserts.length = 0;
    calls.personUpdates.length = 0;
    const server = await listen(makeApp());
    const ok = await call(server, 'POST', '/api/persons/77/split', {
      token: admin,
      body: { moveFaceIds: [201, 202, 203], newPersonName: '李四' },
    });
    assert.strictEqual(ok.status, 200, `expected 200 got ${ok.status}: ${ok.text}`);
    assert.strictEqual(ok.json.newPersonId, '999');
    assert.strictEqual(ok.json.movedFaces, 3);
    assert.strictEqual(ok.json.originalPersonId, '77');

    assert.strictEqual(calls.inserts.length, 1, '应新建一个 face_persons');
    assert.strictEqual(calls.inserts[0].params[0], 1, 'organization_id');
    assert.strictEqual(calls.inserts[0].params[2], '李四', '新人物姓名');
    assert.ok(String(calls.inserts[0].params[3]).includes('split from #77'), 'note 应记录来源');

    const movedIds = calls.updates.map((u) => u.params[2]).sort((a, b) => a - b);
    assert.deepStrictEqual(movedIds, [201, 202, 203], '三张脸都应改挂新人物');
    for (const u of calls.updates) {
      assert.strictEqual(u.params[0], 999, '目标 person_id=999');
      const extra = JSON.parse(u.params[1]);
      assert.strictEqual(extra.splitFromPersonId, 77);
      assert.strictEqual(extra.splitToPersonId, 999);
    }

    // 原人物封面(201)被搬走 → 应补选；新人物应设封面
    const personIdsUpdated = calls.personUpdates.map((p) => p.params[1]);
    assert.ok(personIdsUpdated.includes(77), '原人物封面应补选');
    assert.ok(personIdsUpdated.includes(999), '新人物应设封面');
    server.close();
  }

  // 5. split 校验：外来脸 / 搬空 / 404 / 无权限
  {
    const server = await listen(makeApp());
    const foreign = await call(server, 'POST', '/api/persons/77/split', {
      token: admin, body: { moveFaceIds: [201, 8888] },
    });
    assert.strictEqual(foreign.status, 400, '外来脸应 400');

    const all = await call(server, 'POST', '/api/persons/77/split', {
      token: admin, body: { moveFaceIds: personFaces.map((f) => f.id) },
    });
    assert.strictEqual(all.status, 400, '搬空应 400');

    const notFound = await call(server, 'POST', '/api/persons/88/split', {
      token: admin, body: { moveFaceIds: [201] },
    });
    assert.strictEqual(notFound.status, 404, '人物不存在应 404');

    const noPerm = await call(server, 'POST', '/api/persons/77/split', {
      token: photographer, body: { moveFaceIds: [201] },
    });
    assert.strictEqual(noPerm.status, 403, 'photographer 应 403');
    server.close();
  }

  console.log('✓ face person split: all 5 scenario groups passed');
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  }
);
