// Build missing public-download JPEG renditions for existing image records.
// Usage:
//   node scripts/backfill_public_download_variants.js
//   node scripts/backfill_public_download_variants.js --limit 50 --dry-run
try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const path = require('path');
const { pool } = require('../db');
const cosStorage = require('../lib/cos_storage');
const { createPublicDownloadBuffer, readStreamToBuffer, DEFAULT_MAX_BYTES } = require('../lib/public_download_variant');

const MB = 1024 * 1024;
const args = process.argv.slice(2);
const argValue = (name, fallback = '') => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};
const limit = Math.max(0, Number(argValue('--limit', '0')) || 0);
const dryRun = args.includes('--dry-run');
const maxBytes = Math.max(256 * 1024, Number(argValue('--max-bytes', process.env.PUBLIC_DOWNLOAD_MAX_BYTES || DEFAULT_MAX_BYTES)) || DEFAULT_MAX_BYTES);
const sourceMaxBytes = Math.max(maxBytes, Number(process.env.PUBLIC_DOWNLOAD_SOURCE_MAX_BYTES || 128 * MB) || 128 * MB);

function buildPublicKey(originalKey) {
  const normalized = cosStorage.normalizeKey(originalKey);
  const ext = path.posix.extname(normalized);
  const stem = path.posix.basename(normalized, ext);
  return `${path.posix.dirname(normalized)}/public/public_${stem}.jpg`;
}

async function runOne(row) {
  const sourceKey = cosStorage.keyFromUrlOrPath(row.url);
  if (!sourceKey) throw new Error('ORIGINAL_KEY_MISSING');
  const publicKey = buildPublicKey(sourceKey);
  const publicRel = `/${publicKey}`;
  if (dryRun) return { id: row.id, sourceKey, publicRel, dryRun: true };

  const source = await cosStorage.getObject(sourceKey);
  const original = await readStreamToBuffer(source && source.Body, { maxBytes: sourceMaxBytes });
  const output = await createPublicDownloadBuffer(original, { maxBytes });
  await cosStorage.uploadBuffer(publicKey, output.buffer, {
    contentType: 'image/jpeg',
    cacheControl: process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable',
  });
  const [updated] = await pool.query(
    "UPDATE photos SET public_download_url = ? WHERE id = ? AND (public_download_url IS NULL OR public_download_url = '')",
    [publicRel, row.id]
  );
  return { id: row.id, sourceKey, publicRel, bytes: output.bytes, quality: output.quality, updated: updated.affectedRows > 0 };
}

async function main() {
  if (!cosStorage.isConfigured()) throw new Error('OBJECT_STORAGE_NOT_CONFIGURED');
  const clauses = ["(public_download_url IS NULL OR public_download_url = '')", "(type IS NULL OR type <> 'video')"];
  const sql = `SELECT id, url FROM photos WHERE ${clauses.join(' AND ')} ORDER BY id ASC${limit ? ' LIMIT ?' : ''}`;
  const [rows] = await pool.query(sql, limit ? [limit] : []);
  console.log(`[public-download-backfill] candidates=${rows.length} target=${(maxBytes / MB).toFixed(2)}MB dryRun=${dryRun}`);

  let succeeded = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      const result = await runOne(row);
      succeeded += 1;
      console.log(`[public-download-backfill] photo=${result.id} ${result.dryRun ? result.publicRel : `${(result.bytes / MB).toFixed(2)}MB q=${result.quality} updated=${result.updated}`}`);
    } catch (err) {
      failed += 1;
      console.error(`[public-download-backfill] photo=${row.id} failed:`, err && err.message ? err.message : err);
    }
  }
  console.log(`[public-download-backfill] complete succeeded=${succeeded} failed=${failed}`);
  if (failed) process.exitCode = 1;
}

main()
  .catch((err) => { console.error('[public-download-backfill] fatal:', err && err.stack ? err.stack : err); process.exitCode = 1; })
  .finally(async () => { try { await pool.end(); } catch (e) {} });
