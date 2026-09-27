const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

if (!String(process.env.DB_NAME || '').endsWith('_workspace_test')) {
  throw new Error('Set DB_NAME to an isolated *_workspace_test database');
}
process.env.ORGANIZATION_UNITS_ACTIVE = '1';
process.env.VIDEO_RENDER_RECOVER_ON_BOOT = '0';

const { pool } = require('../db');
const { JWT_SECRET } = require('../config/keys');
const storage = require('../lib/video_editor_storage');
const router = require('../routes/video_projects');

async function main() {
  const suffix = crypto.randomBytes(8).toString('hex');
  const ids = {};
  let server;
  const originalAssertStorage = storage.assertObjectStorage;
  try {
    const [permission] = await pool.query('INSERT INTO role_permissions (role, permission) VALUES (?, ?)',
      ['photographer', 'ai.generate']);
    ids.permission = permission.insertId;
    const [org] = await pool.query('INSERT INTO organizations (name, slug, code) VALUES (?, ?, ?)',
      ['Video unit test', `video-unit-${suffix}`, `VIDEO-${suffix}`]);
    ids.org = org.insertId;
    const [unitA] = await pool.query('INSERT INTO organization_units (organization_id, slug, name) VALUES (?, ?, ?)',
      [ids.org, `a-${suffix}`, 'A']);
    const [unitB] = await pool.query('INSERT INTO organization_units (organization_id, slug, name) VALUES (?, ?, ?)',
      [ids.org, `b-${suffix}`, 'B']);
    ids.unitA = unitA.insertId;
    ids.unitB = unitB.insertId;
    const [user] = await pool.query(
      'INSERT INTO users (student_no, name, role, organization_id, active_unit_id) VALUES (?, ?, ?, ?, ?)',
      [`video-${suffix}`, 'Video tester', 'photographer', ids.org, ids.unitA]);
    ids.user = user.insertId;
    await pool.query(
      'INSERT INTO organization_unit_memberships (unit_id, user_id, role) VALUES (?, ?, ?), (?, ?, ?)',
      [ids.unitA, ids.user, 'editor', ids.unitB, ids.user, 'editor']);
    const makeAsset = async (unitId) => {
      const [result] = await pool.query(
        `INSERT INTO video_editor_assets (user_id, org_id, unit_id, name, storage_path)
         VALUES (?, ?, ?, ?, ?)`,
        [ids.user, ids.org, unitId, `asset-${unitId}`, `uploads/video-editor/assets/${suffix}/${unitId}.mp4`]);
      return result.insertId;
    };
    ids.assetA = await makeAsset(ids.unitA);
    ids.assetB = await makeAsset(ids.unitB);
    ids.assetLegacy = await makeAsset(null);

    const projectJson = JSON.stringify({
      sources: [{ id: 'source-1', assetId: String(ids.assetA) }],
      clips: [{ sourceId: 'source-1', inPoint: 0, outPoint: 1 }],
    });
    const [project] = await pool.query(
      `INSERT INTO video_projects (user_id, org_id, unit_id, name, project_json)
       VALUES (?, ?, ?, ?, ?)`, [ids.user, ids.org, ids.unitB, 'Cross-unit asset test', projectJson]);
    ids.project = project.insertId;

    storage.assertObjectStorage = () => {};
    const app = express();
    app.use(express.json());
    app.use('/api/video-projects', router);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const base = `http://127.0.0.1:${server.address().port}/api/video-projects`;
    const token = jwt.sign({ id: ids.user }, JWT_SECRET, { expiresIn: '5m' });
    const headers = (unitId) => ({ Authorization: `Bearer ${token}`, 'x-mamage-unit-id': String(unitId) });
    const listA = await fetch(`${base}/assets`, { headers: headers(ids.unitA) });
    assert.equal(listA.status, 200);
    assert.deepEqual((await listA.json()).assets.map((asset) => Number(asset.id)), [ids.assetA]);
    const listB = await fetch(`${base}/assets`, { headers: headers(ids.unitB) });
    assert.equal(listB.status, 200);
    assert.deepEqual((await listB.json()).assets.map((asset) => Number(asset.id)), [ids.assetB]);
    const analyzeOtherUnit = await fetch(`${base}/assets/${ids.assetA}/analyze`, {
      method: 'POST', headers: headers(ids.unitB),
    });
    assert.equal(analyzeOtherUnit.status, 404);
    const render = await fetch(`${base}/${ids.project}/render`, { method: 'POST', headers: headers(ids.unitB) });
    assert.equal(render.status, 202);
    const jobId = (await render.json()).job.id;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const [jobs] = await pool.query('SELECT status, error_text FROM video_render_jobs WHERE id = ?', [jobId]);
      if (jobs[0].status === 'failed') {
        assert.match(jobs[0].error_text, /无权访问/);
        break;
      }
      if (attempt === 59) assert.fail('render did not reject cross-unit asset');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    console.log('workspace video asset isolation passed');
  } finally {
    storage.assertObjectStorage = originalAssertStorage;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (ids.project) await pool.query('DELETE FROM video_render_jobs WHERE project_id = ?', [ids.project]);
    if (ids.project) await pool.query('DELETE FROM video_projects WHERE id = ?', [ids.project]);
    if (ids.user) await pool.query('DELETE FROM video_editor_assets WHERE user_id = ?', [ids.user]);
    if (ids.user) await pool.query('DELETE FROM organization_unit_memberships WHERE user_id = ?', [ids.user]);
    if (ids.user) await pool.query('DELETE FROM users WHERE id = ?', [ids.user]);
    if (ids.unitA) await pool.query('DELETE FROM organization_units WHERE id IN (?, ?)', [ids.unitA, ids.unitB]);
    if (ids.org) await pool.query('DELETE FROM organizations WHERE id = ?', [ids.org]);
    if (ids.permission) await pool.query('DELETE FROM role_permissions WHERE id = ?', [ids.permission]);
    await pool.end();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
