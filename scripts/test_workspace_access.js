const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!String(process.env.DB_NAME || '').endsWith('_workspace_test')) {
  throw new Error('Set DB_NAME to an isolated *_workspace_test database');
}
process.env.ORGANIZATION_UNITS_ACTIVE = '1';
process.env.UPLOAD_BASE_URL = 'https://mamage.test/api/image';
process.env.MEDIA_URL_SECRET = 'workspace-integration-test-secret';

const { pool } = require('../db');
const {
  resolveWorkspace, requireProjectAccess, requirePhotoAccess, requirePhotosAccess,
} = require('../lib/workspace_access');
const { buildMediaUrl, authorizeMediaKey } = require('../lib/media_access');

async function insert(conn, sql, params) {
  const [result] = await conn.query(sql, params);
  return result.insertId;
}

function request(user, unitId) {
  return { user, get(name) {
    return name.toLowerCase() === 'x-mamage-unit-id'
      ? (unitId === null ? 'legacy' : String(unitId)) : undefined;
  } };
}

async function denied(fn) {
  await assert.rejects(fn, (err) => err && err.status === 404);
}

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const orgId = await insert(conn,
      'INSERT INTO organizations (name, slug, code) VALUES (?, UUID(), UUID())', ['Workspace test']);
    const unitA = await insert(conn,
      'INSERT INTO organization_units (organization_id, slug, name) VALUES (?, ?, ?)',
      [orgId, 'a', 'A']);
    const unitB = await insert(conn,
      'INSERT INTO organization_units (organization_id, slug, name) VALUES (?, ?, ?)',
      [orgId, 'b', 'B']);
    const makeUser = async (role, activeUnitId) => insert(conn,
      'INSERT INTO users (student_no, name, role, organization_id, active_unit_id) VALUES (?, ?, ?, ?, ?)',
      [crypto.randomBytes(12).toString('hex'), role, role, orgId, activeUnitId]);
    const ownerId = await makeUser('photographer', unitA);
    const recipientId = await makeUser('photographer', unitB);
    const oldAdminId = await makeUser('admin', null);
    const collegeAdminId = await makeUser('superadmin', unitB);
    await conn.query('INSERT INTO organization_unit_memberships (unit_id, user_id, role) VALUES (?, ?, ?), (?, ?, ?)',
      [unitA, ownerId, 'manager', unitB, recipientId, 'member']);
    await conn.query('INSERT INTO organization_admin_grants (organization_id, user_id) VALUES (?, ?)',
      [orgId, collegeAdminId]);
    const makeProject = async (unitId, name) => insert(conn,
      'INSERT INTO projects (uuid, name, organization_id, unit_id) VALUES (UUID(), ?, ?, ?)',
      [name, orgId, unitId]);
    const projectA = await makeProject(unitA, 'A album');
    const projectB = await makeProject(unitB, 'B album');
    const legacyProject = await makeProject(null, 'Legacy album');
    const keyA = `uploads/units/${unitA}/photo-a.jpg`;
    const makePhoto = async (projectId, unitId, key) => insert(conn,
      `INSERT INTO photos (uuid, project_id, organization_id, unit_id, url, thumb_url)
       VALUES (UUID(), ?, ?, ?, ?, ?)`,
      [projectId, orgId, unitId, `/${key}`, `/${key}`]);
    const photoA = await makePhoto(projectA, unitA, keyA);
    const photoB = await makePhoto(projectB, unitB, `uploads/units/${unitB}/photo-b.jpg`);
    const legacyPhoto = await makePhoto(legacyProject, null, 'uploads/legacy.jpg');
    const owner = { id: ownerId, role: 'photographer', organization_id: orgId };
    const recipient = { id: recipientId, role: 'photographer', organization_id: orgId };
    const oldAdmin = { id: oldAdminId, role: 'admin', organization_id: orgId };
    const collegeAdmin = { id: collegeAdminId, role: 'superadmin', organization_id: orgId };

    assert.equal((await resolveWorkspace(request(owner, unitA), conn)).role, 'manager');
    assert.equal((await requireProjectAccess(request(owner, unitA), projectA, 'edit', conn)).id, projectA);
    await denied(() => requireProjectAccess(request(recipient, unitB), projectA, 'read', conn));
    await denied(() => requirePhotoAccess(request(recipient, unitB), photoA, 'read', conn));
    await denied(() => requirePhotosAccess(request(recipient, unitB), [photoA, photoB], 'read', conn));
    await denied(() => requireProjectAccess(request(oldAdmin, null), legacyProject, 'edit', conn));
    assert.equal((await requirePhotoAccess(request(oldAdmin, null), legacyPhoto, 'read', conn)).photo_id, legacyPhoto);
    assert.equal((await requirePhotoAccess(request(collegeAdmin, unitB), photoA, 'read', conn)).photo_id, photoA);

    const shareId = await insert(conn,
      `INSERT INTO internal_shares
       (organization_id, source_unit_id, target_unit_id, share_type, mode, project_id, created_by, expires_at)
       VALUES (?, ?, ?, 'album', 'read', ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY))`,
      [orgId, unitA, unitB, projectA, ownerId]);
    assert.equal((await requirePhotoAccess(request(recipient, unitB), photoA, 'read', conn)).photo_id, photoA);
    await denied(() => requirePhotoAccess(request(recipient, unitB), photoA, 'edit', conn));

    const link = buildMediaUrl(`/${keyA}`, { userId: recipientId, photoId: photoA });
    assert(link.startsWith(`https://mamage.test/api/image/${keyA}?`));
    const token = new URL(link).searchParams.get('ma');
    assert.equal(await authorizeMediaKey(keyA, token, conn), true);
    await conn.query('UPDATE internal_shares SET revoked_at = NOW() WHERE id = ?', [shareId]);
    assert.equal(await authorizeMediaKey(keyA, token, conn), false);
    await conn.query('UPDATE internal_shares SET revoked_at = NULL, mode = ? WHERE id = ?', ['collaborate', shareId]);
    assert.equal((await requirePhotoAccess(request(recipient, unitB), photoA, 'edit', conn)).photo_id, photoA);
    await conn.query('UPDATE internal_shares SET mode = ? WHERE id = ?', ['copy', shareId]);
    await denied(() => requirePhotoAccess(request(recipient, unitB), photoA, 'read', conn));
    assert.equal(await authorizeMediaKey(keyA, token, conn), false);
    await conn.query('UPDATE internal_shares SET mode = ? WHERE id = ?', ['collaborate', shareId]);
    await conn.query('UPDATE organization_unit_memberships SET removed_at = NOW() WHERE unit_id = ? AND user_id = ?',
      [unitB, recipientId]);
    assert.equal(await authorizeMediaKey(keyA, token, conn), false);
    console.log('workspace access integration: passed');
  } finally {
    await conn.rollback();
    conn.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
