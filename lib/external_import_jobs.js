const { pool } = require('../db');
const { requireProjectAccess } = require('./workspace_access');
const { parsePhotoPlusUrl } = require('./external_gallery_scan');
const { parseAlltuuUrl } = require('./external_gallery_alltuu');
const { parsePublicHttpsUrl } = require('./public_remote_fetch');
const PENDING_IMPORT_TITLE_KEY = '_pendingExternalImportTitle';

function sourceFromUrl(rawUrl) {
  const photoPlus = parsePhotoPlusUrl(rawUrl);
  const alltuu = parseAlltuuUrl(rawUrl);
  const publicUrl = photoPlus || alltuu ? null : parsePublicHttpsUrl(rawUrl);
  if (!photoPlus && !alltuu && !publicUrl) return null;
  const sourceUrl = photoPlus?.canonicalUrl || alltuu?.canonicalUrl || publicUrl.href;
  if (sourceUrl.length > 512) return null;
  return {
    provider: photoPlus ? 'photoplus' : alltuu ? 'alltuu' : 'generic',
    sourceUrl,
    title: photoPlus ? `PhotoPlus ${photoPlus.activityNo}` : alltuu ? 'Alltuu 相册' : publicUrl.hostname,
  };
}

async function insertJob(conn, { source, projectId, organizationId, unitId, requestedBy }) {
  const [result] = await conn.query(
    `INSERT INTO external_import_jobs
     (provider, source_url, source_title, source_quality, organization_id, unit_id,
      project_id, requested_by, selected_count, scan_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
    [source.provider, source.sourceUrl, source.title,
      source.provider === 'photoplus' ? 'source_original_preferred' : 'source_link_unverified',
      organizationId, unitId, projectId, requestedBy]
  );
  return Number(result.insertId);
}

async function createJob(req, projectId, rawUrl) {
  const source = sourceFromUrl(rawUrl);
  if (!source) throw Object.assign(new Error('请填写公开的 HTTPS 相册链接'), { status: 400 });
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const project = await requireProjectAccess(req, projectId, 'upload', conn);
    await conn.query('SELECT id FROM projects WHERE id = ? FOR UPDATE', [projectId]);
    const [active] = await conn.query(
      "SELECT id, source_url FROM external_import_jobs WHERE project_id = ? AND status IN ('queued', 'running', 'paused') ORDER BY id DESC LIMIT 1",
      [projectId]
    );
    if (active.length) {
      if (active[0].source_url !== source.sourceUrl) {
        throw Object.assign(new Error('当前相册已有转存任务，请等待完成或先停止'), { status: 409 });
      }
      await conn.commit();
      return { jobId: Number(active[0].id), existing: true };
    }
    const jobId = await insertJob(conn, {
      source, projectId, organizationId: project.organization_id,
      unitId: project.unit_id, requestedBy: req.user.id,
    });
    await conn.commit();
    return { jobId, existing: false };
  } catch (err) {
    await conn.rollback().catch(() => null);
    throw err;
  } finally { conn.release(); }
}

function cleanSectionName(value, fallback) {
  return String(value || fallback || '来源照片').replace(/\s+/g, ' ').trim().slice(0, 80) || '来源照片';
}

async function updateImportMetadata(job, summary) {
  const title = String(summary.title || '').replace(/\s+/g, ' ').trim().slice(0, 255);
  if (!title) throw new Error('Source album title is empty');
  job.source_title = title;
  job.sourceSections = [...new Set((summary.suggestedSections || [])
    .map((name) => String(name || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean))];
  await pool.query(
    'UPDATE external_import_jobs SET source_title = ?, reported_total = COALESCE(?, reported_total) WHERE id = ?',
    [title, Number(summary.reportedTotal) || null, job.id]
  );
  await pool.query(
    `UPDATE projects SET
       name = IF(name = JSON_UNQUOTE(JSON_EXTRACT(meta, '$.${PENDING_IMPORT_TITLE_KEY}')), ?, name),
       meta = JSON_REMOVE(meta, '$.${PENDING_IMPORT_TITLE_KEY}')
     WHERE id = ? AND JSON_CONTAINS_PATH(meta, 'one', '$.${PENDING_IMPORT_TITLE_KEY}')`,
    [title, job.project_id]
  );
}

async function ingestBatch(job, photos, info = {}) {
  if (!photos.length) return 0;
  const useSourceSections = Array.isArray(info.sourceSections)
    && new Set(info.sourceSections.map((name) => String(name || '').trim()).filter(Boolean)).size > 1;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [state] = await conn.query('SELECT status, cancel_requested, selected_count, source_title FROM external_import_jobs WHERE id = ? FOR UPDATE', [job.id]);
    if (!state.length || state[0].cancel_requested || state[0].status !== 'running') {
      throw Object.assign(new Error('Import stopped'), { code: 'IMPORT_STOPPED' });
    }
    const [projects] = await conn.query('SELECT id FROM projects WHERE id = ? FOR UPDATE', [job.project_id]);
    if (!projects.length) throw Object.assign(new Error('Target album missing'), { code: 'PROJECT_CHANGED' });
    let sections = [];
    if (useSourceSections) {
      [sections] = await conn.query('SELECT id, name, sort_order FROM project_timeline_sections WHERE project_id = ? ORDER BY sort_order, id', [job.project_id]);
    }
    const sectionIds = new Map(sections.map((row) => [row.name.toLocaleLowerCase(), row.id]));
    let order = sections.reduce((max, row) => Math.max(max, Number(row.sort_order) + 1), 0);
    const values = [];
    for (const [index, photo] of photos.entries()) {
      const sectionName = cleanSectionName(photo.sectionName, info.title || state[0].source_title);
      const key = sectionName.toLocaleLowerCase();
      let sectionId = useSourceSections ? sectionIds.get(key) : (job.timeline_section_id || null);
      if (useSourceSections && !sectionId) {
        const [inserted] = await conn.query(
          'INSERT INTO project_timeline_sections (project_id, name, section_time, sort_order) VALUES (?, ?, ?, ?)',
          [job.project_id, sectionName, photo.sectionTime || null, order++]
        );
        sectionId = inserted.insertId;
        sectionIds.set(key, sectionId);
      }
      values.push([job.id, String(photo.id), Number(photo.sourceOrder) || Number(state[0].selected_count) + index,
        photo.captureTime || null,
        String(photo.filename || `${photo.id}.jpg`).slice(0, 180), sectionName, sectionId,
        photo.transferUrl, photo.previewUrl || photo.transferUrl]);
    }
    if (useSourceSections) {
      await conn.query("UPDATE projects SET meta = JSON_SET(COALESCE(meta, JSON_OBJECT()), '$.timelineEnabled', true) WHERE id = ?", [job.project_id]);
    }
    await conn.query(
      `INSERT INTO external_import_items
       (job_id, provider_photo_id, source_order, source_capture_time, filename, source_section_name, timeline_section_id, asset_url, preview_url)
       VALUES ? ON DUPLICATE KEY UPDATE
         asset_url = IF(status IN ('pending', 'failed'), VALUES(asset_url), asset_url),
         preview_url = IF(status IN ('pending', 'failed'), VALUES(preview_url), preview_url)`, [values]
    );
    const [[count]] = await conn.query('SELECT COUNT(*) AS total FROM external_import_items WHERE job_id = ?', [job.id]);
    await conn.query(
      `UPDATE external_import_jobs SET selected_count = ?, discovered_count = ?,
       reported_total = COALESCE(?, reported_total) WHERE id = ?`,
      [count.total, count.total, Number(info.reportedTotal) || null, job.id]
    );
    await conn.commit();
    return Number(count.total) - Number(state[0].selected_count);
  } catch (err) {
    await conn.rollback().catch(() => null);
    throw err;
  } finally { conn.release(); }
}

module.exports = { PENDING_IMPORT_TITLE_KEY, sourceFromUrl, insertJob, createJob, updateImportMetadata, ingestBatch };
