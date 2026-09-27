const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { pool, buildUploadUrl } = require('../db');
const { buildMediaUrl } = require('../lib/media_access');
const { requirePermission } = require('../lib/permissions');
const {
    resolveWorkspace, requireProjectAccess, requirePhotosAccess, sendWorkspaceError,
    WorkspaceAccessError,
} = require('../lib/workspace_access');

function normalizeLimit(raw, fallback) {
    let limit = parseInt(raw, 10);
    if (Number.isNaN(limit) || limit <= 0) limit = fallback;
    if (limit > 200) limit = 200;
    return limit;
}

function normalizeOffset(raw) {
    let offset = parseInt(raw, 10);
    if (Number.isNaN(offset) || offset < 0) offset = 0;
    if (offset > 1000000) offset = 1000000;
    return offset;
}

function generateCode() {
    // 24 chars-ish, URL safe
    return crypto.randomBytes(18).toString('base64url');
}

async function insertShareLinkWithRetry(conn, row, maxAttempts = 5) {
    let lastErr = null;
    for (let i = 0; i < maxAttempts; i++) {
        const code = generateCode();
        try {
            const [res] = await conn.query(
                `INSERT INTO share_links
                    (code, share_type, project_id, title, note, created_by, organization_id, unit_id, sync_mode, expires_at)
                 VALUES
					(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                ,
                [
                    code,
                    row.share_type,
                    row.project_id || null,
                    row.title || null,
                    row.note || null,
                    row.created_by,
                    row.organization_id,
                    row.unit_id || null,
                    row.sync_mode || 'approval',
                    row.expires_at || null
                ]
            );
            return { id: res.insertId, code };
        } catch (e) {
            lastErr = e;
            // ER_DUP_ENTRY: collision on code, retry
            if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) continue;
            throw e;
        }
    }
    throw lastErr || new Error('failed to generate unique share code');
}

// 创建分享（登录态）
// POST /api/share
// body: { shareType: 'project'|'collection', projectId?, photoIds?, title?, note?, expiresInSeconds? }
router.post('/', requirePermission('photos.view'), async (req, res) => {
    let conn;
    try {
        const body = req.body || {};
        const shareType = String(body.shareType || body.share_type || '').trim();
        if (shareType !== 'project' && shareType !== 'collection') {
            return res.status(400).json({ error: 'INVALID_PARAM', message: 'shareType must be project or collection' });
        }

        const orgId = req.user && req.user.organization_id !== undefined && req.user.organization_id !== null
            ? Number(req.user.organization_id)
            : null;
        if (orgId === null || Number.isNaN(orgId)) {
            return res.status(400).json({ error: 'INVALID_USER', message: 'missing organization_id' });
        }

        const createdBy = req.user && req.user.id ? Number(req.user.id) : null;
        if (!createdBy) return res.status(401).json({ error: 'UNAUTHORIZED' });
        const workspace = await resolveWorkspace(req);
        if (workspace.enabled && (!workspace.unitId || (!workspace.collegeAdmin && !['editor', 'manager'].includes(workspace.role)))) {
            throw new WorkspaceAccessError('UNIT_EDITOR_REQUIRED');
        }
        const syncMode = String(body.syncMode || 'approval').trim();
        if (!['approval', 'automatic'].includes(syncMode)) throw new WorkspaceAccessError('INVALID_SYNC_MODE', 400);
        if (workspace.enabled && syncMode === 'automatic'
            && !workspace.collegeAdmin && workspace.role !== 'manager') {
            throw new WorkspaceAccessError('UNIT_MANAGER_REQUIRED');
        }

        const title = body.title !== undefined ? String(body.title).trim() : null;
        const note = body.note !== undefined ? String(body.note).trim() : null;

        let expiresAt = workspace.enabled ? new Date(Date.now() + 30 * 24 * 3600 * 1000) : null;
        if (body.expiresInSeconds !== undefined && body.expiresInSeconds !== null && String(body.expiresInSeconds).trim() !== '') {
            let seconds = parseInt(body.expiresInSeconds, 10);
            if (Number.isNaN(seconds) || seconds <= 0) {
                return res.status(400).json({ error: 'INVALID_PARAM', message: 'expiresInSeconds must be a positive integer' });
            }
            // hard cap: 365 days
            if (seconds > 365 * 24 * 3600) seconds = 365 * 24 * 3600;
            expiresAt = new Date(Date.now() + seconds * 1000);
        }

        conn = await pool.getConnection();
        await conn.beginTransaction();

        let projectId = null;
        let photoIds = null;

        if (shareType === 'project') {
            projectId = body.projectId !== undefined && body.projectId !== null ? parseInt(body.projectId, 10) : null;
            if (!projectId || Number.isNaN(projectId)) {
                await conn.rollback();
                conn.release(); conn = null;
                return res.status(400).json({ error: 'INVALID_PARAM', message: 'projectId is required for project share' });
            }

            const [projRows] = await conn.query(
                'SELECT id FROM projects WHERE id = ? AND organization_id = ? LIMIT 1',
                [projectId, orgId]
            );
            if (!projRows || projRows.length === 0) {
                await conn.rollback();
                conn.release(); conn = null;
                return res.status(404).json({ error: 'NOT_FOUND', message: 'project not found' });
            }
            if (workspace.enabled) {
                const project = await requireProjectAccess(req, projectId, 'read', conn);
                if (Number(project.unit_id) !== workspace.unitId) throw new WorkspaceAccessError('SOURCE_UNIT_REQUIRED');
            }
        }

        if (shareType === 'collection') {
            const raw = Array.isArray(body.photoIds) ? body.photoIds : [];
            photoIds = raw
                .map((n) => parseInt(n, 10))
                .filter((n) => Number.isFinite(n) && n > 0);
            // de-dup
            photoIds = Array.from(new Set(photoIds));

            if (!photoIds.length) {
                await conn.rollback();
                conn.release(); conn = null;
                return res.status(400).json({ error: 'INVALID_PARAM', message: 'photoIds must be a non-empty array for collection share' });
            }
            if (workspace.enabled) {
                const sourcePhotos = await requirePhotosAccess(req, photoIds, 'read', conn);
                if (sourcePhotos.some((photo) => Number(photo.unit_id) !== workspace.unitId)) {
                    throw new WorkspaceAccessError('SOURCE_UNIT_REQUIRED');
                }
            }

            const [rows] = await conn.query(
                'SELECT id FROM photos WHERE id IN (?) AND organization_id = ?',
                [photoIds, orgId]
            );
            const found = new Set((rows || []).map((r) => r.id));
            const missing = photoIds.filter((id) => !found.has(id));
            if (missing.length) {
                await conn.rollback();
                conn.release(); conn = null;
                return res.status(404).json({ error: 'NOT_FOUND', message: 'some photos not found', missingPhotoIds: missing });
            }
        }

        const inserted = await insertShareLinkWithRetry(conn, {
            share_type: shareType,
            project_id: projectId,
            title,
            note,
            created_by: createdBy,
            organization_id: orgId,
            unit_id: workspace.enabled ? workspace.unitId : null,
            sync_mode: syncMode,
            expires_at: expiresAt
        });

        if (shareType === 'collection') {
            // bulk insert items
            const values = photoIds.map((photoId, idx) => [inserted.id, photoId, idx]);
            await conn.query(
                'INSERT INTO share_link_items (share_id, photo_id, sort_order) VALUES ?',
                [values]
            );
        } else if (workspace.enabled && syncMode === 'approval') {
            const [currentPhotos] = await conn.query(
                'SELECT id FROM photos WHERE project_id = ? AND organization_id = ? ORDER BY id',
                [projectId, orgId]
            );
            for (let offset = 0; offset < currentPhotos.length; offset += 400) {
                const values = currentPhotos.slice(offset, offset + 400)
                    .map((photo, index) => [inserted.id, photo.id, offset + index]);
                await conn.query('INSERT INTO share_link_items (share_id, photo_id, sort_order) VALUES ?', [values]);
            }
        }

        await conn.commit();
        conn.release();
        conn = null;

        res.json({
            code: inserted.code,
            shareType,
            syncMode,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            url: `/api/share/${inserted.code}`
        });
    } catch (err) {
        if (conn) {
            try { await conn.rollback(); conn.release(); } catch (_) { }
        }
        if (sendWorkspaceError(res, err)) return;
        console.error('[POST /api/share] error:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// 撤销/软删除分享（登录态）
// POST /api/share/:code/revoke
router.post('/:code/revoke', requirePermission('photos.view'), async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        if (!code) return res.status(400).json({ error: 'INVALID_PARAM' });

        const orgId = req.user && req.user.organization_id !== undefined && req.user.organization_id !== null
            ? Number(req.user.organization_id)
            : null;
        const userId = req.user && req.user.id ? Number(req.user.id) : null;
        if (!userId) return res.status(401).json({ error: 'UNAUTHORIZED' });
        if (orgId === null || Number.isNaN(orgId)) return res.status(400).json({ error: 'INVALID_USER' });

        const workspace = await resolveWorkspace(req);
        const canManageUnit = workspace.enabled && workspace.unitId
            && (workspace.collegeAdmin || workspace.role === 'manager');

        const [result] = await pool.query(
            `UPDATE share_links SET revoked_at = NOW()
             WHERE code = ? AND organization_id = ? AND revoked_at IS NULL
               AND (created_by = ? OR (? = 1 AND unit_id = ?))`,
            [code, orgId, userId, canManageUnit ? 1 : 0, workspace.unitId || 0]
        );

        if (!result || result.affectedRows === 0) {
            return res.status(404).json({ error: 'NOT_FOUND', message: 'share not found or already revoked' });
        }

        res.json({ ok: true });
    } catch (err) {
        if (sendWorkspaceError(res, err)) return;
        console.error('[POST /api/share/:code/revoke] error:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

router.get('/mine', requirePermission('photos.view'), async (req, res) => {
    try {
        const workspace = await resolveWorkspace(req);
        if (!workspace.enabled || !workspace.unitId) return res.json([]);
        const [rows] = await pool.query(
            `SELECT s.code, s.share_type AS shareType, s.title, s.project_id AS projectId,
                    s.sync_mode AS syncMode, s.expires_at AS expiresAt, s.created_at AS createdAt,
                    p.name AS albumName,
                    CASE WHEN s.share_type = 'project' AND s.sync_mode = 'approval'
                      THEN (SELECT COUNT(*) FROM photos ph
                            LEFT JOIN share_link_items si ON si.share_id = s.id AND si.photo_id = ph.id
                            WHERE ph.project_id = s.project_id AND ph.organization_id = s.organization_id
                              AND ph.unit_id = s.unit_id AND si.photo_id IS NULL)
                      ELSE 0 END AS pendingCount
             FROM share_links s LEFT JOIN projects p ON p.id = s.project_id
             WHERE s.organization_id = ? AND s.unit_id = ? AND s.revoked_at IS NULL
               AND (s.expires_at IS NULL OR s.expires_at > NOW())
             ORDER BY s.created_at DESC LIMIT 100`,
            [workspace.orgId, workspace.unitId]
        );
        res.json(rows);
    } catch (err) {
        if (!sendWorkspaceError(res, err)) res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
});

async function requireShareManager(req, code) {
    const workspace = await resolveWorkspace(req);
    if (!workspace.enabled || !workspace.unitId
        || (!workspace.collegeAdmin && workspace.role !== 'manager')) {
        throw new WorkspaceAccessError('UNIT_MANAGER_REQUIRED');
    }
    const [rows] = await pool.query(
        `SELECT id, project_id, share_type, sync_mode FROM share_links
         WHERE code = ? AND organization_id = ? AND unit_id = ?
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > NOW()) LIMIT 1`,
        [code, workspace.orgId, workspace.unitId]
    );
    if (!rows.length) throw new WorkspaceAccessError('SHARE_NOT_FOUND', 404);
    return { share: rows[0], workspace };
}

router.get('/:code/pending', requirePermission('photos.view'), async (req, res) => {
    try {
        const { share, workspace } = await requireShareManager(req, String(req.params.code || ''));
        if (share.share_type !== 'project' || share.sync_mode !== 'approval') {
            return res.json({ photos: [] });
        }
        const [rows] = await pool.query(
            `SELECT p.id, p.title, p.thumb_url AS thumbUrl, p.created_at AS createdAt
             FROM photos p LEFT JOIN share_link_items si ON si.share_id = ? AND si.photo_id = p.id
             WHERE p.project_id = ? AND p.organization_id = ? AND p.unit_id = ? AND si.photo_id IS NULL
             ORDER BY p.created_at DESC LIMIT 500`,
            [share.id, share.project_id, workspace.orgId, workspace.unitId]
        );
        res.json({ photos: rows.map((photo) => ({ ...photo,
            thumbUrl: photo.thumbUrl ? buildMediaUrl(photo.thumbUrl,
                { userId: req.user.id, photoId: photo.id }) : null })) });
    } catch (err) {
        if (!sendWorkspaceError(res, err)) res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
});

router.post('/:code/approve', requirePermission('photos.view'), async (req, res) => {
    try {
        const { share, workspace } = await requireShareManager(req, String(req.params.code || ''));
        if (share.share_type !== 'project' || share.sync_mode !== 'approval') {
            throw new WorkspaceAccessError('SHARE_NOT_APPROVAL_MODE', 400);
        }
        const ids = Array.from(new Set((req.body?.photoIds || [])
            .map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)));
        if (!ids.length || ids.length > 500) throw new WorkspaceAccessError('INVALID_PHOTO_IDS', 400);
        const [rows] = await pool.query(
            `SELECT id FROM photos WHERE id IN (?) AND project_id = ?
               AND organization_id = ? AND unit_id = ?`,
            [ids, share.project_id, workspace.orgId, workspace.unitId]
        );
        if (rows.length !== ids.length) throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
        const values = ids.map((id, index) => [share.id, id, index]);
        await pool.query('INSERT IGNORE INTO share_link_items (share_id, photo_id, sort_order) VALUES ?', [values]);
        res.json({ approved: ids.length });
    } catch (err) {
        if (!sendWorkspaceError(res, err)) res.status(500).json({ error: 'INTERNAL_ERROR' });
    }
});

// 公开访问分享（无需登录）
// GET /api/share/:code?limit=100&offset=0
router.get('/:code', async (req, res) => {
    try {
        const code = String(req.params.code || '').trim();
        if (!code) return res.status(400).json({ error: 'INVALID_PARAM' });

        const [rows] = await pool.query(
            `
                SELECT
                    s.*, 
                    u.name AS creatorName
                FROM share_links s
                LEFT JOIN users u ON s.created_by = u.id
                WHERE s.code = ?
                LIMIT 1
            `,
            [code]
        );
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'NOT_FOUND' });

        const share = rows[0];
        const expiresAtIso = share.expires_at ? new Date(share.expires_at).toISOString() : null;
        const createdAtIso = share.created_at ? new Date(share.created_at).toISOString() : null;
        const revokedAtIso = share.revoked_at ? new Date(share.revoked_at).toISOString() : null;
        const remainingSeconds = share.expires_at
            ? Math.max(0, Math.floor((new Date(share.expires_at).getTime() - Date.now()) / 1000))
            : null;

        if (share.revoked_at) {
            return res.status(410).json({
                error: 'REVOKED',
                message: '链接已撤销',
                code: share.code,
                shareType: share.share_type,
                title: share.title || null,
                note: share.note || null,
                createdBy: share.created_by || null,
                creatorName: share.creatorName || null,
                createdAt: createdAtIso,
                expiresAt: expiresAtIso,
                revokedAt: revokedAtIso,
                remainingSeconds: 0
            });
        }

        if (share.expires_at && new Date(share.expires_at).getTime() <= Date.now()) {
            return res.status(410).json({
                error: 'EXPIRED',
                message: '链接已过期',
                code: share.code,
                shareType: share.share_type,
                title: share.title || null,
                note: share.note || null,
                createdBy: share.created_by || null,
                creatorName: share.creatorName || null,
                createdAt: createdAtIso,
                expiresAt: expiresAtIso,
                revokedAt: null,
                remainingSeconds: 0
            });
        }

        const limit = normalizeLimit(req.query.limit, 100);
        const offset = normalizeOffset(req.query.offset);

        let photos = [];
        let timelineSections = [];

        if (share.share_type === 'project') {
            try {
                const [sectionRows] = await pool.query(
                    `SELECT id, project_id AS projectId, name, section_time AS sectionTime, sort_order AS sortOrder
                     FROM project_timeline_sections
                     WHERE project_id = ?
                     ORDER BY sort_order ASC, id ASC`,
                    [share.project_id]
                );
                timelineSections = sectionRows || [];
            } catch (e) {
                timelineSections = [];
            }
            const [pRows] = await pool.query(
                `
						SELECT
							p.id,
							p.uuid,
							p.project_id      AS projectId,
							p.timeline_section_id AS timelineSectionId,
							pts.name          AS timelineSectionName,
							pts.section_time  AS timelineSectionTime,
							p.url,
							p.thumb_url       AS thumbUrl,
							p.public_download_url AS publicDownloadUrl,
						p.playback_url    AS playbackUrl,
						p.title,
						p.description,
						p.tags,
						p.type,
						p.photographer_id AS photographerId,
						u.name            AS photographerName,
						p.created_at      AS createdAt,
						p.updated_at      AS updatedAt
						FROM photos p
						LEFT JOIN users u ON p.photographer_id = u.id
						LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
						${share.unit_id && share.sync_mode === 'approval'
                            ? 'JOIN share_link_items approved ON approved.photo_id = p.id AND approved.share_id = ?' : ''}
						WHERE p.project_id = ? AND p.organization_id = ?
                        ${share.unit_id ? 'AND p.unit_id = ?' : ''}
					ORDER BY p.created_at DESC
					LIMIT ? OFFSET ?
				`,
                [...(share.unit_id && share.sync_mode === 'approval' ? [share.id] : []),
                    share.project_id, share.organization_id,
                    ...(share.unit_id ? [share.unit_id] : []), limit, offset]
            );
            photos = pRows || [];
        } else {
            const [pRows] = await pool.query(
                `
					SELECT
							p.id,
							p.uuid,
							p.project_id      AS projectId,
							p.timeline_section_id AS timelineSectionId,
							pts.name          AS timelineSectionName,
							pts.section_time  AS timelineSectionTime,
							p.url,
						p.thumb_url       AS thumbUrl,
						p.public_download_url AS publicDownloadUrl,
						p.playback_url    AS playbackUrl,
						p.title,
						p.description,
						p.tags,
						p.type,
						p.photographer_id AS photographerId,
						u.name            AS photographerName,
						p.created_at      AS createdAt,
						p.updated_at      AS updatedAt,
						s.sort_order      AS sortOrder
						FROM share_link_items s
						INNER JOIN photos p ON s.photo_id = p.id
						LEFT JOIN users u ON p.photographer_id = u.id
						LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
						WHERE s.share_id = ? AND p.organization_id = ?
                        ${share.unit_id ? 'AND p.unit_id = ?' : ''}
					ORDER BY s.sort_order ASC, s.id ASC
					LIMIT ? OFFSET ?
				`,
                [share.id, share.organization_id,
                    ...(share.unit_id ? [share.unit_id] : []), limit, offset]
            );
            photos = pRows || [];
        }

        const mapped = photos.map((p) => ({
            ...p,
            url: (share.unit_id && p.type !== 'video'
                ? buildMediaUrl(p.publicDownloadUrl || p.thumbUrl, { shareId: share.id, photoId: p.id })
                : share.unit_id && p.type === 'video'
                    ? buildMediaUrl(p.playbackUrl || p.thumbUrl, { shareId: share.id, photoId: p.id })
                    : buildUploadUrl(p.url)),
            thumbUrl: p.thumbUrl ? buildMediaUrl(p.thumbUrl, { shareId: share.id, photoId: p.id }) : null,
            publicDownloadUrl: p.publicDownloadUrl ? buildMediaUrl(p.publicDownloadUrl, { shareId: share.id, photoId: p.id }) : null,
            playbackUrl: p.playbackUrl ? buildMediaUrl(p.playbackUrl, { shareId: share.id, photoId: p.id }) : null,
            playback_url: p.playbackUrl ? buildMediaUrl(p.playbackUrl, { shareId: share.id, photoId: p.id }) : null,
        }));

        res.json({
            code: share.code,
            shareType: share.share_type,
            title: share.title || null,
            note: share.note || null,
            createdBy: share.created_by || null,
            creatorName: share.creatorName || null,
            createdAt: createdAtIso,
            expiresAt: expiresAtIso,
            revokedAt: revokedAtIso,
            remainingSeconds,
            timelineSections,
            photos: mapped,
            limit,
            offset
        });
    } catch (err) {
        console.error('[GET /api/share/:code] error:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

module.exports = router;
