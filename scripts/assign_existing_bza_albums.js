const fs = require('fs');
const { pool } = require('../db');
const keys = require('../config/keys');

const APPLY = process.argv.includes('--apply');
const BACKUP = '/Users/liwenyu/mamage-backups/mamage-20260927-before-album-assignment.sql.gz';
const EXPECTED_ALBUM_IDS = [30, 34, 35, 36, 41, 62, 63, 67, 68, 69, 70, 71, 73, 75, 76, 77, 78];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function prepare(conn) {
  const [[organization]] = await conn.query(
    'SELECT id FROM organizations WHERE code = ? LIMIT 1', ['BZA2024']
  );
  assert(organization && organization.id === 2, 'BZA organization changed');
  const [[unit]] = await conn.query(
    'SELECT id FROM organization_units WHERE organization_id = ? AND slug = ? AND archived_at IS NULL LIMIT 1',
    [organization.id, 'student-media']
  );
  assert(unit && unit.id === 1, 'Student-media unit changed');

  const [albums] = await conn.query(
    `SELECT id, unit_id, restricted_to_user_id FROM projects
     WHERE organization_id = ? ORDER BY id${APPLY ? ' FOR UPDATE' : ''}`, [organization.id]
  );
  assert(JSON.stringify(albums.map((album) => album.id)) === JSON.stringify(EXPECTED_ALBUM_IDS),
    'Album roster changed; review before assigning');
  assert(albums.every((album) => album.unit_id === null && album.restricted_to_user_id === null),
    'Some albums are already assigned or restricted');

  const [media] = await conn.query(
    `SELECT id, project_id, unit_id, type FROM photos
     WHERE organization_id = ?${APPLY ? ' FOR UPDATE' : ''}`, [organization.id]
  );
  const albumIds = new Set(EXPECTED_ALBUM_IDS);
  assert(media.length === 589 && media.filter((item) => item.type === 'video').length === 45,
    'Media roster changed; review before assigning');
  assert(media.every((item) => item.unit_id === null && albumIds.has(item.project_id)),
    'Some media is already assigned or belongs to another album');

  const [photoFavorites] = await conn.query(
    `SELECT f.id, f.user_id, f.ref_key FROM user_favorites f
     JOIN users u ON u.id = f.user_id
     WHERE u.organization_id = ? AND f.kind = 'photo' AND f.unit_id IS NULL
     ${APPLY ? 'FOR UPDATE' : ''}`, [organization.id]
  );
  const mediaIds = new Set(media.map((item) => item.id));
  assert(photoFavorites.length === 1 && photoFavorites[0].id === 3
    && mediaIds.has(Number(photoFavorites[0].ref_key)),
  'Photo favorites changed; review before assigning');
  const [[favoriteCollision]] = await conn.query(
    `SELECT COUNT(*) AS count FROM user_favorites
     WHERE user_id = ? AND unit_id = ? AND kind = 'photo' AND ref_key = ?`,
    [photoFavorites[0].user_id, unit.id, photoFavorites[0].ref_key]
  );
  assert(Number(favoriteCollision.count) === 0, 'Photo favorite already exists in target unit');

  const [[links]] = await conn.query('SELECT COUNT(*) AS count FROM share_links WHERE organization_id = ?',
    [organization.id]);
  const [[shares]] = await conn.query('SELECT COUNT(*) AS count FROM internal_shares WHERE organization_id = ?',
    [organization.id]);
  assert(Number(links.count) === 0 && Number(shares.count) === 0,
    'Album shares changed; review before assigning');

  return { orgId: organization.id, unitId: unit.id, albumIds: [...albumIds],
    mediaIds: media.map((item) => item.id), favoriteId: photoFavorites[0].id,
    albums: albums.length, media: media.length, videos: 45 };
}

async function assign(conn, plan) {
  const [albums] = await conn.query(
    'UPDATE projects SET unit_id = ?, updated_at = updated_at WHERE organization_id = ? AND id IN (?) AND unit_id IS NULL',
    [plan.unitId, plan.orgId, plan.albumIds]
  );
  assert(albums.affectedRows === plan.albums, 'Album update count changed');
  const [media] = await conn.query(
    'UPDATE photos SET unit_id = ?, updated_at = updated_at WHERE organization_id = ? AND id IN (?) AND unit_id IS NULL',
    [plan.unitId, plan.orgId, plan.mediaIds]
  );
  assert(media.affectedRows === plan.media, 'Media update count changed');
  const [favorite] = await conn.query(
    'UPDATE user_favorites SET unit_id = ? WHERE id = ? AND unit_id IS NULL',
    [plan.unitId, plan.favoriteId]
  );
  assert(favorite.affectedRows === 1, 'Photo favorite update count changed');
  await conn.query(
    `INSERT INTO organization_access_audit
       (organization_id, unit_id, user_id, action, resource_type, details)
     VALUES (?, ?, 47, 'albums.bulk-assign', 'project', ?)`,
    [plan.orgId, plan.unitId, JSON.stringify({ albums: plan.albums, media: plan.media,
      videos: plan.videos, photoFavorites: 1 })]
  );
}

async function main() {
  if (APPLY) {
    assert(keys.DB_NAME === 'mamage', 'Production database required');
    assert(process.env.BZA_ALBUM_ASSIGN_CONFIRM === 'ASSIGN_17_ALBUMS_TO_STUDENT_MEDIA',
      'Missing assignment confirmation');
    assert(fs.statSync(BACKUP).size > 1024 * 1024, 'Verified database backup is missing');
  }
  const conn = await pool.getConnection();
  try {
    if (APPLY) await conn.beginTransaction();
    const plan = await prepare(conn);
    console.log(JSON.stringify({ apply: APPLY, targetUnitId: plan.unitId,
      albums: plan.albums, media: plan.media, videos: plan.videos, photoFavorites: 1 }));
    if (!APPLY) return;
    await assign(conn, plan);
    await conn.commit();
    console.log('BZA albums assigned to student-media');
  } catch (error) {
    if (APPLY) await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
