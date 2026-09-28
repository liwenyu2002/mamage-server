const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const { JWT_SECRET } = require('../config/keys');
const projectRoutes = require('../routes/projects');

async function main() {
  if (process.env.TEST_EXTERNAL_IMPORT_DB !== '1') throw new Error('Set TEST_EXTERNAL_IMPORT_DB=1 for the local DB integration test');
  const [users] = await pool.query(
    `SELECT u.id FROM users u
     JOIN role_permissions create_permission ON create_permission.role = u.role AND create_permission.permission = 'projects.create'
     JOIN role_permissions upload_permission ON upload_permission.role = u.role AND upload_permission.permission = 'upload.photo'
     WHERE u.organization_id IS NOT NULL LIMIT 1`
  );
  assert.ok(users.length, 'test user with create and upload permissions is required');
  const app = express();
  app.use(express.json());
  app.use('/api/projects', projectRoutes);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const name = `__external_import_create_test_${Date.now()}__`;
  const base = `http://127.0.0.1:${server.address().port}/api/projects`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt.sign({ id: users[0].id }, JWT_SECRET)}`,
  };
  let projectId;
  try {
    const invalid = await fetch(base, {
      method: 'POST', headers,
      body: JSON.stringify({ projectName: name, externalImportUrl: 'http://127.0.0.1/gallery' }),
    });
    assert.equal(invalid.status, 400);
    const [[notCreated]] = await pool.query('SELECT COUNT(*) AS count FROM projects WHERE name = ?', [name]);
    assert.equal(Number(notCreated.count), 0);

    const created = await fetch(base, {
      method: 'POST', headers,
      body: JSON.stringify({ projectName: name, externalImportUrl: 'https://gallery.example.com/event/123' }),
    });
    assert.equal(created.status, 200);
    const project = await created.json();
    projectId = Number(project.id);
    assert.ok(projectId > 0);
    assert.ok(Number(project.externalImportJobId) > 0);
    const [jobs] = await pool.query(
      'SELECT id, source_url AS sourceUrl, status FROM external_import_jobs WHERE project_id = ?', [projectId]
    );
    assert.equal(jobs.length, 1);
    assert.equal(Number(jobs[0].id), Number(project.externalImportJobId));
    assert.equal(jobs[0].sourceUrl, 'https://gallery.example.com/event/123');
    assert.equal(jobs[0].status, 'queued');
    console.log('create album with external import: invalid URL rejected, project and job created together');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (!projectId) {
      const [createdProjects] = await pool.query('SELECT id FROM projects WHERE name = ? LIMIT 1', [name]);
      projectId = Number(createdProjects[0]?.id) || null;
    }
    if (projectId) {
      await pool.query('DELETE FROM external_import_jobs WHERE project_id = ?', [projectId]);
      await pool.query('DELETE FROM projects WHERE id = ?', [projectId]);
    }
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
