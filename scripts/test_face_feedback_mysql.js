// Opt-in SQL integration test. All writes are isolated in connection-local temporary tables.
const assert = require('assert');
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const { pool } = require('../db');
const { recordIdentityFeedback, recordSeparation, remapMergedFeedback, loadFeedbackMemory,
  hasProtectedFaces } = require('../lib/face_feedback');

async function main() {
  if (!process.argv.includes('--temporary-db')) throw new Error('Pass --temporary-db to run isolated MySQL checks');
  const conn = await pool.getConnection();
  const tables = ['face_feedback_events', 'face_identity_feedback', 'face_person_separations'];
  const isolated = { query: (sql, params) => conn.query(
    sql.replace(/\b(face_feedback_events|face_identity_feedback|face_person_separations)\b/g, 'test_$1'), params
  ) };
  try {
    for (const table of tables) await conn.query(`CREATE TEMPORARY TABLE test_${table} LIKE ${table}`);
    await conn.beginTransaction();
    const face = { id: 500, photo_id: 200, organization_id: 2, person_id: 10,
      normalized_embedding: [1, 0], model_name: 'buffalo_l', bbox_x: 0.1, bbox_y: 0.1, bbox_w: 0.2, bbox_h: 0.2 };
    const record = (personId, kind) => recordIdentityFeedback(isolated, { orgId: 2, action: 'label',
      assignments: [{ face, personId, kind }] });
    await record(10, 'explicit');
    await record(10, 'group');
    let memory = await loadFeedbackMemory(isolated, 2, { modelName: 'buffalo_l' });
    assert.strictEqual(memory.references.get(10)[0].sample_kind, 'explicit', 'group update preserves explicit review');
    assert.strictEqual(await hasProtectedFaces(isolated, 200, 2), true);
    assert.strictEqual(await hasProtectedFaces(isolated, 200, 3), false);
    assert.strictEqual((await loadFeedbackMemory(isolated, 2, { photoIds: [201] })).references.size, 0);
    assert.strictEqual((await loadFeedbackMemory(isolated, 2, { exceptPhotoId: 200 })).references.size, 0);
    assert.strictEqual((await loadFeedbackMemory(isolated, 2, { modelName: 'different_model' })).references.size, 0);
    const eventId = await record(20, 'group');
    memory = await loadFeedbackMemory(isolated, 2);
    assert.strictEqual(memory.references.has(10), false);
    assert.strictEqual(memory.references.get(20)[0].sample_kind, 'group', 'different identity must not inherit explicit status');
    await recordSeparation(isolated, 2, 10, 20, eventId);
    await recordSeparation(isolated, 2, 20, 30, eventId);
    await remapMergedFeedback(isolated, 2, 10, [20]);
    memory = await loadFeedbackMemory(isolated, 2);
    assert.deepStrictEqual([...memory.references.keys()], [10]);
    assert.deepStrictEqual([...memory.separations], ['10:30']);
    await conn.rollback();
    const [[stats]] = await isolated.query('SELECT COUNT(*) AS count FROM face_feedback_events');
    assert.strictEqual(stats.count, 0, 'rollback must include both assignment memory and audit events');
    console.log('MySQL feedback checks passed; temporary tables only, transaction rolled back');
  } finally {
    for (const table of [...tables].reverse()) await conn.query(`DROP TEMPORARY TABLE IF EXISTS test_${table}`);
    conn.release();
    await pool.end();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
