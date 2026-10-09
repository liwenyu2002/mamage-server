const assert = require('assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { quarantineLegacyFaces, LEGACY_PREDICATE } = require('./quarantine_legacy_faces');

async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'face-quarantine-test-'));
  const rows = [{ id: 13280, photo_id: 6298, person_id: 526, status: 'confirmed', extra: { old: true } }];
  const writes = [];
  let commits = 0, rollbacks = 0;
  const pool = {
    query: async () => [[{ faces: 1, photos: 1 }]],
    getConnection: async () => ({
      beginTransaction: async () => {}, release: () => {},
      commit: async () => { commits++; }, rollback: async () => { rollbacks++; },
      query: async (sql, params) => {
        if (sql.startsWith('SELECT')) return [rows];
        writes.push({ sql, params });
        return [{ affectedRows: 1 }];
      },
    }),
  };
  try {
    assert(LEGACY_PREDICATE.includes("'$.clusterMatchMargin'"));
    assert(LEGACY_PREDICATE.includes("sample_kind IN ('explicit', 'group')"));
    assert.deepEqual(await quarantineLegacyFaces(pool), { dryRun: true, faces: 1, photos: 1 });
    assert.equal(writes.length, 0);
    const result = await quarantineLegacyFaces(pool, { apply: true, backupDir: path.join(directory, 'success') });
    const saved = JSON.parse(zlib.gunzipSync(await fs.readFile(result.backup)));
    assert.deepEqual(saved.rows, rows, 'original status, person and metadata must be recoverable');
    assert.equal((await fs.stat(result.backup)).mode & 0o777, 0o600);
    assert.equal(writes[0].params[1], 'legacy_blocked');
    assert.deepEqual(writes[0].params[2], [13280]);
    assert.equal(result.blockedFaces, 1);
    assert.equal(commits, 1);
    await assert.rejects(quarantineLegacyFaces(pool, { apply: true, backupDir: path.join(directory, 'success') }),
      (error) => error.code === 'EEXIST');
    assert.equal(rollbacks, 1);
    assert.equal(writes.length, 1, 'failed backup must prevent every data mutation');
    console.log('face quarantine: dry run, verified private backup, transaction and backup-failure protection passed');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
