const { Transform } = require('stream');
const sharp = require('sharp');
const { pool } = require('../db');
const storage = require('./cos_storage');
const upload = require('../routes/upload');
const { normalizePhotoPlusAsset, scanPhotoPlus } = require('./external_gallery_scan');
const { parseAlltuuUrl, normalizeAlltuuAsset, scanAlltuu } = require('./external_gallery_alltuu');
const { scanFromTemplate } = require('./external_gallery_templates');
const { updateImportMetadata, ingestBatch } = require('./external_import_jobs');
const { parsePublicHttpsUrl, openPublicHttps } = require('./public_remote_fetch');

const MAX_SOURCE_BYTES = 500 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
const SOURCE_TIMEOUT_MS = 120000;
const MAX_ACTIVE_JOBS = 2;
const RETRYABLE_ITEM_CODES = new Set(['TRANSFER_FAILED', 'SOURCE_EXPIRED', 'SOURCE_REDIRECT']);
const MIME_BY_EXTENSION = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif',
};
const RAW_EXTENSION = /\.(?:dng|cr2|cr3|nef|arw|raf|rw2|orf|pef|raw)(?:$|\?)/i;
let started = false;
let pumping = false;
let ticker;
const runningJobs = new Set();

function failureCode(err) {
  const code = String(err?.code || '');
  if (['SOURCE_EXPIRED', 'SOURCE_MISSING', 'SOURCE_RATE_LIMIT', 'SOURCE_TOO_LARGE',
    'SOURCE_NOT_IMAGE', 'INVALID_SOURCE_URL', 'SOURCE_REDIRECT', 'INVALID_IMAGE',
    'PROJECT_CHANGED', 'HEIC_PREVIEW_UNAVAILABLE', 'UNSUPPORTED_RAW'].includes(code)) return code;
  return 'TRANSFER_FAILED';
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function imageMime(header, url) {
  const type = String(header || '').split(';')[0].trim().toLowerCase();
  const path = new URL(url).pathname.toLowerCase();
  const extension = path.match(/\.([a-z0-9]+)$/)?.[1];
  if (['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(type)) return type;
  if (type === 'application/octet-stream' && MIME_BY_EXTENSION[extension]) return MIME_BY_EXTENSION[extension];
  return null;
}

async function transferImage(url, key) {
  const safeUrl = parsePublicHttpsUrl(url);
  if (!safeUrl) throw Object.assign(new Error('Invalid source URL'), { code: 'INVALID_SOURCE_URL' });
  const { response, url: finalUrl } = await openPublicHttps(safeUrl.href, {
    accept: 'image/jpeg,image/png,image/webp,image/heic,image/heif', timeoutMs: SOURCE_TIMEOUT_MS,
  });
  try {
    if (response.statusCode === 403) throw Object.assign(new Error('Source expired'), { code: 'SOURCE_EXPIRED' });
    if (response.statusCode === 404) throw Object.assign(new Error('Source missing'), { code: 'SOURCE_MISSING' });
    if (response.statusCode === 429) throw Object.assign(new Error('Source rate limited'), { code: 'SOURCE_RATE_LIMIT' });
    if (response.statusCode !== 200) throw new Error(`Source HTTP ${response.statusCode}`);
    if (RAW_EXTENSION.test(finalUrl)) throw Object.assign(new Error('RAW source is not supported'), { code: 'UNSUPPORTED_RAW' });
    const type = imageMime(response.headers['content-type'], finalUrl);
    if (!type) throw Object.assign(new Error('Source is not a supported image'), { code: 'SOURCE_NOT_IMAGE' });
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
    await storage.uploadStream(key, limiter, {
      contentType: type, cacheControl: 'public, max-age=31536000, immutable', queueSize: 1,
    });
    return { bytes: received, type };
  } finally { response.destroy(); }
}

async function makeThumbnail(key, type, previewUrl) {
  const isHeic = type === 'image/heic' || type === 'image/heif';
  let stream;
  let response;
  if (isHeic) {
    if (!previewUrl || !parsePublicHttpsUrl(previewUrl)) {
      throw Object.assign(new Error('HEIC preview is unavailable'), { code: 'HEIC_PREVIEW_UNAVAILABLE' });
    }
    ({ response } = await openPublicHttps(previewUrl, { accept: 'image/jpeg,image/png,image/webp', timeoutMs: SOURCE_TIMEOUT_MS }));
    const previewType = imageMime(response.headers['content-type'], previewUrl);
    if (response.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp'].includes(previewType)
      || Number(response.headers['content-length']) > MAX_PREVIEW_BYTES) {
      response.destroy();
      throw Object.assign(new Error('HEIC preview is unavailable'), { code: 'HEIC_PREVIEW_UNAVAILABLE' });
    }
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > MAX_PREVIEW_BYTES) callback(Object.assign(new Error('HEIC preview too large'), { code: 'HEIC_PREVIEW_UNAVAILABLE' }));
        else callback(null, chunk);
      },
    });
    response.on('error', (err) => limiter.destroy(err));
    stream = response.pipe(limiter);
  } else {
    const source = await storage.getObject(key);
    stream = source.Body;
  }
  try {
    const converter = sharp({ failOn: 'none' })
      .rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80, mozjpeg: true });
    stream.on('error', (err) => converter.destroy(err));
    stream.pipe(converter);
    return await converter.toBuffer();
  } catch (err) {
    throw Object.assign(new Error('Invalid image preview'), { code: isHeic ? 'HEIC_PREVIEW_UNAVAILABLE' : 'INVALID_IMAGE' });
  } finally { stream.destroy?.(); response?.destroy(); }
}

function sourceAttribution(job, item) {
  return JSON.stringify({
    type: 'external_import', provider: job.provider, sourceAlbumUrl: job.source_url,
    sourceAlbumTitle: job.source_title, sourcePhotoId: item.provider_photo_id,
    sourceSectionName: item.source_section_name || null, importJobId: job.id,
    importItemId: item.id, quality: job.source_quality, importedAt: new Date().toISOString(),
  });
}

async function importItem(job, item) {
  if (job.provider === 'photoplus' && !normalizePhotoPlusAsset(item.asset_url)) {
    throw Object.assign(new Error('Invalid PhotoPlus asset'), { code: 'INVALID_SOURCE_URL' });
  }
  if ((job.provider === 'alltuu' || parseAlltuuUrl(job.source_url))
    && !normalizeAlltuuAsset(item.asset_url, 'uio.alltuu.com')) {
    throw Object.assign(new Error('Invalid Alltuu original asset'), { code: 'INVALID_SOURCE_URL' });
  }
  const [oldCopies] = await pool.query(
    `SELECT i.photo_id AS photoId FROM external_import_items i
     JOIN external_import_jobs j ON j.id = i.job_id
     JOIN photos ph ON ph.id = i.photo_id
     WHERE j.project_id = ? AND j.provider = ? AND i.provider_photo_id = ? AND i.status = 'done'
       AND i.photo_id IS NOT NULL AND i.id <> ? LIMIT 1`,
    [job.project_id, job.provider, item.provider_photo_id, item.id]
  );
  if (oldCopies.length) {
    await pool.query("UPDATE external_import_items SET status = 'skipped', photo_id = ?, error_code = NULL WHERE id = ?", [oldCopies[0].photoId, item.id]);
    return;
  }

  if (item.object_key) {
    const [existing] = await pool.query('SELECT id FROM photos WHERE url = ? LIMIT 1', [`/${item.object_key}`]);
    if (existing.length) {
      await pool.query(
        'UPDATE photos SET source_attribution = COALESCE(source_attribution, ?), capture_time = COALESCE(capture_time, DATE(?)) WHERE id = ?',
        [sourceAttribution(job, item), item.source_capture_time || null, existing[0].id]
      );
      await pool.query("UPDATE external_import_items SET status = 'done', photo_id = ?, error_code = NULL WHERE id = ?", [existing[0].id, item.id]);
      try {
        upload.enqueuePostUploadJobs({ insertedId: existing[0].id, thumbRel: `/${item.thumb_key}`, thumbBuffer: null, photographerId: job.requested_by, priority: 'low' });
      } catch (err) { console.warn('[external-import] post-upload retry failed:', err?.message); }
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
    : upload.buildObjectKeys(job.project_id, item.filename, '', 'image', job.unit_id);
  if (!item.object_key) {
    await pool.query('UPDATE external_import_items SET object_key = ?, thumb_key = ? WHERE id = ?', [keys.originalKey, keys.thumbKey, item.id]);
  }
  let insertedId = null;
  let thumb = null;
  try {
    const transferred = await transferImage(item.asset_url, keys.originalKey);
    thumb = await makeThumbnail(keys.originalKey, transferred.type, item.preview_url);
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
    await pool.query('UPDATE photos SET source_attribution = ?, capture_time = DATE(?) WHERE id = ?',
      [sourceAttribution(job, item), item.source_capture_time || null, insertedId]);
    await pool.query("UPDATE external_import_items SET status = 'done', photo_id = ?, error_code = NULL WHERE id = ?", [insertedId, item.id]);
  } catch (err) {
    if (insertedId) await pool.query('DELETE FROM photos WHERE id = ?', [insertedId]).catch(() => null);
    await storage.deleteObjects([keys.originalKey, keys.thumbKey]).catch(() => null);
    throw err;
  }
  try {
    upload.enqueuePostUploadJobs({ insertedId, thumbRel: `/${keys.thumbKey}`, thumbBuffer: thumb, photographerId: job.requested_by, priority: 'low' });
    if (keys.publicDownloadKey) upload.enqueuePublicDownloadDerivative({
      insertedId, sourceKey: keys.originalKey,
      publicDownloadKey: keys.publicDownloadKey,
      publicDownloadRel: keys.publicDownloadRel,
    });
    setImmediate(() => upload.appendPhotoIdToProjectBestEffort(job.project_id, insertedId).catch(() => null));
  } catch (err) { console.warn('[external-import] post-upload dispatch failed:', err?.message); }
}

async function scanJob(job, shouldStop) {
  await pool.query("UPDATE external_import_jobs SET scan_status = 'running', scan_error_code = NULL, scan_attempts = scan_attempts + 1 WHERE id = ?", [job.id]);
  const options = {
    shouldStop,
    onMetadata: async (summary) => { await updateImportMetadata(job, summary); },
    onBatch: async (batch, info) => {
      await ingestBatch(job, batch, { ...info, sourceSections: job.sourceSections });
    },
  };
  try {
    const result = job.provider === 'photoplus'
      ? await scanPhotoPlus(job.source_url, options)
      : (job.provider === 'alltuu' || parseAlltuuUrl(job.source_url))
        ? await scanAlltuu(job.source_url, options)
        : await scanFromTemplate(job.source_url, options);
    await pool.query(
      `UPDATE external_import_jobs SET scan_status = 'completed', scan_error_code = NULL,
       source_title = ?, source_quality = ?, reported_total = ? WHERE id = ?`,
      [result.title, result.quality, result.reportedTotal, job.id]
    );
  } catch (err) {
    if (err.code === 'IMPORT_STOPPED' || shouldStop()) {
      await pool.query("UPDATE external_import_jobs SET scan_status = 'pending' WHERE id = ? AND scan_status = 'running'", [job.id]);
      return;
    }
    const code = String(err.code || 'SCAN_FAILED').slice(0, 80);
    console.warn('[external-import] scan failed', { jobId: job.id, code, message: err.message });
    if ((code === 'SOURCE_RATE_LIMIT' && Number(job.scan_attempts) < 8)
      || (code === 'SCAN_INCOMPLETE' && Number(job.scan_attempts) < 3)) {
      const delay = Math.min(300, 15 * (2 ** Math.min(Number(job.scan_attempts) || 0, 4)));
      await pool.query(
        "UPDATE external_import_jobs SET status = 'paused', scan_status = 'pending', scan_error_code = ?, retry_after = DATE_ADD(NOW(), INTERVAL ? SECOND) WHERE id = ?",
        [code, delay, job.id]
      );
      return;
    }
    await pool.query("UPDATE external_import_jobs SET scan_status = 'failed', scan_error_code = ? WHERE id = ?", [code, job.id]);
  }
}

async function runJob(job) {
  if (job.provider === 'generic' && parseAlltuuUrl(job.source_url)) {
    await pool.query("UPDATE external_import_jobs SET provider = 'alltuu' WHERE id = ? AND provider = 'generic'", [job.id]);
    job.provider = 'alltuu';
  }
  const [projects] = await pool.query('SELECT organization_id, unit_id FROM projects WHERE id = ? LIMIT 1', [job.project_id]);
  if (!projects.length || Number(projects[0].organization_id) !== Number(job.organization_id)
    || Number(projects[0].unit_id || 0) !== Number(job.unit_id || 0)) {
    await pool.query("UPDATE external_import_items SET status = 'failed', error_code = 'PROJECT_CHANGED' WHERE job_id = ? AND status = 'pending'", [job.id]);
    await pool.query("UPDATE external_import_jobs SET status = 'completed_with_errors', scan_status = 'failed', scan_error_code = 'PROJECT_CHANGED', finished_at = NOW() WHERE id = ?", [job.id]);
    return;
  }
  let stopScan = false;
  let scanning = job.scan_status !== 'completed';
  const scanPromise = scanning
    ? scanJob(job, () => stopScan).finally(() => { scanning = false; })
    : Promise.resolve();
  while (true) {
    const [stateRows] = await pool.query('SELECT status, cancel_requested, scan_status FROM external_import_jobs WHERE id = ?', [job.id]);
    const state = stateRows[0];
    if (!state) { stopScan = true; break; }
    if (state.cancel_requested) {
      stopScan = true;
      await pool.query("UPDATE external_import_jobs SET status = 'cancelled', finished_at = NOW() WHERE id = ?", [job.id]);
      break;
    }
    if (state.status === 'paused') { stopScan = true; break; }
    const [items] = await pool.query("SELECT * FROM external_import_items WHERE job_id = ? AND status = 'pending' ORDER BY source_order, id LIMIT 1", [job.id]);
    if (!items.length) {
      if (!scanning) break;
      await sleep(600);
      continue;
    }
    const item = items[0];
    await pool.query("UPDATE external_import_items SET status = 'running', attempt_count = attempt_count + 1 WHERE id = ? AND status = 'pending'", [item.id]);
    try {
      await importItem(job, item);
    } catch (err) {
      const code = failureCode(err);
      console.warn('[external-import] item failed', { jobId: job.id, itemId: item.id, code });
      if (code === 'SOURCE_RATE_LIMIT') {
        stopScan = true;
        await pool.query("UPDATE external_import_items SET status = 'pending', error_code = ? WHERE id = ?", [code, item.id]);
        await pool.query("UPDATE external_import_jobs SET status = 'paused', scan_error_code = 'SOURCE_RATE_LIMIT', retry_after = DATE_ADD(NOW(), INTERVAL 60 SECOND), scan_status = IF(scan_status = 'running', 'pending', scan_status) WHERE id = ?", [job.id]);
        break;
      }
      if (code === 'UNSUPPORTED_RAW') {
        await pool.query("UPDATE external_import_items SET status = 'skipped', error_code = ? WHERE id = ?", [code, item.id]);
        continue;
      }
      const retry = Number(item.attempt_count) < 2 && RETRYABLE_ITEM_CODES.has(code);
      await pool.query('UPDATE external_import_items SET status = ?, error_code = ? WHERE id = ?', [retry ? 'pending' : 'failed', code, item.id]);
      if (retry) await sleep(1000 * (Number(item.attempt_count) + 1));
    }
    await sleep(150);
  }
  await scanPromise;
  const [stateRows] = await pool.query('SELECT status, cancel_requested, scan_status FROM external_import_jobs WHERE id = ?', [job.id]);
  const state = stateRows[0];
  if (!state || state.status === 'paused' || state.status === 'cancelled') return;
  if (state.cancel_requested) {
    await pool.query("UPDATE external_import_jobs SET status = 'cancelled', finished_at = NOW() WHERE id = ?", [job.id]);
    return;
  }
  const [[counts]] = await pool.query("SELECT SUM(status = 'failed') AS failed, SUM(status = 'pending') AS pending FROM external_import_items WHERE job_id = ?", [job.id]);
  if (Number(counts.pending)) {
    await pool.query("UPDATE external_import_jobs SET status = 'queued' WHERE id = ?", [job.id]);
    return;
  }
  const failed = Number(counts.failed) || state.scan_status === 'failed';
  await pool.query('UPDATE external_import_jobs SET status = ?, finished_at = NOW() WHERE id = ?', [failed ? 'completed_with_errors' : 'completed', job.id]);
}

async function pump() {
  if (!started || pumping) return;
  pumping = true;
  try {
    await pool.query("UPDATE external_import_jobs SET status = 'queued', retry_after = NULL WHERE status = 'paused' AND cancel_requested = 0 AND retry_after <= NOW()");
    while (runningJobs.size < MAX_ACTIVE_JOBS) {
      const [jobs] = await pool.query("SELECT * FROM external_import_jobs WHERE status = 'queued' ORDER BY id LIMIT 1");
      if (!jobs.length) break;
      const job = jobs[0];
      const [claim] = await pool.query("UPDATE external_import_jobs SET status = 'running', scan_error_code = IF(scan_status = 'completed', NULL, scan_error_code) WHERE id = ? AND status = 'queued'", [job.id]);
      if (!claim.affectedRows) continue;
      runningJobs.add(job.id);
      runJob(job).catch(async (err) => {
        console.error('[external-import] job interrupted', { jobId: job.id, message: err?.message });
        await pool.query("UPDATE external_import_items SET status = 'pending' WHERE job_id = ? AND status = 'running'", [job.id]).catch(() => null);
        await pool.query("UPDATE external_import_jobs SET status = 'paused', scan_status = IF(scan_status = 'running', 'pending', scan_status), scan_error_code = 'WORKER_INTERRUPTED', retry_after = DATE_ADD(NOW(), INTERVAL 30 SECOND) WHERE id = ? AND status = 'running'", [job.id]).catch(() => null);
      }).finally(() => { runningJobs.delete(job.id); wake(); });
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
    .then(() => pool.query("UPDATE external_import_jobs SET status = 'queued', scan_status = IF(scan_status = 'running', 'pending', scan_status) WHERE status = 'running'"))
    .then(() => {
      ticker = setInterval(wake, 2500);
      ticker.unref?.();
      wake();
    })
    .catch((err) => console.warn('[external-import] startup recovery failed:', err?.message));
}

module.exports = { start, wake, failureCode, transferImage, imageMime };
