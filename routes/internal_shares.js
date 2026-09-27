const express = require('express');
const { pool } = require('../db');
const { buildMediaUrl } = require('../lib/media_access');
const { requirePermission } = require('../lib/permissions');
const {
  positiveId, resolveWorkspace, requireProjectAccess, requirePhotosAccess,
  sendWorkspaceError, WorkspaceAccessError,
} = require('../lib/workspace_access');

const router = express.Router();
const copyWorker = require('../lib/organization_copy_worker');
const DAY = 24 * 60 * 60 * 1000;

function sendError(res, err) {
  if (sendWorkspaceError(res, err)) return;
  console.error('[internal-shares]', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'INTERNAL_ERROR' });
}

function expirationFor(mode, body) {
  if (mode !== 'collaborate' && body.permanent === true) return null;
  const days = body.expiresInDays === undefined ? 30 : Number(body.expiresInDays);
  const maxDays = mode === 'collaborate' ? 90 : 365;
  if (!Number.isInteger(days) || days < 1 || days > maxDays) {
    throw new WorkspaceAccessError('INVALID_EXPIRATION', 400);
  }
  return new Date(Date.now() + days * DAY);
}

async function requireSourceEditor(workspace, unitId, db = pool) {
  if (!workspace.enabled || !unitId || workspace.unitId !== unitId) {
    throw new WorkspaceAccessError('UNIT_FORBIDDEN');
  }
  if (workspace.collegeAdmin || ['editor', 'manager'].includes(workspace.role)) return;
  throw new WorkspaceAccessError('UNIT_EDITOR_REQUIRED');
}

async function requireTarget(workspace, targetUnitId, targetUserId, db = pool) {
  const [units] = await db.query(
    'SELECT id FROM organization_units WHERE id = ? AND organization_id = ? AND archived_at IS NULL LIMIT 1',
    [targetUnitId, workspace.orgId]
  );
  if (!units.length || targetUnitId === workspace.unitId) throw new WorkspaceAccessError('INVALID_TARGET_UNIT', 400);
  if (targetUserId) {
    const [members] = await db.query(
      `SELECT 1 FROM organization_unit_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.unit_id = ? AND m.user_id = ? AND m.removed_at IS NULL
         AND u.organization_id = ? LIMIT 1`,
      [targetUnitId, targetUserId, workspace.orgId]
    );
    if (!members.length) throw new WorkspaceAccessError('TARGET_USER_NOT_IN_UNIT', 400);
  }
}

router.post('/', requirePermission('photos.view'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const workspace = await resolveWorkspace(req, conn);
    await requireSourceEditor(workspace, workspace.unitId, conn);
    const body = req.body || {};
    const mode = String(body.mode || '').trim();
    const shareType = String(body.shareType || '').trim();
    if (!['read', 'copy', 'collaborate'].includes(mode) || !['album', 'collection'].includes(shareType)) {
      throw new WorkspaceAccessError('INVALID_SHARE_MODE', 400);
    }
    const targetUnitId = positiveId(body.targetUnitId);
    const targetUserId = body.targetUserId ? positiveId(body.targetUserId) : null;
    if (!targetUnitId || (body.targetUserId && !targetUserId)) {
      throw new WorkspaceAccessError('INVALID_TARGET', 400);
    }
    await requireTarget(workspace, targetUnitId, targetUserId, conn);
    const expiresAt = expirationFor(mode, body);

    let projectId = null;
    let photoIds = [];
    if (shareType === 'album') {
      projectId = positiveId(body.projectId);
      if (!projectId) throw new WorkspaceAccessError('INVALID_PROJECT', 400);
      const project = await requireProjectAccess(req, projectId, 'read', conn);
      if (Number(project.unit_id) !== workspace.unitId) throw new WorkspaceAccessError('SOURCE_UNIT_REQUIRED');
    } else {
      photoIds = Array.from(new Set((body.photoIds || []).map(positiveId).filter(Boolean)));
      if (!photoIds.length || photoIds.length > 2000) throw new WorkspaceAccessError('INVALID_PHOTO_IDS', 400);
      const rows = await requirePhotosAccess(req, photoIds, 'read', conn);
      if (rows.some((row) => Number(row.unit_id) !== workspace.unitId)) {
        throw new WorkspaceAccessError('SOURCE_UNIT_REQUIRED');
      }
    }

    await conn.beginTransaction();
    let snapshot = null;
    let photoSnapshots = new Map();
    if (mode === 'copy') {
      if (shareType === 'album') {
        const [projects] = await conn.query(
          'SELECT name, description, event_date, meta, tags, type FROM projects WHERE id = ? AND organization_id = ? AND unit_id = ? LIMIT 1',
          [projectId, workspace.orgId, workspace.unitId]
        );
        if (!projects.length) throw new WorkspaceAccessError('SOURCE_ALBUM_NOT_FOUND', 404);
        const [sections] = await conn.query(
          'SELECT id, name, section_time, sort_order FROM project_timeline_sections WHERE project_id = ? ORDER BY sort_order, id',
          [projectId]
        );
        snapshot = { project: projects[0], sections };
      }
      const [photos] = await conn.query(
        shareType === 'album'
          ? 'SELECT ph.*, p.name AS source_album_name FROM photos ph JOIN projects p ON p.id = ph.project_id WHERE ph.project_id = ? AND ph.organization_id = ? AND ph.unit_id = ? ORDER BY ph.id FOR SHARE'
          : 'SELECT ph.*, p.name AS source_album_name FROM photos ph LEFT JOIN projects p ON p.id = ph.project_id WHERE ph.id IN (?) AND ph.organization_id = ? AND ph.unit_id = ? ORDER BY ph.id FOR SHARE',
        [shareType === 'album' ? projectId : photoIds, workspace.orgId, workspace.unitId]
      );
      if (shareType === 'collection' && photos.length !== photoIds.length) {
        throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
      }
      photoIds = photos.map((photo) => Number(photo.id));
      photoSnapshots = new Map(photos.map((photo) => [Number(photo.id), photo]));
    }
    const [created] = await conn.query(
      `INSERT INTO internal_shares
         (organization_id, source_unit_id, target_unit_id, target_user_id,
          share_type, mode, project_id, created_by, expires_at, snapshot_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [workspace.orgId, workspace.unitId, targetUnitId, targetUserId,
        shareType, mode, projectId, workspace.userId, expiresAt,
        snapshot ? JSON.stringify(snapshot) : null]
    );
    for (let offset = 0; offset < photoIds.length; offset += 400) {
      const values = photoIds.slice(offset, offset + 400).map((id) =>
        [created.insertId, id, photoSnapshots.has(id) ? JSON.stringify(photoSnapshots.get(id)) : null]);
      await conn.query('INSERT INTO internal_share_items (share_id, photo_id, snapshot_json) VALUES ?', [values]);
    }
    let copyJobId = null;
    if (mode === 'copy') {
      const [job] = await conn.query(
        `INSERT INTO organization_copy_jobs
           (share_id, organization_id, target_unit_id, requested_by, system_initiated)
         VALUES (?, ?, ?, ?, 1)`,
        [created.insertId, workspace.orgId, targetUnitId, workspace.userId]
      );
      copyJobId = job.insertId;
    }
    await conn.query(
      `INSERT INTO organization_access_audit
         (organization_id, unit_id, user_id, action, resource_type, resource_id, details)
       VALUES (?, ?, ?, 'internal_share.create', 'internal_share', ?, ?)`,
      [workspace.orgId, workspace.unitId, workspace.userId, created.insertId,
        JSON.stringify({ mode, shareType, targetUnitId, targetUserId, photoCount: photoIds.length })]
    );
    await conn.commit();
    if (copyJobId) copyWorker.wake();
    res.status(201).json({ id: created.insertId, mode, shareType, projectId,
      targetUnitId, targetUserId, expiresAt, photoCount: photoIds.length, copyJobId });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    sendError(res, err);
  } finally { conn.release(); }
});

router.get('/received', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.enabled || !workspace.unitId) return res.json([]);
    const [rows] = await pool.query(
      `SELECT s.id, s.share_type AS shareType, s.mode, s.project_id AS projectId,
              s.expires_at AS expiresAt, s.created_at AS createdAt,
              source.name AS sourceUnitName, org.name AS sourceOrganizationName,
              sharer.name AS sharedByName, p.name AS albumName,
              (SELECT COUNT(*) FROM internal_share_items si WHERE si.share_id = s.id) AS snapshotCount,
              (SELECT j.status FROM organization_copy_jobs j
               WHERE j.share_id = s.id AND j.system_initiated = 1 ORDER BY j.id DESC LIMIT 1) AS copyStatus,
              (SELECT j.result_json FROM organization_copy_jobs j
               WHERE j.share_id = s.id AND j.system_initiated = 1 ORDER BY j.id DESC LIMIT 1) AS copyResult
       FROM internal_shares s
       JOIN organization_units source ON source.id = s.source_unit_id
       JOIN organizations org ON org.id = s.organization_id
       LEFT JOIN users sharer ON sharer.id = s.created_by
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.organization_id = ? AND s.target_unit_id = ?
         AND (s.target_user_id IS NULL OR s.target_user_id = ?)
         AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > NOW())
       ORDER BY s.created_at DESC LIMIT 200`,
      [workspace.orgId, workspace.unitId, workspace.userId]
    );
    res.json(rows);
  } catch (err) { sendError(res, err); }
});

router.get('/sent', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.enabled || !workspace.unitId) return res.json([]);
    const [rows] = await pool.query(
      `SELECT s.id, s.share_type AS shareType, s.mode, s.project_id AS projectId,
              s.expires_at AS expiresAt, s.revoked_at AS revokedAt,
              s.created_at AS createdAt, target.name AS targetUnitName,
              recipient.name AS targetUserName, p.name AS albumName,
              (SELECT j.status FROM organization_copy_jobs j
               WHERE j.share_id = s.id AND j.system_initiated = 1 ORDER BY j.id DESC LIMIT 1) AS copyStatus
       FROM internal_shares s
       JOIN organization_units target ON target.id = s.target_unit_id
       LEFT JOIN users recipient ON recipient.id = s.target_user_id
       LEFT JOIN projects p ON p.id = s.project_id
       WHERE s.organization_id = ? AND s.source_unit_id = ?
       ORDER BY s.created_at DESC LIMIT 200`,
      [workspace.orgId, workspace.unitId]
    );
    res.json(rows);
  } catch (err) { sendError(res, err); }
});

router.post('/:id/copy', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    const shareId = positiveId(req.params.id);
    if (!workspace.enabled || !workspace.unitId || !shareId) {
      throw new WorkspaceAccessError('SHARE_NOT_FOUND', 404);
    }
    const [shares] = await pool.query(
      `SELECT * FROM internal_shares WHERE id = ? AND organization_id = ? AND mode = 'copy'
       AND target_unit_id = ? AND (target_user_id IS NULL OR target_user_id = ?)
       AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
      [shareId, workspace.orgId, workspace.unitId, workspace.userId]
    );
    const share = shares[0];
    if (!share) throw new WorkspaceAccessError('SHARE_NOT_FOUND', 404);
    const [automatic] = await pool.query(
      `SELECT id, status, estimated_bytes AS estimatedBytes, copied_bytes AS copiedBytes, result_json AS result
       FROM organization_copy_jobs WHERE share_id = ? AND system_initiated = 1
       ORDER BY id DESC LIMIT 1`, [shareId]
    );
    if (automatic.length) {
      if (automatic[0].status !== 'failed') return res.json(automatic[0]);
      await pool.query(
        `UPDATE organization_copy_jobs
         SET status = 'queued', manifest_json = NULL, estimated_bytes = 0,
             copied_bytes = 0, error_code = NULL
         WHERE id = ? AND status = 'failed'`, [automatic[0].id]
      );
      copyWorker.wake();
      return res.status(202).json({ ...automatic[0], status: 'queued', errorCode: null });
    }
    let targetProjectId = null;
    if (share.share_type === 'collection') {
      targetProjectId = positiveId(req.body?.targetProjectId);
      if (!targetProjectId) throw new WorkspaceAccessError('TARGET_ALBUM_REQUIRED', 400);
      const [targets] = await pool.query(
        'SELECT id FROM projects WHERE id = ? AND organization_id = ? AND unit_id = ? LIMIT 1',
        [targetProjectId, workspace.orgId, workspace.unitId]
      );
      if (!targets.length) throw new WorkspaceAccessError('TARGET_ALBUM_NOT_FOUND', 404);
    }
    const [existing] = await pool.query(
      `SELECT id, status, estimated_bytes AS estimatedBytes, copied_bytes AS copiedBytes, result_json AS result
       FROM organization_copy_jobs
       WHERE share_id = ? AND requested_by = ? AND target_project_id <=> ?
         AND status IN ('queued', 'copying', 'ready')
       ORDER BY id DESC LIMIT 1`,
      [shareId, workspace.userId, targetProjectId]
    );
    if (existing.length) return res.json(existing[0]);
    const [result] = await pool.query(
      `INSERT INTO organization_copy_jobs
         (share_id, organization_id, target_unit_id, requested_by, target_project_id)
       VALUES (?, ?, ?, ?, ?)`,
      [shareId, workspace.orgId, workspace.unitId, workspace.userId, targetProjectId]
    );
    copyWorker.wake();
    res.status(202).json({ id: result.insertId, status: 'queued', estimatedBytes: 0, copiedBytes: 0 });
  } catch (err) { sendError(res, err); }
});

router.get('/copy-jobs/:id', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    const jobId = positiveId(req.params.id);
    if (!workspace.enabled || !workspace.unitId || !jobId) {
      throw new WorkspaceAccessError('COPY_JOB_NOT_FOUND', 404);
    }
    const [rows] = await pool.query(
      `SELECT id, share_id AS shareId, status, estimated_bytes AS estimatedBytes,
              copied_bytes AS copiedBytes, result_json AS result, error_code AS errorCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM organization_copy_jobs
       WHERE id = ? AND organization_id = ? AND target_unit_id = ? AND requested_by = ? LIMIT 1`,
      [jobId, workspace.orgId, workspace.unitId, workspace.userId]
    );
    if (!rows.length) throw new WorkspaceAccessError('COPY_JOB_NOT_FOUND', 404);
    res.json(rows[0]);
  } catch (err) { sendError(res, err); }
});

router.get('/:id', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    const id = positiveId(req.params.id);
    if (!id) throw new WorkspaceAccessError('INVALID_SHARE', 400);
    const [rows] = await pool.query(
      `SELECT s.*, p.name AS albumName, source.name AS sourceUnitName,
              org.name AS sourceOrganizationName, sharer.name AS sharedByName
       FROM internal_shares s
       LEFT JOIN projects p ON p.id = s.project_id
       JOIN organization_units source ON source.id = s.source_unit_id
       JOIN organizations org ON org.id = s.organization_id
       LEFT JOIN users sharer ON sharer.id = s.created_by
       WHERE s.id = ? AND s.organization_id = ? LIMIT 1`, [id, workspace.orgId]
    );
    const share = rows[0];
    if (!share || share.revoked_at || (share.expires_at && new Date(share.expires_at) <= new Date())) {
      throw new WorkspaceAccessError('SHARE_NOT_FOUND', 404);
    }
    const recipient = Number(share.target_unit_id) === workspace.unitId
      && (!share.target_user_id || Number(share.target_user_id) === workspace.userId);
    const owner = Number(share.source_unit_id) === workspace.unitId
      && (workspace.collegeAdmin || ['editor', 'manager'].includes(workspace.role));
    if (!recipient && !owner && !workspace.collegeAdmin) throw new WorkspaceAccessError('SHARE_NOT_FOUND', 404);
    let copyResult = null;
    let copyStatus = null;
    if (share.mode === 'copy') {
      const [jobs] = await pool.query(
        `SELECT status, result_json FROM organization_copy_jobs
         WHERE share_id = ? AND system_initiated = 1 ORDER BY id DESC LIMIT 1`, [id]
      );
      copyStatus = jobs[0]?.status || null;
      copyResult = jobs[0]?.result_json || null;
      if (typeof copyResult === 'string') copyResult = JSON.parse(copyResult);
    }
    const copiedProjectId = copyStatus === 'ready' ? positiveId(copyResult?.projectId) : null;
    const canViewCopiedPhotos = recipient || workspace.collegeAdmin;
    const limit = Math.max(1, Math.min(120, Math.floor(Number(req.query.limit) || 60)));
    const offset = Math.max(0, Math.min(1000000, Math.floor(Number(req.query.offset) || 0)));
    let source = null;
    let sourceParams = [];
    let order = '';
    if (share.mode === 'copy') {
      if (copiedProjectId && canViewCopiedPhotos) {
        source = 'FROM photos ph WHERE ph.project_id = ? AND ph.organization_id = ? AND ph.unit_id = ?';
        sourceParams = [copiedProjectId, workspace.orgId, workspace.unitId];
        order = 'ORDER BY ph.created_at DESC, ph.id DESC';
      }
    } else if (share.share_type === 'album') {
      source = 'FROM photos ph WHERE ph.project_id = ? AND ph.organization_id = ?';
      sourceParams = [share.project_id, workspace.orgId];
      order = 'ORDER BY ph.created_at DESC, ph.id DESC';
    } else {
      source = `FROM internal_share_items si JOIN photos ph ON ph.id = si.photo_id
        WHERE si.share_id = ? AND ph.organization_id = ?`;
      sourceParams = [id, workspace.orgId];
      order = 'ORDER BY si.created_at, si.id';
    }
    let total = 0;
    let photos = [];
    if (source) {
      const [[count]] = await pool.query(`SELECT COUNT(*) AS total ${source}`, sourceParams);
      total = Number(count.total) || 0;
      [photos] = await pool.query(
        `SELECT ph.id, ph.project_id AS projectId, ph.title, ph.type, ph.url,
                ph.thumb_url AS thumbUrl, ph.playback_url AS playbackUrl,
                ph.tags, ph.description, ph.adjustments
         ${source} ${order} LIMIT ? OFFSET ?`, [...sourceParams, limit, offset]
      );
    }
    res.json({ id: share.id, shareType: share.share_type, mode: share.mode,
      projectId: share.mode === 'copy' ? copiedProjectId : share.project_id,
      albumName: share.albumName, copyStatus,
      sourceUnitName: share.sourceUnitName, sourceOrganizationName: share.sourceOrganizationName,
      sharedByName: share.sharedByName, createdAt: share.created_at, expiresAt: share.expires_at,
      total, offset, hasMore: offset + photos.length < total,
      photos: photos.map((photo) => ({ ...photo,
        url: buildMediaUrl(photo.url, { userId: workspace.userId, photoId: photo.id }),
        thumbUrl: buildMediaUrl(photo.thumbUrl, { userId: workspace.userId, photoId: photo.id }),
        playbackUrl: buildMediaUrl(photo.playbackUrl, { userId: workspace.userId, photoId: photo.id }) })) });
  } catch (err) { sendError(res, err); }
});

router.post('/:id/revoke', requirePermission('photos.view'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const workspace = await resolveWorkspace(req, conn);
    const id = positiveId(req.params.id);
    if (!id) throw new WorkspaceAccessError('INVALID_SHARE', 400);
    const [rows] = await conn.query('SELECT source_unit_id FROM internal_shares WHERE id = ? AND organization_id = ? LIMIT 1',
      [id, workspace.orgId]);
    if (!rows.length) throw new WorkspaceAccessError('SHARE_NOT_FOUND', 404);
    await requireSourceEditor(workspace, Number(rows[0].source_unit_id), conn);
    await conn.beginTransaction();
    await conn.query('UPDATE internal_shares SET revoked_at = NOW() WHERE id = ? AND revoked_at IS NULL', [id]);
    await conn.query(
      `INSERT INTO organization_access_audit
         (organization_id, unit_id, user_id, action, resource_type, resource_id)
       VALUES (?, ?, ?, 'internal_share.revoke', 'internal_share', ?)`,
      [workspace.orgId, workspace.unitId, workspace.userId, id]
    );
    await conn.commit();
    res.json({ revoked: true });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    sendError(res, err);
  } finally { conn.release(); }
});

module.exports = router;
