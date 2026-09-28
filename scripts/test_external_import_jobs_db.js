const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { JWT_SECRET } = require('../config/keys');
const { createJob, ingestBatch, updateImportMetadata } = require('../lib/external_import_jobs');
const externalImportRoutes = require('../routes/external_imports');

async function main() {
  if (process.env.TEST_EXTERNAL_IMPORT_DB !== '1') throw new Error('Set TEST_EXTERNAL_IMPORT_DB=1 for the local DB integration test');
  const [users] = await pool.query('SELECT id, role, organization_id FROM users WHERE organization_id IS NOT NULL ORDER BY id LIMIT 1');
  assert.ok(users.length, 'test organization user is required');
  const user = users[0];
  let projectId;
  let jobId;
  let singleProjectId;
  let singleJobId;
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
      await ingestBatch(job, photos.slice(index, index + 100), {
        title: '测试活动', reportedTotal: 1300, sourceSections: ['开幕', '闭幕'],
      });
    }
    assert.equal(await ingestBatch(job, photos.slice(0, 100), {
      title: '测试活动', reportedTotal: 1300, sourceSections: ['开幕', '闭幕'],
    }), 0);
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
    await updateImportMetadata({ id: jobId, project_id: projectId }, {
      title: '来源相册标题', reportedTotal: 1300, suggestedSections: ['开幕', '闭幕'],
    });
    const [[existingProject]] = await pool.query('SELECT name FROM projects WHERE id = ?', [projectId]);
    assert.equal(existingProject.name, '__external_import_test__', 'importing into an existing album must keep its title');
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

    const [singleCreated] = await pool.query(
      "INSERT INTO projects (uuid, name, organization_id, meta) VALUES (UUID(), '__single_source_test__', ?, JSON_OBJECT('timelineEnabled', false, '_pendingExternalImportTitle', '__single_source_test__'))",
      [user.organization_id]
    );
    singleProjectId = singleCreated.insertId;
    singleJobId = (await createJob(req, singleProjectId, 'https://gallery.example.com/single')).jobId;
    await pool.query("UPDATE external_import_jobs SET status = 'running' WHERE id = ?", [singleJobId]);
    await updateImportMetadata({ id: singleJobId, project_id: singleProjectId }, {
      title: '来源相册', reportedTotal: 1, suggestedSections: ['图片直播'],
    });
    await ingestBatch({ id: singleJobId, project_id: singleProjectId }, [{
      id: 'only-photo', filename: 'photo.jpg', sectionName: '图片直播',
      transferUrl: 'https://gallery.example.com/original/photo.jpg',
      previewUrl: 'https://gallery.example.com/thumb/photo.jpg',
    }], { title: '来源相册', reportedTotal: 1, sourceSections: ['图片直播'] });
    const [singleSections] = await pool.query('SELECT id FROM project_timeline_sections WHERE project_id = ?', [singleProjectId]);
    assert.equal(singleSections.length, 0, 'one source section must not become a timeline');
    const [[singleItem]] = await pool.query('SELECT timeline_section_id AS sectionId FROM external_import_items WHERE job_id = ?', [singleJobId]);
    assert.equal(singleItem.sectionId, null);
    const [[singleProject]] = await pool.query('SELECT name, meta FROM projects WHERE id = ?', [singleProjectId]);
    const singleMeta = typeof singleProject.meta === 'string' ? JSON.parse(singleProject.meta) : singleProject.meta;
    assert.equal(singleProject.name, '来源相册');
    assert.equal(singleMeta.timelineEnabled, false);
    assert.equal(singleMeta._pendingExternalImportTitle, undefined);
    await pool.query(
      "UPDATE projects SET name = '手动标题', meta = JSON_SET(meta, '$._pendingExternalImportTitle', '旧标题') WHERE id = ?",
      [singleProjectId]
    );
    await updateImportMetadata({ id: singleJobId, project_id: singleProjectId }, {
      title: '另一个来源标题', reportedTotal: 1, suggestedSections: [],
    });
    const [[renamedProject]] = await pool.query('SELECT name, meta FROM projects WHERE id = ?', [singleProjectId]);
    assert.equal(renamedProject.name, '手动标题', 'a user rename during scanning must win');
    const renamedMeta = typeof renamedProject.meta === 'string' ? JSON.parse(renamedProject.meta) : renamedProject.meta;
    assert.equal(renamedMeta._pendingExternalImportTitle, undefined);
    console.log('external import DB integration: 1300 photos, dedupe, album lock, sections passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (singleJobId) {
      await pool.query('DELETE FROM external_import_items WHERE job_id = ?', [singleJobId]);
      await pool.query('DELETE FROM external_import_jobs WHERE id = ?', [singleJobId]);
    }
    if (singleProjectId) {
      await pool.query('DELETE FROM project_timeline_sections WHERE project_id = ?', [singleProjectId]);
      await pool.query('DELETE FROM projects WHERE id = ?', [singleProjectId]);
    }
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
