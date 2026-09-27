const { Transform } = require('stream');
const sharp = require('sharp');
const { pool } = require('../db');
const storage = require('./cos_storage');
const upload = require('../routes/upload');
const { normalizePhotoPlusAsset } = require('./external_gallery_scan');
const { parsePublicHttpsUrl, openPublicHttps } = require('./public_remote_fetch');

const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 120000;
let started = false;
let pumping = false;

function failureCode(err) {
  const code = String(err?.code || '');
  if (['SOURCE_EXPIRED', 'SOURCE_MISSING', 'SOURCE_RATE_LIMIT', 'SOURCE_TOO_LARGE', 'SOURCE_NOT_IMAGE', 'INVALID_SOURCE_URL', 'SOURCE_REDIRECT', 'INVALID_IMAGE', 'PROJECT_CHANGED'].includes(code)) return code;
  return 'TRANSFER_FAILED';
}

async function transferImage(url, key) {
  const safeUrl = parsePublicHttpsUrl(url);
  if (!safeUrl) throw Object.assign(new Error('Invalid source URL'), { code: 'INVALID_SOURCE_URL' });
  const { response } = await openPublicHttps(safeUrl.href, { accept: 'image/jpeg,image/png,image/webp', timeoutMs: SOURCE_TIMEOUT_MS });
  try {
    if (response.statusCode === 403) throw Object.assign(new Error('Source expired'), { code: 'SOURCE_EXPIRED' });
    if (response.statusCode === 404) throw Object.assign(new Error('Source missing'), { code: 'SOURCE_MISSING' });
    if (response.statusCode === 429) throw Object.assign(new Error('Source rate limited'), { code: 'SOURCE_RATE_LIMIT' });
    if (response.statusCode !== 200) throw new Error(`Source HTTP ${response.statusCode}`);
    const type = String(response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw Object.assign(new Error('Source is not a supported image'), { code: 'SOURCE_NOT_IMAGE' });
    const length = Number(response.headers['content-length']);
    if (length > MAX_SOURCE_BYTES) throw Object.assign(new Error('Source too large'), { code: 'SOURCE_TOO_LARGE' });
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > MAX_SOURCE_BYTES) callback(Object.assign(new Error('Source too large'), { code: 'SOURCE_TOO_LARGE' }));
        else callback(null, chunk);
      },
    });
    response.on('error', (err) => limiter.destroy(err));
    response.pipe(limiter);
    await storage.uploadStream(key, limiter, { contentType: type, cacheControl: 'public, max-age=31536000, immutable', queueSize: 1 });
    return { bytes: received, type };
  } finally {
    response.destroy();
  }
}

async function importItem(job, item) {
  if (job.provider === 'photoplus' && !normalizePhotoPlusAsset(item.asset_url)) {
    throw Object.assign(new Error('Invalid PhotoPlus asset'), { code: 'INVALID_SOURCE_URL' });
  }
  const [oldCopies] = await pool.query(
    `SELECT i.photo_id AS photoId FROM external_import_items i
     JOIN external_import_jobs j ON j.id = i.job_id
     JOIN photos ph ON ph.id = i.photo_id
     WHERE j.project_id = ? AND i.provider_photo_id = ? AND i.status = 'done'
       AND i.photo_id IS NOT NULL AND i.id <> ? LIMIT 1`,
    [job.project_id, item.provider_photo_id, item.id]
  );
  if (oldCopies.length) {
    await pool.query("UPDATE external_import_items SET status = 'skipped', photo_id = ? WHERE id = ?", [oldCopies[0].photoId, item.id]);
    return;
  }

  if (item.object_key) {
    const [existing] = await pool.query('SELECT id FROM photos WHERE url = ? LIMIT 1', [`/${item.object_key}`]);
    if (existing.length) {
      await pool.query("UPDATE external_import_items SET status = 'done', photo_id = ?, error_code = NULL WHERE id = ?", [existing[0].id, item.id]);
      upload.enqueuePostUploadJobs({ insertedId: existing[0].id, thumbRel: `/${item.thumb_key}`, thumbBuffer: null, photographerId: job.requested_by });
      return;
    }
  }

  const keys = item.object_key
    ? {
      originalKey: item.object_key,
      thumbKey: item.thumb_key,
      publicDownloadKey: storage.normalizeKey(item.object_key).replace(/\/([^/]+)\.([^/.]+)$/, '/public/public_$1.jpg'),
      publicDownloadRel: `/${storage.normalizeKey(item.object_key).replace(/\/([^/]+)\.([^/.]+)$/, '/public/public_$1.jpg')}`,
    }
    : upload.buildObjectKeys(job.project_id, item.filename, 'image/jpeg', 'image', job.unit_id);
  if (!item.object_key) {
    await pool.query('UPDATE external_import_items SET object_key = ?, thumb_key = ? WHERE id = ?', [keys.originalKey, keys.thumbKey, item.id]);
  }
  let insertedId = null;
  try {
    await transferImage(item.asset_url, keys.originalKey);
    const source = await storage.getObject(keys.originalKey);
    let thumb;
    try {
      const converter = sharp({ failOn: 'none' })
        .rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80, mozjpeg: true });
      source.Body.on('error', (err) => converter.destroy(err));
      source.Body.pipe(converter);
      thumb = await converter.toBuffer();
    } catch (_) {
      throw Object.assign(new Error('Invalid image'), { code: 'INVALID_IMAGE' });
    }
    await storage.uploadBuffer(keys.thumbKey, thumb, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
    insertedId = await upload.createPhotoRecordWithRetry({
      projectId: job.project_id,
      timelineSectionId: item.timeline_section_id || job.timeline_section_id,
      title: item.filename,
      description: null,
      tags: [],
      aiStatus: 'pending',
      type: 'normal',
      photographerId: job.requested_by,
      orgId: job.organization_id,
      relPath: `/${keys.originalKey}`,
      thumbRel: `/${keys.thumbKey}`,
    });
    await pool.query('UPDATE photos SET source_attribution = ? WHERE id = ?', [JSON.stringify({
      type: 'external_import',
      provider: job.provider,
      sourceAlbumUrl: job.source_url,
      sourceAlbumTitle: job.source_title,
      sourcePhotoId: item.provider_photo_id,
      sourceSectionName: item.source_section_name || null,
      importJobId: job.id,
      importItemId: item.id,
      quality: job.source_quality,
      importedAt: new Date().toISOString(),
    }), insertedId]);
    await pool.query("UPDATE external_import_items SET status = 'done', photo_id = ?, error_code = NULL WHERE id = ?", [insertedId, item.id]);
    upload.enqueuePostUploadJobs({ insertedId, thumbRel: `/${keys.thumbKey}`, thumbBuffer: thumb, photographerId: job.requested_by });
    if (keys.publicDownloadKey) upload.enqueuePublicDownloadDerivative({
      insertedId, sourceKey: keys.originalKey,
      publicDownloadKey: keys.publicDownloadKey,
      publicDownloadRel: keys.publicDownloadRel,
    });
    setImmediate(() => upload.appendPhotoIdToProjectBestEffort(job.project_id, insertedId).catch(() => null));
  } catch (err) {
    if (insertedId) await pool.query('DELETE FROM photos WHERE id = ?', [insertedId]).catch(() => null);
    await storage.deleteObjects([keys.originalKey, keys.thumbKey]).catch(() => null);
    throw err;
  }
}

async function runJob(job) {
  const [projects] = await pool.query('SELECT organization_id, unit_id FROM projects WHERE id = ? LIMIT 1', [job.project_id]);
  if (!projects.length || Number(projects[0].organization_id) !== Number(job.organization_id)
    || Number(projects[0].unit_id || 0) !== Number(job.unit_id || 0)) {
    await pool.query("UPDATE external_import_items SET status = 'failed', error_code = 'PROJECT_CHANGED' WHERE job_id = ? AND status = 'pending'", [job.id]);
    await pool.query("UPDATE external_import_jobs SET status = 'completed_with_errors' WHERE id = ?", [job.id]);
    await pool.query("UPDATE external_import_items SET asset_url = '', preview_url = '' WHERE job_id = ?", [job.id]).catch(() => null);
    return;
  }
  while (true) {
    const [state] = await pool.query('SELECT cancel_requested FROM external_import_jobs WHERE id = ?', [job.id]);
    if (!state.length || state[0].cancel_requested) {
      await pool.query("UPDATE external_import_jobs SET status = 'cancelled' WHERE id = ?", [job.id]);
      await pool.query("UPDATE external_import_items SET asset_url = '', preview_url = '' WHERE job_id = ?", [job.id]).catch(() => null);
      return;
    }
    const [items] = await pool.query("SELECT * FROM external_import_items WHERE job_id = ? AND status = 'pending' ORDER BY id LIMIT 1", [job.id]);
    if (!items.length) break;
    const item = items[0];
    await pool.query("UPDATE external_import_items SET status = 'running' WHERE id = ?", [item.id]);
    try {
      await importItem(job, item);
    } catch (err) {
      const code = failureCode(err);
      console.warn('[external-import] item failed', { jobId: job.id, itemId: item.id, code });
      await pool.query("UPDATE external_import_items SET status = 'failed', error_code = ? WHERE id = ?", [code, item.id]);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const [failed] = await pool.query("SELECT COUNT(*) AS count FROM external_import_items WHERE job_id = ? AND status = 'failed'", [job.id]);
  await pool.query('UPDATE external_import_jobs SET status = ? WHERE id = ?', [Number(failed[0].count) ? 'completed_with_errors' : 'completed', job.id]);
  await pool.query("UPDATE external_import_items SET asset_url = '', preview_url = '' WHERE job_id = ?", [job.id]).catch(() => null);
}

async function pump() {
  if (!started || pumping) return;
  pumping = true;
  try {
    while (true) {
      const [jobs] = await pool.query("SELECT * FROM external_import_jobs WHERE status = 'queued' ORDER BY id LIMIT 1");
      if (!jobs.length) break;
      const job = jobs[0];
      const [claim] = await pool.query("UPDATE external_import_jobs SET status = 'running' WHERE id = ? AND status = 'queued'", [job.id]);
      if (!claim.affectedRows) continue;
      try { await runJob(job); }
      catch (err) {
        console.error('[external-import] job interrupted', { jobId: job.id, message: err?.message });
        await pool.query("UPDATE external_import_items SET status = 'pending' WHERE job_id = ? AND status = 'running'", [job.id]).catch(() => null);
        await pool.query("UPDATE external_import_jobs SET status = 'queued' WHERE id = ?", [job.id]).catch(() => null);
        const retryTimer = setTimeout(wake, 30000);
        retryTimer.unref?.();
        break;
      }
    }
  } finally { pumping = false; }
}

function wake() {
  if (started) setImmediate(() => pump().catch((err) => console.error('[external-import] pump failed:', err?.message)));
}

function start() {
  if (started) return;
  started = true;
  Promise.resolve()
    .then(() => pool.query("UPDATE external_import_items SET status = 'pending' WHERE status = 'running'"))
    .then(() => pool.query("UPDATE external_import_jobs SET status = 'queued' WHERE status = 'running'"))
    .then(wake)
    .catch((err) => console.warn('[external-import] startup recovery failed:', err?.message));
}

module.exports = { start, wake, failureCode, transferImage };
