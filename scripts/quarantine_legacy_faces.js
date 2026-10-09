const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const { LEGACY_BLOCKED_STATUS, usableFaceSql } = require('../lib/face_result_policy');

// Only the deployed 2026-10-09 matcher writes clusterMatchMargin. Explicit human feedback is separate.
const LEGACY_PREDICATE = `JSON_EXTRACT(f.extra, '$.recognitionRevision') IS NULL
  AND JSON_EXTRACT(f.extra, '$.clusterMatchMargin') IS NULL
  AND ${usableFaceSql('f')}
  AND NOT EXISTS (SELECT 1 FROM face_identity_feedback reviewed
    WHERE reviewed.face_id = f.id AND reviewed.sample_kind IN ('explicit', 'group'))`;

async function quarantineLegacyFaces(pool, { apply = false, backupDir } = {}) {
  if (!apply) {
    const [[row]] = await pool.query(`SELECT COUNT(*) faces, COUNT(DISTINCT photo_id) photos
      FROM photo_faces f WHERE ${LEGACY_PREDICATE}`);
    return { dryRun: true, ...row };
  }
  const directory = backupDir || path.join(os.homedir(), '.mamage-maintenance',
    'face-quarantine-' + new Date().toISOString().replace(/[:.]/g, '-'));
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query(`SELECT f.id, f.photo_id, f.person_id, f.status, f.extra, f.updated_at
      FROM photo_faces f WHERE ${LEGACY_PREDICATE} ORDER BY f.id FOR UPDATE`);
    const at = new Date().toISOString();
    const snapshot = Buffer.from(JSON.stringify({ format: 'mamage-face-quarantine-v1', at, rows }));
    const filename = path.join(directory, 'before.json.gz');
    await fs.writeFile(filename, zlib.gzipSync(snapshot), { mode: 0o600, flag: 'wx' });
    const verified = zlib.gunzipSync(await fs.readFile(filename));
    if (!snapshot.equals(verified)) throw new Error('quarantine backup verification failed');
    let affectedRows = 0;
    for (let start = 0; start < rows.length; start += 500) {
      const ids = rows.slice(start, start + 500).map((row) => row.id);
      const [result] = await conn.query(`UPDATE photo_faces SET
        extra = JSON_SET(COALESCE(extra, JSON_OBJECT()), '$.legacyBlock',
          JSON_OBJECT('at', ?, 'previousStatus', status, 'previousPersonId', person_id)),
        status = ? WHERE id IN (?)`, [at, LEGACY_BLOCKED_STATUS, ids]);
      affectedRows += Number(result.affectedRows) || 0;
    }
    if (affectedRows !== rows.length) throw new Error('quarantine row count mismatch');
    await conn.commit();
    return { dryRun: false, blockedFaces: rows.length,
      blockedPhotos: new Set(rows.map((row) => Number(row.photo_id))).size,
      backup: filename, backupSha256: crypto.createHash('sha256').update(snapshot).digest('hex'), at };
  } catch (error) { await conn.rollback(); throw error; }
  finally { conn.release(); }
}

if (require.main === module) {
  process.env.NODE_ENV = 'production';
  const { pool } = require('../db');
  quarantineLegacyFaces(pool, { apply: process.argv.includes('--apply') })
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error(error.code || error.message); process.exitCode = 1; })
    .finally(() => pool.end());
}

module.exports = { quarantineLegacyFaces, LEGACY_PREDICATE };
