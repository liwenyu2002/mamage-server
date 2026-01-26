const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const { pool, buildUploadUrl } = require('../db');
const { requirePermission } = require('../lib/permissions');

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
					(code, share_type, project_id, title, note, created_by, organization_id, expires_at)
				 VALUES
					(?, ?, ?, ?, ?, ?, ?, ?)`
                ,
                [
                    code,
                    row.share_type,
                    row.project_id || null,
                    row.title || null,
                    row.note || null,
                    row.created_by,
                    row.organization_id,
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

        const title = body.title !== undefined ? String(body.title).trim() : null;
        const note = body.note !== undefined ? String(body.note).trim() : null;

        let expiresAt = null;
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
                return res.status(400).json({ error: 'INVALID_PARAM', message: 'projectId is required for project share' });
            }

            const [projRows] = await conn.query(
                'SELECT id FROM projects WHERE id = ? AND organization_id = ? LIMIT 1',
                [projectId, orgId]
            );
            if (!projRows || projRows.length === 0) {
                await conn.rollback();
                return res.status(404).json({ error: 'NOT_FOUND', message: 'project not found' });
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
                return res.status(400).json({ error: 'INVALID_PARAM', message: 'photoIds must be a non-empty array for collection share' });
            }

            const [rows] = await conn.query(
                'SELECT id FROM photos WHERE id IN (?) AND organization_id = ?',
                [photoIds, orgId]
            );
            const found = new Set((rows || []).map((r) => r.id));
            const missing = photoIds.filter((id) => !found.has(id));
            if (missing.length) {
                await conn.rollback();
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
            expires_at: expiresAt
        });

        if (shareType === 'collection') {
            // bulk insert items
            const values = photoIds.map((photoId, idx) => [inserted.id, photoId, idx]);
            await conn.query(
                'INSERT INTO share_link_items (share_id, photo_id, sort_order) VALUES ?',
                [values]
            );
        }

        await conn.commit();
        conn.release();
        conn = null;

        res.json({
            code: inserted.code,
            shareType,
            expiresAt: expiresAt ? expiresAt.toISOString() : null,
            url: `/api/share/${inserted.code}`
        });
    } catch (err) {
        if (conn) {
            try { await conn.rollback(); conn.release(); } catch (_) { }
        }
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

        const [result] = await pool.query(
            'UPDATE share_links SET revoked_at = NOW() WHERE code = ? AND organization_id = ? AND created_by = ? AND revoked_at IS NULL',
            [code, orgId, userId]
        );

        if (!result || result.affectedRows === 0) {
            return res.status(404).json({ error: 'NOT_FOUND', message: 'share not found or already revoked' });
        }

        res.json({ ok: true });
    } catch (err) {
        console.error('[POST /api/share/:code/revoke] error:', err && err.stack ? err.stack : err);
        res.status(500).json({ error: 'Internal server error' });
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

        if (share.share_type === 'project') {
            const [pRows] = await pool.query(
                `
					SELECT
						p.id,
						p.uuid,
						p.project_id      AS projectId,
						p.url,
						p.thumb_url       AS thumbUrl,
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
					WHERE p.project_id = ? AND p.organization_id = ?
					ORDER BY p.created_at DESC
					LIMIT ? OFFSET ?
				`,
                [share.project_id, share.organization_id, limit, offset]
            );
            photos = pRows || [];
        } else {
            const [pRows] = await pool.query(
                `
					SELECT
						p.id,
						p.uuid,
						p.project_id      AS projectId,
						p.url,
						p.thumb_url       AS thumbUrl,
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
					WHERE s.share_id = ? AND p.organization_id = ?
					ORDER BY s.sort_order ASC, s.id ASC
					LIMIT ? OFFSET ?
				`,
                [share.id, share.organization_id, limit, offset]
            );
            photos = pRows || [];
        }

        const mapped = photos.map((p) => ({
            ...p,
            url: p.url ? buildUploadUrl(p.url) : null,
            thumbUrl: p.thumbUrl ? buildUploadUrl(p.thumbUrl) : null
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
