const path = require('path');
const { pool } = require('../db');
const cosStorage = require('./cos_storage');
const { usableFaceSql } = require('./face_result_policy');

const MEDIA_FIELDS = ['url', 'thumb_url', 'public_download_url', 'playback_url'];
let pumping = false;

async function retryStorage(operation) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 3 ** attempt));
    }
  }
  throw lastError;
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function restoreSnapshotDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return value ?? null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date;
}

function destinationKey(job, photoId, field, sourceKey) {
  const ext = path.extname(sourceKey).slice(0, 12) || '.bin';
  return `uploads/units/${job.target_unit_id}/copies/${job.id}/${photoId}/${field}${ext}`;
}

async function loadPhotoSnapshot(share, conn = pool) {
  const [rows] = await conn.query(
    `SELECT si.snapshot_json, ph.*, p.name AS source_album_name
     FROM internal_share_items si
     LEFT JOIN photos ph ON ph.id = si.photo_id
     LEFT JOIN projects p ON p.id = ph.project_id
     WHERE si.share_id = ?
     ORDER BY si.id`, [share.id]
  );
  return rows.map((row) => parseJson(row.snapshot_json) || row)
    .filter((photo) => photo && Number(photo.organization_id) === Number(share.organization_id));
}

async function prepareManifest(job, share, photos) {
  const copies = [];
  let estimatedBytes = 0;
  for (const photo of photos) {
    for (const field of MEDIA_FIELDS) {
      if (!photo[field]) continue;
      const sourceKey = cosStorage.keyFromUrlOrPath(photo[field]);
      if (!sourceKey || !sourceKey.startsWith('uploads/') || !cosStorage.isSafeKey(sourceKey)) {
        throw new Error('COPY_SOURCE_OUTSIDE_STORAGE');
      }
      const head = await retryStorage(() => cosStorage.headObject(sourceKey));
      const bytes = Number(head.ContentLength);
      if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('COPY_SOURCE_SIZE_INVALID');
      estimatedBytes += bytes;
      copies.push({ photoId: photo.id, field, sourceKey,
        destinationKey: destinationKey(job, photo.id, field, sourceKey), bytes });
    }
  }
  const limit = Number(process.env.ORGANIZATION_COPY_MAX_BYTES_PER_JOB || 0);
  if (Number.isFinite(limit) && limit > 0 && estimatedBytes > limit) throw new Error('COPY_JOB_TOO_LARGE');
  const manifest = { sourceShareId: share.id, copies };
  await pool.query(
    'UPDATE organization_copy_jobs SET manifest_json = ?, estimated_bytes = ? WHERE id = ?',
    [JSON.stringify(manifest), estimatedBytes, job.id]
  );
  return manifest;
}

async function verifyShareAndRecipient(job, conn = pool) {
  const [shares] = await conn.query(
    `SELECT s.*, o.name AS source_organization_name, source.name AS source_unit_name,
            sharer.name AS shared_by_name
     FROM internal_shares s
     JOIN organizations o ON o.id = s.organization_id
     JOIN organization_units source ON source.id = s.source_unit_id
     LEFT JOIN users sharer ON sharer.id = s.created_by
     WHERE s.id = ? AND s.organization_id = ? AND s.mode = 'copy'
       AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > NOW()) LIMIT 1`,
    [job.share_id, job.organization_id]
  );
  const share = shares[0];
  if (!share || Number(share.target_unit_id) !== Number(job.target_unit_id)
    || (!job.system_initiated && share.target_user_id
      && Number(share.target_user_id) !== Number(job.requested_by))) {
    throw new Error('COPY_SHARE_EXPIRED');
  }
  if (job.system_initiated) {
    if (Number(share.created_by) !== Number(job.requested_by)) throw new Error('COPY_SHARE_CREATOR_CHANGED');
    return share;
  }
  const [members] = await conn.query(
    `SELECT 1 FROM organization_unit_memberships m JOIN users u ON u.id = m.user_id
     WHERE m.unit_id = ? AND m.user_id = ? AND m.removed_at IS NULL
       AND u.organization_id = ? LIMIT 1`,
    [job.target_unit_id, job.requested_by, job.organization_id]
  );
  if (!members.length) throw new Error('COPY_RECIPIENT_REMOVED');
  return share;
}

async function insertCopiedAlbum(conn, job, share) {
  const snapshot = parseJson(share.snapshot_json);
  let source = snapshot?.project;
  let sections = snapshot?.sections;
  if (!source && share.share_type === 'album') {
    const [sources] = await conn.query(
      'SELECT * FROM projects WHERE id = ? AND organization_id = ? LIMIT 1',
      [share.project_id, job.organization_id]
    );
    if (!sources.length) throw new Error('COPY_SOURCE_ALBUM_MISSING');
    source = sources[0];
  }
  if (!source) source = { name: '共享照片', description: null, event_date: null,
    meta: null, tags: null, type: 'normal' };
  const sourceMeta = parseJson(source.meta);
  const meta = sourceMeta && typeof sourceMeta === 'object' && !Array.isArray(sourceMeta)
    ? sourceMeta : {};
  const shareLineage = Array.isArray(meta.shareLineage) ? meta.shareLineage : [];
  const provenance = {
    shareId: share.id, organizationId: share.organization_id,
    organizationName: share.source_organization_name,
    unitId: share.source_unit_id, unitName: share.source_unit_name,
    albumId: share.project_id || null, albumName: source.name,
    sharedById: share.created_by, sharedByName: share.shared_by_name || null,
    sharedAt: share.created_at, copiedAt: new Date().toISOString(),
  };
  const [result] = await conn.query(
    `INSERT INTO projects
       (uuid, name, description, event_date, meta, photo_ids, tags, admin_id,
        organization_id, unit_id, restricted_to_user_id, type, created_at, updated_at)
     VALUES (UUID(), ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
    [`${source.name}（副本）`, source.description, restoreSnapshotDate(source.event_date),
      JSON.stringify({ ...meta, shareLineage: [...shareLineage, provenance] }), source.tags,
      job.requested_by, job.organization_id, job.target_unit_id,
      share.target_user_id || null, source.type]
  );
  const newProjectId = result.insertId;
  if (!sections && share.share_type === 'album') {
    [sections] = await conn.query(
      'SELECT id, name, section_time, sort_order FROM project_timeline_sections WHERE project_id = ? ORDER BY sort_order, id',
      [share.project_id]
    );
  }
  const sectionMap = new Map();
  for (const section of sections || []) {
    const [inserted] = await conn.query(
      `INSERT INTO project_timeline_sections
         (project_id, name, section_time, sort_order)
       VALUES (?, ?, ?, ?)`,
      [newProjectId, section.name, section.section_time, section.sort_order]
    );
    sectionMap.set(Number(section.id), inserted.insertId);
  }
  return { projectId: newProjectId, sectionMap };
}

async function commitCopy(job, share, photos, manifest) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await verifyShareAndRecipient(job, conn);
    let projectId = job.target_project_id;
    let sectionMap = new Map();
    if (share.share_type === 'album' || !projectId) {
      const album = await insertCopiedAlbum(conn, job, share);
      projectId = album.projectId;
      sectionMap = album.sectionMap;
    } else {
      const [destinations] = await conn.query(
        'SELECT id FROM projects WHERE id = ? AND organization_id = ? AND unit_id = ? LIMIT 1',
        [projectId, job.organization_id, job.target_unit_id]
      );
      if (!destinations.length) throw new Error('COPY_TARGET_ALBUM_MISSING');
    }
    const destinationsByPhoto = new Map();
    for (const item of manifest.copies) {
      if (!destinationsByPhoto.has(Number(item.photoId))) destinationsByPhoto.set(Number(item.photoId), {});
      destinationsByPhoto.get(Number(item.photoId))[item.field] = `/${item.destinationKey}`;
    }
    const newPhotoIds = [];
    for (const photo of photos) {
      const media = destinationsByPhoto.get(Number(photo.id)) || {};
      const sectionId = share.share_type === 'album'
        ? (sectionMap.get(Number(photo.timeline_section_id)) || null) : null;
      const attribution = { sourcePhotoUuid: photo.uuid, sourcePhotoId: photo.id,
        sourceAlbumName: photo.source_album_name || null, sourceUnitId: share.source_unit_id,
        sourceUnitName: share.source_unit_name, sourceOrganizationId: share.organization_id,
        sourceOrganizationName: share.source_organization_name, shareId: share.id,
        copiedAt: new Date().toISOString() };
      const [inserted] = await conn.query(
        `INSERT INTO photos
           (uuid, project_id, timeline_section_id, url, thumb_url, public_download_url,
            playback_url, title, tags, ai_status, ai_error, ai_score, ai_quality,
            ai_started_at, ai_finished_at, type, capture_time, photographer_id,
            description, ocr_text, adjustments, organization_id, unit_id, source_attribution)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [projectId, sectionId, media.url, media.thumb_url || null,
          media.public_download_url || null, media.playback_url || null,
          photo.title, photo.tags ? JSON.stringify(parseJson(photo.tags)) : null,
          photo.ai_status, photo.ai_error, photo.ai_score,
          photo.ai_quality ? JSON.stringify(parseJson(photo.ai_quality)) : null,
          restoreSnapshotDate(photo.ai_started_at), restoreSnapshotDate(photo.ai_finished_at),
          photo.type, restoreSnapshotDate(photo.capture_time),
          photo.photographer_id, photo.description, photo.ocr_text,
          photo.adjustments ? JSON.stringify(parseJson(photo.adjustments)) : null,
          job.organization_id, job.target_unit_id, JSON.stringify(attribution)]
      );
      newPhotoIds.push(inserted.insertId);
      await conn.query(
        `INSERT INTO photo_video_semantics (photo_id, analysis_json)
         SELECT ?, analysis_json FROM photo_video_semantics WHERE photo_id = ?`,
        [inserted.insertId, photo.id]
      );
      await conn.query(
        `INSERT INTO photo_faces
           (photo_id, project_id, organization_id, person_id, face_no,
            bbox_x, bbox_y, bbox_w, bbox_h, bbox_unit, image_width, image_height,
            detection_score, quality_score, embedding, normalized_embedding,
            model_name, model_version, status, face_hash, extra)
         SELECT ?, ?, organization_id, person_id, face_no,
                bbox_x, bbox_y, bbox_w, bbox_h, bbox_unit, image_width, image_height,
                detection_score, quality_score, embedding, normalized_embedding,
                model_name, model_version, status, face_hash, extra
         FROM photo_faces WHERE photo_id = ? AND ${usableFaceSql()}`,
        [inserted.insertId, projectId, photo.id]
      );
    }
    const [projectRows] = await conn.query('SELECT photo_ids FROM projects WHERE id = ? FOR UPDATE', [projectId]);
    const existing = parseJson(projectRows[0]?.photo_ids);
    const ids = Array.isArray(existing) ? existing.concat(newPhotoIds) : newPhotoIds;
    await conn.query('UPDATE projects SET photo_ids = ? WHERE id = ?', [JSON.stringify(ids), projectId]);
    const result = { projectId, photoIds: newPhotoIds };
    await conn.query(
      "UPDATE organization_copy_jobs SET status = 'ready', result_json = ?, error_code = NULL WHERE id = ?",
      [JSON.stringify(result), job.id]
    );
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally { conn.release(); }
}

async function runJob(job) {
  let manifest = parseJson(job.manifest_json);
  try {
    const share = await verifyShareAndRecipient(job);
    const photos = await loadPhotoSnapshot(share);
    const [itemCount] = await pool.query(
      'SELECT COUNT(*) AS count FROM internal_share_items WHERE share_id = ?', [share.id]
    );
    if (photos.length !== Number(itemCount[0].count)) throw new Error('COPY_SNAPSHOT_INCOMPLETE');
    if (!manifest) manifest = await prepareManifest(job, share, photos);
    let copiedBytes = 0;
    for (const item of manifest.copies) {
      await retryStorage(() => cosStorage.copyObject(item.sourceKey, item.destinationKey, {
        onProgress: (done) => {
          pool.query('UPDATE organization_copy_jobs SET copied_bytes = ? WHERE id = ?',
            [copiedBytes + done, job.id]).catch(() => {});
        },
      }));
      copiedBytes += item.bytes;
      await pool.query('UPDATE organization_copy_jobs SET copied_bytes = ? WHERE id = ?', [copiedBytes, job.id]);
    }
    await commitCopy(job, share, photos, manifest);
  } catch (err) {
    console.error('[organization-copy] job failed:', job.id, err && err.stack ? err.stack : err);
    if (manifest?.copies?.length) {
      await cosStorage.deleteObjects(manifest.copies.map((item) => item.destinationKey)).catch(() => {});
    }
    await pool.query(
      "UPDATE organization_copy_jobs SET status = 'failed', error_code = ? WHERE id = ?",
      [String(err.message || 'COPY_FAILED').slice(0, 80), job.id]
    ).catch(() => {});
  }
}

async function pump() {
  if (pumping || process.env.ORGANIZATION_UNITS_ACTIVE !== '1') return;
  pumping = true;
  try {
    for (;;) {
      const [queued] = await pool.query(
        "SELECT * FROM organization_copy_jobs WHERE status = 'queued' ORDER BY id LIMIT 1"
      );
      if (!queued.length) break;
      const job = queued[0];
      const [claimed] = await pool.query(
        "UPDATE organization_copy_jobs SET status = 'copying' WHERE id = ? AND status = 'queued'",
        [job.id]
      );
      if (!claimed.affectedRows) continue;
      await runJob(job);
    }
  } catch (err) {
    console.error('[organization-copy] worker error:', err && err.stack ? err.stack : err);
  } finally { pumping = false; }
}

function wake() {
  setImmediate(() => { pump().catch(() => {}); });
}

function start() {
  if (process.env.ORGANIZATION_UNITS_ACTIVE !== '1') return;
  pool.query(
    "UPDATE organization_copy_jobs SET status = 'queued' WHERE status = 'copying' AND updated_at < DATE_SUB(NOW(), INTERVAL 2 HOUR)"
  ).then(wake).catch((err) => console.error('[organization-copy] recovery failed:', err));
  const timer = setInterval(wake, 60 * 1000);
  if (typeof timer.unref === 'function') timer.unref();
}

module.exports = { wake, start, destinationKey };
