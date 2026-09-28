const { pool } = require('../db');
const { requireProjectAccess } = require('./workspace_access');
const { parsePhotoPlusUrl } = require('./external_gallery_scan');
const { parsePublicHttpsUrl } = require('./public_remote_fetch');

function sourceFromUrl(rawUrl) {
  const photoPlus = parsePhotoPlusUrl(rawUrl);
  const publicUrl = photoPlus ? null : parsePublicHttpsUrl(rawUrl);
  if (!photoPlus && !publicUrl) return null;
  const sourceUrl = photoPlus?.canonicalUrl || publicUrl.href;
  if (sourceUrl.length > 512) return null;
  return {
    provider: photoPlus ? 'photoplus' : 'generic',
    sourceUrl,
    title: photoPlus ? `PhotoPlus ${photoPlus.activityNo}` : publicUrl.hostname,
  };
}

async function insertJob(conn, { source, projectId, organizationId, unitId, requestedBy }) {
  const [result] = await conn.query(
    `INSERT INTO external_import_jobs
     (provider, source_url, source_title, source_quality, organization_id, unit_id,
      project_id, requested_by, selected_count, scan_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending')`,
    [source.provider, source.sourceUrl, source.title,
      source.provider === 'photoplus' ? 'watermarked_original_view' : 'source_link_unverified',
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

async function ingestBatch(job, photos, info = {}) {
  if (!photos.length) return 0;
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [state] = await conn.query('SELECT status, cancel_requested, selected_count, source_title FROM external_import_jobs WHERE id = ? FOR UPDATE', [job.id]);
    if (!state.length || state[0].cancel_requested || state[0].status !== 'running') {
      throw Object.assign(new Error('Import stopped'), { code: 'IMPORT_STOPPED' });
    }
    const [projects] = await conn.query('SELECT id FROM projects WHERE id = ? FOR UPDATE', [job.project_id]);
    if (!projects.length) throw Object.assign(new Error('Target album missing'), { code: 'PROJECT_CHANGED' });
    const [sections] = await conn.query('SELECT id, name, sort_order FROM project_timeline_sections WHERE project_id = ? ORDER BY sort_order, id', [job.project_id]);
    const sectionIds = new Map(sections.map((row) => [row.name.toLocaleLowerCase(), row.id]));
    let order = sections.reduce((max, row) => Math.max(max, Number(row.sort_order) + 1), 0);
    const values = [];
    for (const [index, photo] of photos.entries()) {
      const sectionName = cleanSectionName(photo.sectionName, info.title || state[0].source_title);
      const key = sectionName.toLocaleLowerCase();
      let sectionId = sectionIds.get(key);
      if (!sectionId) {
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
    await conn.query("UPDATE projects SET meta = JSON_SET(COALESCE(meta, JSON_OBJECT()), '$.timelineEnabled', true) WHERE id = ?", [job.project_id]);
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

module.exports = { sourceFromUrl, insertJob, createJob, ingestBatch };
