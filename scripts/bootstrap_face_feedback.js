// Recover only verifiable historical corrections. Dry-run unless --apply is passed.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { pool } = require('../db');
const { recordIdentityFeedback, recordSeparation } = require('../lib/face_feedback');

async function main() {
  const apply = process.argv.includes('--apply');
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [faces] = await conn.query(`
      SELECT f.*, old.id AS original_person_id
      FROM photo_faces f
      JOIN face_persons fp ON fp.id = f.person_id AND fp.organization_id = f.organization_id
      LEFT JOIN face_persons old ON old.id = JSON_EXTRACT(f.extra, '$.splitFromPersonId')
        AND old.organization_id = f.organization_id
      LEFT JOIN face_identity_feedback feedback ON feedback.face_id = f.id
      WHERE JSON_EXTRACT(f.extra, '$.splitToPersonId') = f.person_id
        AND feedback.id IS NULL
        AND NOT EXISTS (SELECT 1 FROM face_feedback_events e WHERE e.operation_key = CONCAT('legacy-split-face:', f.id))
      ORDER BY f.id FOR UPDATE`);
    const [merges] = await conn.query(`
      SELECT p.id, p.organization_id, p.note FROM face_persons p
      WHERE p.note LIKE '%merged from:%'
      AND NOT EXISTS (SELECT 1 FROM face_feedback_events e
        WHERE e.operation_key = CONCAT('legacy-merge-person:', p.id))`);
    const stats = { apply, splitSamples: faces.length, mergeAuditRecords: merges.length, preservedAssignments: true };
    if (apply) {
      for (const face of faces) {
        const eventId = await recordIdentityFeedback(conn, {
          orgId: face.organization_id, action: 'legacy_split', operationKey: `legacy-split-face:${face.id}`,
          details: { recovered: true, originalPersonId: face.original_person_id },
          assignments: [{ face, personId: face.person_id, kind: 'legacy' }],
        });
        if (face.original_person_id) await recordSeparation(conn, face.organization_id,
          face.original_person_id, face.person_id, eventId);
      }
      for (const person of merges) {
        // Old merge notes cannot tell us which individual faces were actually reviewed.
        await recordIdentityFeedback(conn, {
          orgId: person.organization_id, action: 'legacy_merge', operationKey: `legacy-merge-person:${person.id}`,
          details: { personId: person.id, note: person.note, recovered: true, samplesRecoverable: false },
        });
      }
      await conn.commit();
    } else await conn.rollback();
    console.log(JSON.stringify(stats));
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
