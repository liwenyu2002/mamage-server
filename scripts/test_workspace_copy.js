const assert = require('node:assert/strict');
const crypto = require('node:crypto');

if (!String(process.env.DB_NAME || '').endsWith('_workspace_test')) {
  throw new Error('Set DB_NAME to an isolated *_workspace_test database');
}
process.env.ORGANIZATION_UNITS_ACTIVE = '1';

const { pool } = require('../db');
const storage = require('../lib/cos_storage');
const worker = require('../lib/organization_copy_worker');

async function main() {
  const suffix = crypto.randomBytes(10).toString('hex');
  const ids = {};
  const copiedKeys = [];
  let copyAttempts = 0;
  storage.headObject = async () => ({ ContentLength: 100 });
  storage.copyObject = async (source, destination) => {
    copyAttempts += 1;
    if (copyAttempts === 1) throw new Error('transient storage error');
    copiedKeys.push({ source, destination });
    return { key: destination, size: 100 };
  };
  storage.deleteObjects = async () => ({ deleted: [] });
  try {
    const [org] = await pool.query('INSERT INTO organizations (name, slug, code) VALUES (?, ?, ?)',
      ['Copy test', `copy-test-${suffix}`, `TEST-${suffix}`]);
    ids.org = org.insertId;
    const makeUser = async (name) => {
      const [result] = await pool.query(
        'INSERT INTO users (student_no, name, role, organization_id) VALUES (?, ?, ?, ?)',
        [`${name}-${suffix}`, name, 'photographer', ids.org]);
      return result.insertId;
    };
    ids.owner = await makeUser('owner');
    ids.recipient = await makeUser('recipient');
    const makeUnit = async (name) => {
      const [result] = await pool.query(
        'INSERT INTO organization_units (organization_id, slug, name) VALUES (?, ?, ?)',
        [ids.org, `${name}-${suffix}`, name]);
      return result.insertId;
    };
    ids.sourceUnit = await makeUnit('source');
    ids.targetUnit = await makeUnit('target');
    await pool.query('INSERT INTO organization_unit_memberships (unit_id, user_id, role) VALUES (?, ?, ?)',
      [ids.targetUnit, ids.recipient, 'member']);
    const [project] = await pool.query(
      'INSERT INTO projects (uuid, name, event_date, meta, organization_id, unit_id) VALUES (UUID(), ?, ?, ?, ?, ?)',
      ['Original album', '2026-09-27', JSON.stringify({ customMarker: 'kept',
        shareLineage: [{ shareId: 999, organizationName: 'Prior org', unitName: 'Prior unit' }] }),
      ids.org, ids.sourceUnit]);
    ids.sourceProject = project.insertId;
    const [photo] = await pool.query(
      `INSERT INTO photos
         (uuid, project_id, organization_id, unit_id, url, thumb_url, public_download_url,
          title, ai_started_at, ai_finished_at, capture_time)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ids.sourceProject, ids.org, ids.sourceUnit,
        `/uploads/units/${ids.sourceUnit}/original.jpg`,
        `/uploads/units/${ids.sourceUnit}/thumb.jpg`,
        `/uploads/units/${ids.sourceUnit}/public.jpg`, 'Test photo',
        '2026-09-22 10:30:18', '2026-09-22 10:30:41', '2026-09-21']);
    ids.sourcePhoto = photo.insertId;
    const [[sourcePhoto]] = await pool.query(
      'SELECT ph.*, p.name AS source_album_name FROM photos ph JOIN projects p ON p.id = ph.project_id WHERE ph.id = ?',
      [ids.sourcePhoto]
    );
    const [[sourceProject]] = await pool.query(
      'SELECT name, description, event_date, meta, tags, type FROM projects WHERE id = ?',
      [ids.sourceProject]
    );
    const [share] = await pool.query(
      `INSERT INTO internal_shares
         (organization_id, source_unit_id, target_unit_id, share_type, mode, project_id,
          created_by, expires_at, snapshot_json)
       VALUES (?, ?, ?, 'album', 'copy', ?, ?, DATE_ADD(NOW(), INTERVAL 1 DAY), ?)`,
      [ids.org, ids.sourceUnit, ids.targetUnit, ids.sourceProject, ids.owner,
        JSON.stringify({ project: sourceProject, sections: [] })]);
    ids.share = share.insertId;
    await pool.query('INSERT INTO internal_share_items (share_id, photo_id, snapshot_json) VALUES (?, ?, ?)',
      [ids.share, ids.sourcePhoto, JSON.stringify(sourcePhoto)]);
    await pool.query('UPDATE photos SET title = ? WHERE id = ?', ['Changed later', ids.sourcePhoto]);
    await pool.query('UPDATE projects SET name = ? WHERE id = ?', ['Changed album', ids.sourceProject]);
    const [job] = await pool.query(
      `INSERT INTO organization_copy_jobs
         (share_id, organization_id, target_unit_id, requested_by, system_initiated)
       VALUES (?, ?, ?, ?, 1)`, [ids.share, ids.org, ids.targetUnit, ids.owner]);
    ids.job = job.insertId;

    worker.wake();
    let row;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [rows] = await pool.query('SELECT * FROM organization_copy_jobs WHERE id = ?', [ids.job]);
      row = rows[0];
      if (row.status === 'ready' || row.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(row.status, 'ready', row.error_code || 'copy job timed out');
    const result = typeof row.result_json === 'string' ? JSON.parse(row.result_json) : row.result_json;
    ids.copiedProject = result.projectId;
    assert.equal(result.photoIds.length, 1);
    const [photos] = await pool.query(
      `SELECT *, DATE_FORMAT(ai_started_at, '%Y-%m-%d %H:%i:%s') AS started,
              DATE_FORMAT(ai_finished_at, '%Y-%m-%d %H:%i:%s') AS finished,
              DATE_FORMAT(capture_time, '%Y-%m-%d') AS captured
       FROM photos WHERE id = ?`, [result.photoIds[0]]);
    assert.equal(Number(photos[0].unit_id), ids.targetUnit);
    assert.equal(photos[0].title, 'Test photo');
    assert.equal(photos[0].started, '2026-09-22 10:30:18');
    assert.equal(photos[0].finished, '2026-09-22 10:30:41');
    assert.equal(photos[0].captured, '2026-09-21');
    const photoOrigin = typeof photos[0].source_attribution === 'string'
      ? JSON.parse(photos[0].source_attribution) : photos[0].source_attribution;
    assert.equal(photoOrigin.sourceOrganizationName, 'Copy test');
    assert.equal(photoOrigin.sourceUnitName, 'source');
    assert.equal(photoOrigin.shareId, ids.share);
    const [[copiedProject]] = await pool.query(
      `SELECT name, meta, DATE_FORMAT(event_date, '%Y-%m-%d') AS eventDate FROM projects WHERE id = ?`,
      [ids.copiedProject]);
    assert.equal(copiedProject.name, 'Original album（副本）');
    assert.equal(copiedProject.eventDate, '2026-09-27');
    const meta = typeof copiedProject.meta === 'string' ? JSON.parse(copiedProject.meta) : copiedProject.meta;
    assert.equal(meta.customMarker, 'kept');
    assert.equal(meta.shareLineage.length, 2);
    assert.equal(meta.shareLineage[0].organizationName, 'Prior org');
    assert.equal(meta.shareLineage[1].organizationName, 'Copy test');
    assert.equal(meta.shareLineage[1].unitName, 'source');
    assert.equal(meta.shareLineage[1].albumName, 'Original album');
    assert.equal(meta.shareLineage[1].shareId, ids.share);
    assert.notEqual(photos[0].url, `/uploads/units/${ids.sourceUnit}/original.jpg`);
    assert.equal(copiedKeys.length, 3);
    assert.equal(copyAttempts, 4);
    assert(copiedKeys.every((entry) => entry.destination.startsWith(`uploads/units/${ids.targetUnit}/copies/`)));
    console.log('workspace copy integration: passed');
  } finally {
    if (ids.copiedProject) {
      await pool.query('DELETE FROM photos WHERE project_id = ?', [ids.copiedProject]);
      await pool.query('DELETE FROM projects WHERE id = ?', [ids.copiedProject]);
    }
    if (ids.job) await pool.query('DELETE FROM organization_copy_jobs WHERE id = ?', [ids.job]);
    if (ids.share) await pool.query('DELETE FROM internal_share_items WHERE share_id = ?', [ids.share]);
    if (ids.share) await pool.query('DELETE FROM internal_shares WHERE id = ?', [ids.share]);
    if (ids.sourcePhoto) await pool.query('DELETE FROM photos WHERE id = ?', [ids.sourcePhoto]);
    if (ids.sourceProject) await pool.query('DELETE FROM projects WHERE id = ?', [ids.sourceProject]);
    if (ids.targetUnit) await pool.query('DELETE FROM organization_unit_memberships WHERE unit_id = ?', [ids.targetUnit]);
    if (ids.sourceUnit) await pool.query('DELETE FROM organization_units WHERE id = ?', [ids.sourceUnit]);
    if (ids.targetUnit) await pool.query('DELETE FROM organization_units WHERE id = ?', [ids.targetUnit]);
    if (ids.owner) await pool.query('DELETE FROM users WHERE id = ?', [ids.owner]);
    if (ids.recipient) await pool.query('DELETE FROM users WHERE id = ?', [ids.recipient]);
    if (ids.org) await pool.query('DELETE FROM organizations WHERE id = ?', [ids.org]);
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
