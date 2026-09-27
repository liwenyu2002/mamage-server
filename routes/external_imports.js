const express = require('express');
const { randomUUID } = require('crypto');
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');
const { requireProjectAccess, sendWorkspaceError } = require('../lib/workspace_access');
const { parsePhotoPlusUrl, scanPhotoPlus } = require('../lib/external_gallery_scan');
const { scanFromTemplate } = require('../lib/external_gallery_templates');
const { parsePublicHttpsUrl } = require('../lib/public_remote_fetch');
const worker = require('../lib/external_import_worker');

const router = express.Router();
const SCAN_TTL_MS = 15 * 60 * 1000;
const scans = new Map();
const activeUsers = new Set();
let activeScans = 0;

function cleanupScans() {
  for (const [id, scan] of scans) if (scan.expiresAt <= Date.now()) scans.delete(id);
  while (scans.size > 20) scans.delete(scans.keys().next().value);
}

const scanCleanupTimer = setInterval(cleanupScans, 5 * 60 * 1000);
scanCleanupTimer.unref?.();

function handleError(res, err) {
  if (sendWorkspaceError(res, err)) return;
  const status = Number(err?.status) || 500;
  if (status >= 500) console.error('[external-import]', err?.message || err);
  res.status(status).json({ error: status >= 500 ? 'EXTERNAL_IMPORT_FAILED' : 'INVALID_REQUEST', message: status >= 500 ? '操作失败，请稍后重试' : err.message });
}

router.post('/scan', requirePermission('upload.photo'), async (req, res) => {
  const parsed = parsePhotoPlusUrl(req.body?.url);
  if (!parsed && !parsePublicHttpsUrl(req.body?.url)) {
    return res.status(400).json({ error: 'UNSUPPORTED_URL', message: '请填写公开的 HTTPS 相册链接' });
  }
  const userId = Number(req.user.id);
  if (activeScans >= 1 || activeUsers.has(userId)) {
    return res.status(429).json({ error: 'SCAN_BUSY', message: '正在扫描相册，请稍后再试' });
  }
  activeScans += 1;
  activeUsers.add(userId);
  try {
    cleanupScans();
    const result = parsed ? await scanPhotoPlus(parsed.canonicalUrl) : await scanFromTemplate(req.body.url);
    const scanId = randomUUID();
    scans.set(scanId, { ...result, userId, expiresAt: Date.now() + SCAN_TTL_MS });
    cleanupScans();
    return res.json({
      scanId,
      provider: result.provider,
      sourceUrl: result.sourceUrl,
      title: result.title,
      suggestedAlbumTitle: result.suggestedAlbumTitle,
      suggestedSections: result.suggestedSections,
      templateSource: result.templateSource,
      reportedTotal: result.reportedTotal,
      scannedCount: result.scannedCount,
      complete: result.complete,
      quality: result.quality,
      expiresAt: new Date(Date.now() + SCAN_TTL_MS).toISOString(),
      photos: result.photos.map(({ id, filename, previewUrl, sectionName, width, height, watermarked }) => ({ id, filename, previewUrl, sectionName, width, height, watermarked })),
    });
  } catch (err) {
    return handleError(res, err);
  } finally {
    activeScans -= 1;
    activeUsers.delete(userId);
  }
});

router.post('/jobs', requirePermission('upload.photo'), async (req, res) => {
  cleanupScans();
  const scan = scans.get(String(req.body?.scanId || ''));
  if (!scan || scan.userId !== Number(req.user.id)) {
    return res.status(400).json({ error: 'SCAN_EXPIRED', message: '扫描结果已过期，请重新扫描' });
  }
  const projectId = Number(req.body?.projectId);
  const sectionId = req.body?.timelineSectionId ? Number(req.body.timelineSectionId) : null;
  const ids = Array.isArray(req.body?.photoIds) ? [...new Set(req.body.photoIds.map(String))] : [];
  const validId = scan.provider === 'photoplus' ? /^\d+$/ : /^[a-f0-9]{32}$/;
  if (!Number.isSafeInteger(projectId) || projectId <= 0 || ids.length < 1 || ids.length > 1000 || ids.some((id) => !validId.test(id))) {
    return res.status(400).json({ error: 'INVALID_SELECTION', message: '请选择要转存的照片和目标相册' });
  }
  if (sectionId !== null && (!Number.isSafeInteger(sectionId) || sectionId <= 0)) {
    return res.status(400).json({ error: 'INVALID_SECTION', message: '环节无效' });
  }
  const byId = new Map(scan.photos.map((photo) => [photo.id, photo]));
  if (ids.some((id) => !byId.has(id))) return res.status(400).json({ error: 'INVALID_SELECTION', message: '所选照片不属于扫描结果' });
  if (req.body?.confirmRights !== true) {
    return res.status(400).json({ error: 'CONFIRM_REQUIRED', message: '请确认已获得照片转存授权' });
  }
  const sectionMappings = req.body?.sectionMappings && typeof req.body.sectionMappings === 'object' && !Array.isArray(req.body.sectionMappings)
    ? req.body.sectionMappings : {};
  const sourceSections = new Set(scan.suggestedSections || []);
  if (Object.keys(sectionMappings).some((name) => !sourceSections.has(name))) {
    return res.status(400).json({ error: 'INVALID_SECTION_MAPPING', message: '来源环节不在扫描结果中' });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const project = await requireProjectAccess(req, projectId, 'upload', conn);
    if (Number(project.organization_id) !== Number(req.user.organization_id)) {
      throw Object.assign(new Error('目标相册不存在'), { status: 404 });
    }
    if (sectionId !== null) {
      const [sections] = await conn.query('SELECT id FROM project_timeline_sections WHERE id = ? AND project_id = ? LIMIT 1', [sectionId, projectId]);
      if (!sections.length) throw Object.assign(new Error('所选环节不在当前相册中'), { status: 400 });
    }
    const mappedIds = [...new Set(Object.values(sectionMappings).filter((value) => value !== '' && value !== null).map(Number))];
    if (mappedIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) throw Object.assign(new Error('环节映射无效'), { status: 400 });
    if (mappedIds.length) {
      const [mapped] = await conn.query('SELECT id FROM project_timeline_sections WHERE project_id = ? AND id IN (?)', [projectId, mappedIds]);
      if (mapped.length !== mappedIds.length) throw Object.assign(new Error('环节映射不属于当前相册'), { status: 400 });
    }
    const [job] = await conn.query(
      `INSERT INTO external_import_jobs
       (provider, source_url, source_title, source_quality, organization_id, unit_id, project_id, timeline_section_id, requested_by, selected_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [scan.provider, scan.sourceUrl, scan.title, scan.quality, project.organization_id, project.unit_id, projectId, sectionId, req.user.id, ids.length]
    );
    const values = ids.map((id) => {
      const photo = byId.get(id);
      return [job.insertId, id, photo.filename, photo.sectionName || null,
        photo.sectionName && Object.hasOwn(sectionMappings, photo.sectionName) && sectionMappings[photo.sectionName]
          ? Number(sectionMappings[photo.sectionName]) : null,
        photo.transferUrl, photo.previewUrl];
    });
    await conn.query(
      'INSERT INTO external_import_items (job_id, provider_photo_id, filename, source_section_name, timeline_section_id, asset_url, preview_url) VALUES ?',
      [values]
    );
    await conn.commit();
    worker.wake();
    return res.status(201).json({ jobId: job.insertId, status: 'queued', selectedCount: ids.length });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => null);
    return handleError(res, err);
  } finally {
    if (conn) conn.release();
  }
});

router.get('/jobs', requirePermission('upload.photo'), async (req, res) => {
  const projectId = Number(req.query.projectId);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return res.status(400).json({ error: 'INVALID_PROJECT' });
  try {
    await requireProjectAccess(req, projectId, 'read');
    const [rows] = await pool.query(
      `SELECT id, source_title AS sourceTitle, status, selected_count AS selectedCount,
              cancel_requested AS cancelRequested, created_at AS createdAt
       FROM external_import_jobs WHERE requested_by = ? AND project_id = ? ORDER BY id DESC LIMIT 5`,
      [req.user.id, projectId]
    );
    return res.json({ jobs: rows });
  } catch (err) { return handleError(res, err); }
});

router.get('/jobs/:id', requirePermission('upload.photo'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'INVALID_JOB' });
  try {
    const [jobs] = await pool.query(
      `SELECT id, source_title AS sourceTitle, source_url AS sourceUrl, project_id AS projectId,
              status, selected_count AS selectedCount, cancel_requested AS cancelRequested,
              created_at AS createdAt, updated_at AS updatedAt
       FROM external_import_jobs WHERE id = ? AND requested_by = ? LIMIT 1`,
      [id, req.user.id]
    );
    if (!jobs.length) return res.status(404).json({ error: 'JOB_NOT_FOUND' });
    await requireProjectAccess(req, jobs[0].projectId, 'read');
    const [counts] = await pool.query(
      'SELECT status, COUNT(*) AS count FROM external_import_items WHERE job_id = ? GROUP BY status', [id]
    );
    const [issues] = await pool.query(
      `SELECT provider_photo_id AS sourcePhotoId, filename, status, error_code AS errorCode
      FROM external_import_items WHERE job_id = ? AND status IN ('failed', 'skipped') ORDER BY id DESC LIMIT 10`, [id]
    );
    const [active] = await pool.query(
      "SELECT filename FROM external_import_items WHERE job_id = ? AND status = 'running' ORDER BY id LIMIT 1", [id]
    );
    return res.json({ ...jobs[0], counts: Object.fromEntries(counts.map((row) => [row.status, Number(row.count)])), activeFileName: active[0]?.filename || null, issues });
  } catch (err) { return handleError(res, err); }
});

router.post('/jobs/:id/cancel', requirePermission('upload.photo'), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) return res.status(400).json({ error: 'INVALID_JOB' });
  try {
    const [result] = await pool.query(
      `UPDATE external_import_jobs SET cancel_requested = 1
       WHERE id = ? AND requested_by = ? AND status IN ('queued', 'running')`, [id, req.user.id]
    );
    return res.json({ ok: true, cancelRequested: Boolean(result.affectedRows) });
  } catch (err) { return handleError(res, err); }
});

module.exports = router;
