const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { JWT_SECRET } = require('../config/keys');
const { createJob, ingestBatch } = require('../lib/external_import_jobs');
const externalImportRoutes = require('../routes/external_imports');

async function main() {
  if (process.env.TEST_EXTERNAL_IMPORT_DB !== '1') throw new Error('Set TEST_EXTERNAL_IMPORT_DB=1 for the local DB integration test');
  const [users] = await pool.query('SELECT id, role, organization_id FROM users WHERE organization_id IS NOT NULL ORDER BY id LIMIT 1');
  assert.ok(users.length, 'test organization user is required');
  const user = users[0];
  let projectId;
  let jobId;
  let server;
  try {
    const [created] = await pool.query(
      "INSERT INTO projects (uuid, name, organization_id) VALUES (UUID(), '__external_import_test__', ?)",
      [user.organization_id]
    );
    projectId = created.insertId;
    const req = { user, get: () => undefined };
    const first = await createJob(req, projectId, 'https://gallery.example.com/event?id=123');
    jobId = first.jobId;
    assert.equal(first.existing, false);
    assert.equal((await createJob(req, projectId, 'https://gallery.example.com/event?id=123')).existing, true);
    await assert.rejects(createJob(req, projectId, 'https://gallery.example.com/event?id=456'), { status: 409 });
    await pool.query("UPDATE external_import_jobs SET status = 'running' WHERE id = ?", [jobId]);
    const job = { id: jobId, project_id: projectId };
    const photos = Array.from({ length: 1300 }, (_, index) => ({
      id: String(index + 1), filename: `photo-${index + 1}.jpg`,
      sectionName: index < 650 ? '开幕' : '闭幕',
      transferUrl: `https://gallery.example.com/original/${index + 1}.jpg`,
      previewUrl: `https://gallery.example.com/thumb/${index + 1}.jpg`,
    }));
    for (let index = 0; index < photos.length; index += 100) {
      await ingestBatch(job, photos.slice(index, index + 100), { title: '测试活动', reportedTotal: 1300 });
    }
    assert.equal(await ingestBatch(job, photos.slice(0, 100), { title: '测试活动', reportedTotal: 1300 }), 0);
    const [[counts]] = await pool.query(
      'SELECT selected_count AS selectedCount, discovered_count AS discoveredCount, reported_total AS reportedTotal FROM external_import_jobs WHERE id = ?', [jobId]
    );
    assert.equal(Number(counts.selectedCount), 1300);
    assert.equal(Number(counts.discoveredCount), 1300);
    assert.equal(Number(counts.reportedTotal), 1300);
    const [sections] = await pool.query('SELECT name FROM project_timeline_sections WHERE project_id = ? ORDER BY sort_order', [projectId]);
    assert.deepEqual(sections.map((row) => row.name), ['开幕', '闭幕']);
    const [[project]] = await pool.query('SELECT meta FROM projects WHERE id = ?', [projectId]);
    const meta = typeof project.meta === 'string' ? JSON.parse(project.meta) : project.meta;
    assert.equal(meta.timelineEnabled, true);
    const app = express();
    app.use(express.json());
    app.use('/api/external-imports', externalImportRoutes);
    server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}/api/external-imports`;
    const headers = { Authorization: `Bearer ${jwt.sign({ id: user.id }, JWT_SECRET)}` };
    const list = await fetch(`${base}/jobs?projectId=${projectId}`, { headers });
    assert.equal(list.status, 200);
    assert.equal((await list.json()).jobs[0].discoveredCount, 1300);
    const detail = await fetch(`${base}/jobs/${jobId}`, { headers });
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).counts.pending, 1300);
    const updates = await fetch(`${base}/jobs/${jobId}/updates`, { headers });
    assert.equal(updates.status, 200);
    assert.equal((await updates.json()).sections.length, 2);
    const stop = await fetch(`${base}/jobs/${jobId}/cancel`, { method: 'POST', headers });
    assert.equal(stop.status, 200);
    await pool.query("UPDATE external_import_jobs SET status = 'cancelled' WHERE id = ?", [jobId]);
    const resume = await fetch(`${base}/jobs/${jobId}/resume`, { method: 'POST', headers });
    assert.equal(resume.status, 200);
    const hide = await fetch(`${base}/sources/${jobId}/hide`, { method: 'POST', headers });
    assert.equal(hide.status, 200);
    console.log('external import DB integration: 1300 photos, dedupe, album lock, sections passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (jobId) {
      await pool.query('DELETE FROM external_import_items WHERE job_id = ?', [jobId]);
      await pool.query('DELETE FROM external_import_jobs WHERE id = ?', [jobId]);
    }
    if (projectId) {
      await pool.query('DELETE FROM project_timeline_sections WHERE project_id = ?', [projectId]);
      await pool.query('DELETE FROM projects WHERE id = ?', [projectId]);
    }
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
