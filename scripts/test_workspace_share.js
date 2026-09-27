const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');

if (!String(process.env.DB_NAME || '').endsWith('_workspace_test')) {
  throw new Error('Set DB_NAME to an isolated *_workspace_test database');
}
process.env.ORGANIZATION_UNITS_ACTIVE = '1';
process.env.UPLOAD_BASE_URL = 'https://mamage.test/api/image';
process.env.MEDIA_URL_SECRET = 'workspace-integration-test-secret';

const { pool } = require('../db');
const { JWT_SECRET } = require('../config/keys');
const shareRouter = require('../routes/share');

async function main() {
  const suffix = crypto.randomBytes(10).toString('hex');
  const ids = {};
  let server;
  try {
    const [permission] = await pool.query(
      'INSERT INTO role_permissions (role, permission) VALUES (?, ?)', ['photographer', 'photos.view']);
    ids.permission = permission.insertId;
    const [org] = await pool.query('INSERT INTO organizations (name, slug, code) VALUES (?, ?, ?)',
      ['Share test', `share-test-${suffix}`, `TEST-${suffix}`]);
    ids.org = org.insertId;
    const [user] = await pool.query(
      'INSERT INTO users (student_no, name, role, organization_id) VALUES (?, ?, ?, ?)',
      [`WS-${suffix}`, 'Share test', 'photographer', ids.org]);
    ids.user = user.insertId;
    const [unit] = await pool.query(
      'INSERT INTO organization_units (organization_id, slug, name) VALUES (?, ?, ?)',
      [ids.org, `unit-${suffix}`, 'Share unit']);
    ids.unit = unit.insertId;
    await pool.query('UPDATE users SET active_unit_id = ? WHERE id = ?', [ids.unit, ids.user]);
    await pool.query('INSERT INTO organization_unit_memberships (unit_id, user_id, role) VALUES (?, ?, ?)',
      [ids.unit, ids.user, 'manager']);
    const [project] = await pool.query(
      'INSERT INTO projects (uuid, name, organization_id, unit_id) VALUES (UUID(), ?, ?, ?)',
      ['Shared album', ids.org, ids.unit]);
    ids.project = project.insertId;
    const makePhoto = async (name) => {
      const [photo] = await pool.query(
        `INSERT INTO photos
           (uuid, project_id, organization_id, unit_id, url, thumb_url, public_download_url)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?)`,
        [ids.project, ids.org, ids.unit, `/uploads/units/${ids.unit}/${name}-original.jpg`,
          `/uploads/units/${ids.unit}/${name}-thumb.jpg`,
          `/uploads/units/${ids.unit}/${name}-public.jpg`]);
      return photo.insertId;
    };
    ids.approved = await makePhoto('approved');
    ids.pending = await makePhoto('pending');
    const [share] = await pool.query(
      `INSERT INTO share_links
         (code, share_type, project_id, created_by, organization_id, unit_id, sync_mode, expires_at)
       VALUES (?, 'project', ?, ?, ?, ?, 'approval', DATE_ADD(NOW(), INTERVAL 1 DAY))`,
      [`share-${suffix}`, ids.project, ids.user, ids.org, ids.unit]);
    ids.share = share.insertId;
    await pool.query('INSERT INTO share_link_items (share_id, photo_id, sort_order) VALUES (?, ?, 0)',
      [ids.share, ids.approved]);

    const app = express();
    app.use(express.json());
    app.use('/api/share', shareRouter);
    server = await new Promise((resolve) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/share/share-${suffix}`);
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.photos.map((photo) => photo.id), [ids.approved]);
    assert(body.photos[0].url.includes('approved-public.jpg'));
    assert(!body.photos[0].url.includes('approved-original.jpg'));
    assert(body.photos[0].url.includes('ma='));
    const base = `http://127.0.0.1:${server.address().port}/api/share`;
    const headers = { Authorization: `Bearer ${jwt.sign({ id: ids.user }, JWT_SECRET, { expiresIn: '5m' })}`,
      'Content-Type': 'application/json' };
    const mine = await fetch(`${base}/mine`, { headers });
    assert.equal(mine.status, 200);
    assert.equal((await mine.json())[0].pendingCount, 1);
    const pending = await fetch(`${base}/share-${suffix}/pending`, { headers });
    assert.equal(pending.status, 200);
    assert.deepEqual((await pending.json()).photos.map((photo) => photo.id), [ids.pending]);
    const approved = await fetch(`${base}/share-${suffix}/approve`, { method: 'POST', headers,
      body: JSON.stringify({ photoIds: [ids.pending] }) });
    assert.equal(approved.status, 200);
    const updated = await fetch(`${base}/share-${suffix}`);
    assert.deepEqual((await updated.json()).photos.map((photo) => photo.id).sort((a, b) => a - b),
      [ids.approved, ids.pending]);
    const created = await fetch(base, { method: 'POST', headers,
      body: JSON.stringify({ shareType: 'project', projectId: ids.project }) });
    assert.equal(created.status, 200);
    const createdBody = await created.json();
    ids.secondCode = createdBody.code;
    assert.equal(createdBody.syncMode, 'approval');
    assert(new Date(createdBody.expiresAt).getTime() > Date.now() + 29 * 86400000);
    const revokedResponse = await fetch(`${base}/share-${suffix}/revoke`, { method: 'POST', headers });
    assert.equal(revokedResponse.status, 200);
    const revoked = await fetch(`http://127.0.0.1:${server.address().port}/api/share/share-${suffix}`);
    assert.equal(revoked.status, 410);
    console.log('workspace public share integration: passed');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (ids.secondCode) {
      const [links] = await pool.query('SELECT id FROM share_links WHERE code = ?', [ids.secondCode]);
      if (links.length) {
        await pool.query('DELETE FROM share_link_items WHERE share_id = ?', [links[0].id]);
        await pool.query('DELETE FROM share_links WHERE id = ?', [links[0].id]);
      }
    }
    if (ids.share) await pool.query('DELETE FROM share_link_items WHERE share_id = ?', [ids.share]);
    if (ids.share) await pool.query('DELETE FROM share_links WHERE id = ?', [ids.share]);
    if (ids.project) await pool.query('DELETE FROM photos WHERE project_id = ?', [ids.project]);
    if (ids.project) await pool.query('DELETE FROM projects WHERE id = ?', [ids.project]);
    if (ids.unit) await pool.query('DELETE FROM organization_unit_memberships WHERE unit_id = ?', [ids.unit]);
    if (ids.unit) await pool.query('DELETE FROM organization_units WHERE id = ?', [ids.unit]);
    if (ids.user) await pool.query('DELETE FROM users WHERE id = ?', [ids.user]);
    if (ids.org) await pool.query('DELETE FROM organizations WHERE id = ?', [ids.org]);
    if (ids.permission) await pool.query('DELETE FROM role_permissions WHERE id = ?', [ids.permission]);
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
