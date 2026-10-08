// Upgrade an existing import in place. Old objects and a private manifest are retained for rollback.
require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { pool } = require('../db');
const storage = require('../lib/cos_storage');
const upload = require('../routes/upload');
const { transferImage } = require('../lib/external_import_worker');
const { parsePhotoPlusUrl, scanPhotoPlus } = require('../lib/external_gallery_scan');
const { createPublicDownloadBuffer, readStreamToBuffer } = require('../lib/public_download_variant');

function parseJson(value) {
  if (typeof value !== 'string') return value || {};
  try { return JSON.parse(value); } catch (_) { return {}; }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
    const index = arg.indexOf('=');
    return index < 0 ? [arg.replace(/^--/, ''), true] : [arg.slice(2, index), arg.slice(index + 1)];
  }));
  const jobId = Number(args.jobId);
  const parsed = parsePhotoPlusUrl(args.sourceUrl);
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || !parsed?.viewerSign) {
    throw new Error('Provide --jobId=<id> and --sourceUrl=<PhotoPlus authorized viewer URL>');
  }
  const [[job]] = await pool.query('SELECT * FROM external_import_jobs WHERE id = ?', [jobId]);
  if (!job || job.provider !== 'photoplus' || parsePhotoPlusUrl(job.source_url)?.activityNo !== parsed.activityNo) {
    throw new Error('Source activity does not match the existing import');
  }
  const [active] = await pool.query("SELECT id FROM external_import_jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused')", [job.project_id]);
  if (active.length) throw new Error('Stop active imports in this album before repairing originals');
  const [items] = await pool.query(`
    SELECT i.id, i.provider_photo_id, i.photo_id, i.filename, i.asset_url, i.preview_url, i.object_key, i.thumb_key,
      p.url, p.thumb_url, p.public_download_url, p.source_attribution
    FROM external_import_items i JOIN photos p ON p.id = i.photo_id
    WHERE i.job_id = ? AND i.status = 'done' AND p.project_id = ? AND p.organization_id = ? AND p.unit_id <=> ?
    ORDER BY i.id`, [job.id, job.project_id, job.organization_id, job.unit_id]);
  const targets = items.filter((item) => parseJson(item.source_attribution).quality !== 'original_view');
  const originals = new Map();
  const remaining = new Set(targets.map((item) => String(item.provider_photo_id)));
  if (remaining.size) {
    try {
      await scanPhotoPlus(parsed.canonicalUrl, {
        onBatch: async (batch) => {
          for (const photo of batch) {
            if (!remaining.has(photo.id)) continue;
            if (photo.watermarked) throw new Error(`Source does not provide a clean original for photo ${photo.id}`);
            originals.set(photo.id, photo);
            remaining.delete(photo.id);
          }
        },
        shouldStop: () => remaining.size === 0,
      });
    } catch (error) {
      if (error.code !== 'IMPORT_STOPPED' || remaining.size) throw error;
    }
    if (remaining.size) throw new Error(`${remaining.size} imported photos were not found in the supplied viewer`);
  }
  console.log(JSON.stringify({ apply: Boolean(args.apply), jobId, projectId: job.project_id,
    importedPhotos: items.length, cleanOriginalsAvailable: originals.size, alreadyRepaired: items.length - targets.length }));
  if (!args.apply) return;

  const directory = path.join(require('os').homedir(), '.mamage-maintenance');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const manifestPath = path.join(directory, `photoplus-originals-${jobId}-${Date.now()}.json`);
  const manifest = { job: { id: job.id, source_url: job.source_url, source_quality: job.source_quality,
    scan_status: job.scan_status }, sourceUrl: parsed.canonicalUrl, items: targets, completed: [], failures: [] };
  const saveManifest = () => fs.writeFileSync(manifestPath, JSON.stringify(manifest), { mode: 0o600 });
  saveManifest();
  let cursor = 0;
  async function repairNext() {
    while (cursor < targets.length) {
      const item = targets[cursor++];
      const source = originals.get(String(item.provider_photo_id));
      const keys = upload.buildObjectKeys(job.project_id, item.filename, 'image/jpeg', 'image', job.unit_id);
      let committed = false;
      try {
        const transferred = await transferImage(source.transferUrl, keys.originalKey);
        const object = await storage.getObject(keys.originalKey);
        let input;
        try { input = await readStreamToBuffer(object.Body, { maxBytes: 128 * 1024 * 1024 }); }
        finally { object.Body.destroy?.(); }
        const thumb = await sharp(input).rotate().resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 80, mozjpeg: true }).toBuffer();
        const rendition = await createPublicDownloadBuffer(input);
        if (source.width && source.height && !(
          (rendition.width === source.width && rendition.height === source.height)
          || (rendition.width === source.height && rendition.height === source.width)
        )) throw new Error('Source original dimensions do not match the photo listing');
        const oldThumbnail = await storage.getObject(item.thumb_url);
        let oldThumbnailBuffer;
        try { oldThumbnailBuffer = await readStreamToBuffer(oldThumbnail.Body, { maxBytes: 20 * 1024 * 1024 }); }
        finally { oldThumbnail.Body.destroy?.(); }
        const oldSize = await sharp(oldThumbnailBuffer).metadata();
        const newSize = await sharp(thumb).metadata();
        if (Math.abs((newSize.width / newSize.height) / (oldSize.width / oldSize.height) - 1) > 0.01) {
          throw new Error('Photo framing changed; reviewed face positions must be checked before replacing');
        }
        await storage.uploadBuffer(keys.thumbKey, thumb, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
        await storage.uploadBuffer(keys.publicDownloadKey, rendition.buffer, { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' });
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();
          const [jobs] = await conn.query("SELECT id FROM external_import_jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused') FOR UPDATE", [job.project_id]);
          if (jobs.length) throw new Error('An import started during repair');
          const patch = JSON.stringify({ sourceAlbumUrl: parsed.canonicalUrl, quality: 'original_view', originalRestoredAt: new Date().toISOString() });
          const [update] = await conn.query(`UPDATE photos SET url = ?, thumb_url = ?, public_download_url = ?,
            source_attribution = JSON_MERGE_PATCH(COALESCE(source_attribution, JSON_OBJECT()), CAST(? AS JSON))
            WHERE id = ? AND project_id = ? AND organization_id = ? AND url = ?`,
          [keys.relPath, keys.thumbRel, keys.publicDownloadRel, patch, item.photo_id, job.project_id, job.organization_id, item.url]);
          if (update.affectedRows !== 1) throw new Error('Photo changed during repair');
          const [itemUpdate] = await conn.query(`UPDATE external_import_items SET asset_url = ?, preview_url = ?, object_key = ?, thumb_key = ?
            WHERE id = ? AND job_id = ? AND photo_id = ? AND status = 'done'`,
          [source.transferUrl, source.previewUrl, keys.originalKey, keys.thumbKey, item.id, job.id, item.photo_id]);
          if (itemUpdate.affectedRows !== 1) throw new Error('Import item changed during repair');
          await conn.query("UPDATE external_import_jobs SET source_url = ?, source_quality = 'source_original_preferred', scan_status = 'pending' WHERE id = ?",
            [parsed.canonicalUrl, job.id]);
          await conn.commit();
          committed = true;
        } catch (error) { await conn.rollback(); throw error; }
        finally { conn.release(); }
        manifest.completed.push({ photoId: item.photo_id, itemId: item.id, newUrl: keys.relPath,
          newThumbUrl: keys.thumbRel, newPublicUrl: keys.publicDownloadRel, bytes: transferred.bytes,
          width: rendition.width, height: rendition.height, publicBytes: rendition.bytes });
        saveManifest();
        console.log(JSON.stringify({ repaired: manifest.completed.length, total: targets.length, photoId: item.photo_id }));
      } catch (error) {
        if (!committed) await storage.deleteObjects([keys.originalKey, keys.thumbKey, keys.publicDownloadKey]).catch(() => null);
        manifest.failures.push({ photoId: item.photo_id, message: error.message });
        saveManifest();
        console.error(JSON.stringify({ failedPhoto: item.photo_id, message: error.message }));
      }
    }
  }
  await Promise.all([repairNext(), repairNext()]);
  console.log(JSON.stringify({ repaired: manifest.completed.length, failed: manifest.failures.length,
    projectId: job.project_id, manifestPath, existingIdsPreserved: true, oldObjectsRetained: true }));
  if (manifest.failures.length) throw new Error('Some originals were not repaired; inspect the private manifest');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; }).finally(() => pool.end());
