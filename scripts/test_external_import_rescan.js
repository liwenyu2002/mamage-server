const assert = require('node:assert/strict');
const path = require('path');
const root = path.resolve(__dirname, '..');
let scanStatus;
let status;
let fresh;
let queriesBeforeRefresh;
let failScan = false;

function mock(relative, exports) {
  const filename = require.resolve(path.join(root, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
mock('db', { pool: { query: async (sql) => {
  const s = sql.replace(/\s+/g, ' ');
  if (s.startsWith('SELECT organization_id, unit_id FROM projects')) return [[{ organization_id: 2, unit_id: 1 }]];
  if (s.includes("SET scan_status = 'running'")) { scanStatus = 'running'; return [{ affectedRows: 1 }]; }
  if (s.includes("SET scan_status = 'completed'")) { scanStatus = 'completed'; fresh = true; return [{ affectedRows: 1 }]; }
  if (s.includes("SET scan_status = 'failed'")) { scanStatus = 'failed'; return [{ affectedRows: 1 }]; }
  if (s.startsWith('SELECT status, cancel_requested, scan_status')) return [[{ status, cancel_requested: 0, scan_status: scanStatus }]];
  if (s.startsWith('SELECT * FROM external_import_items')) { if (!fresh) queriesBeforeRefresh++; return [[]]; }
  if (s.startsWith('SELECT SUM(status')) return [[{ pending: 0, failed: 0 }]];
  if (s.includes("SET status = 'completed_with_errors'")) { status = 'completed_with_errors'; return [{ affectedRows: 1 }]; }
  if (s.startsWith('UPDATE external_import_jobs SET status = ?')) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected SQL: ${s}`);
} } });
mock('routes/upload', {});
mock('lib/cos_storage', {});
mock('lib/external_import_jobs', { updateImportMetadata: async () => {}, ingestBatch: async () => {} });
mock('lib/external_gallery_alltuu', { parseAlltuuUrl: () => null });
mock('lib/external_gallery_templates', {});
mock('lib/external_gallery_scan', { scanPhotoPlus: async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  if (failScan) throw Object.assign(new Error('Access context lost'), { code: 'SOURCE_LINK_CONTEXT_LOST' });
  return { title: 'Original source', quality: 'original_view', reportedTotal: 4 };
} });
const { runJob } = require('../lib/external_import_worker');

async function main() {
  for (const failure of [false, true]) {
    failScan = failure;
    scanStatus = 'pending'; status = 'running'; fresh = false; queriesBeforeRefresh = 0;
    await runJob({ id: 6, provider: 'photoplus', project_id: 89, organization_id: 2,
      unit_id: 1, scan_status: 'pending', discovered_count: 4, selected_count: 4, scan_attempts: 1 });
    assert.equal(queriesBeforeRefresh, 0, 'resumed import must not select stale watermarked assets before source refresh');
    if (failure) assert.equal(status, 'completed_with_errors');
    else assert.equal(scanStatus, 'completed');
  }
  console.log('External import resume: stale assets are held until rescan succeeds; failed rescan cannot transfer them');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
