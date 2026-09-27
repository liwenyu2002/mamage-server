const express = require('express');
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');
const {
  positiveId, resolveWorkspace, sendWorkspaceError, WorkspaceAccessError,
} = require('../lib/workspace_access');

const router = express.Router();

function fail(res, err) {
  if (sendWorkspaceError(res, err)) return;
  console.error('[workspaces]', err && err.stack ? err.stack : err);
  res.status(500).json({ error: 'INTERNAL_ERROR' });
}

async function getUnitRole(workspace, unitId) {
  const [rows] = await pool.query(
    `SELECT m.role FROM organization_units ou
     LEFT JOIN organization_unit_memberships m
       ON m.unit_id = ou.id AND m.user_id = ? AND m.removed_at IS NULL
     WHERE ou.id = ? AND ou.organization_id = ? AND ou.archived_at IS NULL LIMIT 1`,
    [workspace.userId, unitId, workspace.orgId]
  );
  if (!rows.length) return null;
  if (workspace.collegeAdmin) return 'collegeAdmin';
  return rows[0]?.role || null;
}

async function writeAudit(conn, workspace, action, unitId, resourceType, resourceId, details = null) {
  await conn.query(
    `INSERT INTO organization_access_audit
       (organization_id, unit_id, user_id, action, resource_type, resource_id, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [workspace.orgId, unitId || null, workspace.userId, action, resourceType || null, resourceId || null,
      details ? JSON.stringify(details) : null]
  );
}

router.get('/', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.enabled) return res.json({ enabled: false, units: [], activeUnitId: null });
    const [rows] = await pool.query(
      `SELECT ou.id, ou.name, ou.slug, ou.archived_at AS archivedAt, m.role,
              (SELECT COUNT(*) FROM projects p WHERE p.unit_id = ou.id) AS albumCount
       FROM organization_units ou
       LEFT JOIN organization_unit_memberships m
         ON m.unit_id = ou.id AND m.user_id = ? AND m.removed_at IS NULL
       WHERE ou.organization_id = ? AND ou.archived_at IS NULL
         AND (? = 1 OR m.user_id IS NOT NULL)
       ORDER BY ou.id ASC`,
      [workspace.userId, workspace.orgId, workspace.collegeAdmin ? 1 : 0]
    );
    const [shareTargets] = await pool.query(
      `SELECT id, name FROM organization_units
       WHERE organization_id = ? AND archived_at IS NULL ORDER BY id ASC`,
      [workspace.orgId]
    );
    res.json({ enabled: true, units: rows, activeUnitId: workspace.unitId,
      shareTargets, collegeAdmin: workspace.collegeAdmin, legacyAvailable: true });
  } catch (err) { fail(res, err); }
});

router.post('/active', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.enabled) throw new WorkspaceAccessError('WORKSPACES_NOT_ENABLED', 404);
    const unitId = req.body?.unitId === null || req.body?.unitId === 'legacy'
      ? null : positiveId(req.body?.unitId);
    if (req.body?.unitId !== null && req.body?.unitId !== 'legacy' && !unitId) {
      throw new WorkspaceAccessError('INVALID_UNIT', 400);
    }
    if (unitId && !await getUnitRole(workspace, unitId)) {
      throw new WorkspaceAccessError('UNIT_FORBIDDEN');
    }
    await pool.query('UPDATE users SET active_unit_id = ? WHERE id = ? AND organization_id = ?',
      [unitId, workspace.userId, workspace.orgId]);
    res.json({ activeUnitId: unitId });
  } catch (err) { fail(res, err); }
});

router.get('/stats/ai', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.enabled || (!workspace.collegeAdmin && workspace.role !== 'manager')) {
      throw new WorkspaceAccessError('UNIT_MANAGER_REQUIRED');
    }
    const days = Math.max(1, Math.min(365, Math.floor(Number(req.query.days) || 30)));
    const [rows] = await pool.query(
      `SELECT j.unit_id AS unitId, ou.name AS unitName, COUNT(*) AS jobCount,
              SUM(j.status = 'succeeded') AS succeededCount,
              COALESCE(SUM(j.tokens_used), 0) AS tokensUsed,
              COALESCE(SUM(j.cost_estimate), 0) AS estimatedCost
       FROM ai_jobs j JOIN users u ON u.id = j.user_id
       LEFT JOIN organization_units ou ON ou.id = j.unit_id
       WHERE u.organization_id = ? AND j.created_at >= DATE_SUB(NOW(), INTERVAL ? DAY)
         ${workspace.collegeAdmin ? '' : 'AND j.unit_id = ?'}
       GROUP BY j.unit_id, ou.name ORDER BY jobCount DESC`,
      [workspace.orgId, days, ...(workspace.collegeAdmin ? [] : [workspace.unitId])]
    );
    res.json({ days, rows });
  } catch (err) { fail(res, err); }
});

router.get('/albums', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.enabled || !workspace.unitId) return res.json([]);
    const [rows] = await pool.query(
      `SELECT id, name FROM projects
       WHERE organization_id = ? AND unit_id = ?
         ${workspace.collegeAdmin ? '' : 'AND (restricted_to_user_id IS NULL OR restricted_to_user_id = ?)'}
       ORDER BY created_at DESC, id DESC LIMIT 5000`,
      [workspace.orgId, workspace.unitId, ...(workspace.collegeAdmin ? [] : [workspace.userId])]
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/:unitId/members', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    const unitId = positiveId(req.params.unitId);
    const role = unitId && await getUnitRole(workspace, unitId);
    if (role !== 'manager' && role !== 'collegeAdmin') throw new WorkspaceAccessError('UNIT_FORBIDDEN');
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, m.role, m.created_at AS joinedAt
       FROM organization_unit_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.unit_id = ? AND m.removed_at IS NULL AND u.organization_id = ?
       ORDER BY FIELD(m.role, 'manager', 'editor', 'member'), u.name ASC`,
      [unitId, workspace.orgId]
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/:unitId/candidates', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    const unitId = positiveId(req.params.unitId);
    const role = unitId && await getUnitRole(workspace, unitId);
    if (role !== 'manager' && role !== 'collegeAdmin') throw new WorkspaceAccessError('UNIT_FORBIDDEN');
    const q = String(req.query.q || '').trim().slice(0, 80);
    if (q.length < 2) return res.json([]);
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email
       FROM users u WHERE u.organization_id = ? AND (u.name LIKE ? OR u.email LIKE ?)
       ORDER BY u.name LIMIT 30`,
      [workspace.orgId, `%${q}%`, `%${q}%`]
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.get('/:unitId/recipients', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    const unitId = positiveId(req.params.unitId);
    if (!workspace.enabled || !workspace.unitId
      || (!workspace.collegeAdmin && !['editor', 'manager'].includes(workspace.role))) {
      throw new WorkspaceAccessError('UNIT_EDITOR_REQUIRED');
    }
    const [units] = await pool.query(
      'SELECT id FROM organization_units WHERE id = ? AND organization_id = ? AND archived_at IS NULL LIMIT 1',
      [unitId, workspace.orgId]
    );
    if (!units.length || unitId === workspace.unitId) throw new WorkspaceAccessError('INVALID_TARGET_UNIT', 400);
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email
       FROM organization_unit_memberships m JOIN users u ON u.id = m.user_id
       WHERE m.unit_id = ? AND m.removed_at IS NULL AND u.organization_id = ?
       ORDER BY u.name LIMIT 200`,
      [unitId, workspace.orgId]
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.put('/:unitId/members/:userId', requirePermission('photos.view'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const workspace = await resolveWorkspace(req, conn);
    const unitId = positiveId(req.params.unitId);
    const userId = positiveId(req.params.userId);
    const role = String(req.body?.role || '').trim();
    if (!unitId || !userId || !['member', 'editor', 'manager'].includes(role)) {
      throw new WorkspaceAccessError('INVALID_MEMBERSHIP', 400);
    }
    const actorRole = await getUnitRole(workspace, unitId);
    if (actorRole !== 'manager' && actorRole !== 'collegeAdmin') throw new WorkspaceAccessError('UNIT_FORBIDDEN');
    if (role === 'manager' && !workspace.collegeAdmin) throw new WorkspaceAccessError('COLLEGE_ADMIN_REQUIRED');
    const [users] = await conn.query('SELECT id FROM users WHERE id = ? AND organization_id = ? LIMIT 1',
      [userId, workspace.orgId]);
    if (!users.length) throw new WorkspaceAccessError('USER_NOT_FOUND', 404);
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO organization_unit_memberships (unit_id, user_id, role)
       VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE role = VALUES(role), removed_at = NULL`,
      [unitId, userId, role]
    );
    await writeAudit(conn, workspace, 'membership.grant', unitId, 'user', userId, { role });
    await conn.commit();
    res.json({ unitId, userId, role });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    fail(res, err);
  } finally { conn.release(); }
});

router.delete('/:unitId/members/:userId', requirePermission('photos.view'), async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const workspace = await resolveWorkspace(req, conn);
    const unitId = positiveId(req.params.unitId);
    const userId = positiveId(req.params.userId);
    if (!unitId || !userId) throw new WorkspaceAccessError('INVALID_MEMBERSHIP', 400);
    const actorRole = await getUnitRole(workspace, unitId);
    if (actorRole !== 'manager' && actorRole !== 'collegeAdmin') throw new WorkspaceAccessError('UNIT_FORBIDDEN');
    const [targetRows] = await conn.query(
      'SELECT role FROM organization_unit_memberships WHERE unit_id = ? AND user_id = ? AND removed_at IS NULL LIMIT 1',
      [unitId, userId]
    );
    if (!targetRows.length) throw new WorkspaceAccessError('MEMBERSHIP_NOT_FOUND', 404);
    if (targetRows[0].role === 'manager' && !workspace.collegeAdmin) throw new WorkspaceAccessError('COLLEGE_ADMIN_REQUIRED');
    await conn.beginTransaction();
    await conn.query('UPDATE organization_unit_memberships SET removed_at = NOW() WHERE unit_id = ? AND user_id = ?',
      [unitId, userId]);
    await conn.query('UPDATE users SET active_unit_id = NULL WHERE id = ? AND active_unit_id = ?', [userId, unitId]);
    await writeAudit(conn, workspace, 'membership.remove', unitId, 'user', userId);
    await conn.commit();
    res.json({ removed: true });
  } catch (err) {
    try { await conn.rollback(); } catch (_) {}
    fail(res, err);
  } finally { conn.release(); }
});

router.get('/face-search/grants', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.collegeAdmin) throw new WorkspaceAccessError('COLLEGE_ADMIN_REQUIRED');
    const [rows] = await pool.query(
      `SELECT g.user_id AS userId, u.name, u.email, g.college_wide AS collegeWide
       FROM face_search_grants g JOIN users u ON u.id = g.user_id
       WHERE g.organization_id = ? ORDER BY u.name`, [workspace.orgId]
    );
    res.json(rows);
  } catch (err) { fail(res, err); }
});

router.put('/face-search/:userId', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.collegeAdmin) throw new WorkspaceAccessError('COLLEGE_ADMIN_REQUIRED');
    if (req.body?.collegeWide === false) throw new WorkspaceAccessError('UNIT_FACE_SCOPE_NOT_AVAILABLE', 400);
    const userId = positiveId(req.params.userId);
    if (!userId) throw new WorkspaceAccessError('INVALID_USER', 400);
    const [users] = await pool.query('SELECT id FROM users WHERE id = ? AND organization_id = ? LIMIT 1',
      [userId, workspace.orgId]);
    if (!users.length) throw new WorkspaceAccessError('USER_NOT_FOUND', 404);
    await pool.query(
      `INSERT INTO face_search_grants (organization_id, user_id, college_wide, granted_by)
       VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE college_wide = VALUES(college_wide), granted_by = VALUES(granted_by)`,
      [workspace.orgId, userId, 1, workspace.userId]
    );
    res.json({ granted: true });
  } catch (err) { fail(res, err); }
});

router.delete('/face-search/:userId', requirePermission('photos.view'), async (req, res) => {
  try {
    const workspace = await resolveWorkspace(req);
    if (!workspace.collegeAdmin) throw new WorkspaceAccessError('COLLEGE_ADMIN_REQUIRED');
    const userId = positiveId(req.params.userId);
    if (!userId) throw new WorkspaceAccessError('INVALID_USER', 400);
    await pool.query('DELETE FROM face_search_grants WHERE organization_id = ? AND user_id = ?',
      [workspace.orgId, userId]);
    res.json({ granted: false });
  } catch (err) { fail(res, err); }
});

module.exports = router;
