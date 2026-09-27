const { pool } = require('../db');

class WorkspaceAccessError extends Error {
  constructor(code, status = 403) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

function positiveId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function unitRoleAllows(role, action) {
  if (action === 'read' || action === 'upload') return ['member', 'editor', 'manager'].includes(role);
  if (action === 'edit' || action === 'create' || action === 'delete') return ['editor', 'manager'].includes(role);
  if (action === 'manage' || action === 'share-auto') return role === 'manager';
  return false;
}

async function resolveWorkspace(req, db = pool) {
  if (req.workspace) return req.workspace;
  const userId = positiveId(req.user && req.user.id);
  const orgId = positiveId(req.user && req.user.organization_id);
  const userRole = req.user && req.user.role ? String(req.user.role) : null;
  if (!userId || !orgId || process.env.ORGANIZATION_UNITS_ACTIVE !== '1') {
    req.workspace = { enabled: false, userId, orgId, userRole, unitId: null, role: null, collegeAdmin: false };
    return req.workspace;
  }

  const [units] = await db.query(
    'SELECT id FROM organization_units WHERE organization_id = ? LIMIT 1', [orgId]
  );
  if (!units.length) {
    req.workspace = { enabled: false, userId, orgId, userRole, unitId: null, role: null, collegeAdmin: false };
    return req.workspace;
  }

  const [adminRows] = await db.query(
    'SELECT 1 FROM organization_admin_grants WHERE organization_id = ? AND user_id = ? LIMIT 1',
    [orgId, userId]
  );
  const collegeAdmin = adminRows.length > 0;
  const rawHeader = req.get('x-mamage-unit-id');
  const [userRows] = await db.query('SELECT active_unit_id FROM users WHERE id = ? AND organization_id = ? LIMIT 1', [userId, orgId]);
  if (!userRows.length) throw new WorkspaceAccessError('USER_NOT_FOUND', 401);
  const explicitLegacy = rawHeader === 'legacy';
  const requestedId = rawHeader === undefined || rawHeader === null
    ? positiveId(userRows[0].active_unit_id)
    : positiveId(rawHeader);
  if (rawHeader && !explicitLegacy && !requestedId) {
    throw new WorkspaceAccessError('INVALID_UNIT', 400);
  }
  const unitId = explicitLegacy ? null : requestedId;
  let role = null;
  if (unitId) {
    const [rows] = await db.query(
      `SELECT m.role FROM organization_units ou
       LEFT JOIN organization_unit_memberships m
         ON m.unit_id = ou.id AND m.user_id = ? AND m.removed_at IS NULL
       WHERE ou.id = ? AND ou.organization_id = ? AND ou.archived_at IS NULL LIMIT 1`,
      [userId, unitId, orgId]
    );
    if (!rows.length || (!rows[0].role && !collegeAdmin)) {
      if (rawHeader) throw new WorkspaceAccessError('UNIT_FORBIDDEN');
      req.workspace = { enabled: true, userId, orgId, userRole, unitId: null, role: null, collegeAdmin };
      return req.workspace;
    }
    role = rows[0].role || null;
  }
  req.workspace = { enabled: true, userId, orgId, userRole, unitId, role, collegeAdmin };
  return req.workspace;
}

function projectListScope(workspace, alias = 'p') {
  if (!workspace.enabled) {
    return process.env.ORGANIZATION_UNITS_ACTIVE === '1'
      ? { sql: `${alias}.unit_id IS NULL`, params: [] }
      : { sql: '', params: [] };
  }
  if (!workspace.unitId) return { sql: `${alias}.unit_id IS NULL`, params: [] };
  if (workspace.collegeAdmin) return { sql: `${alias}.unit_id = ?`, params: [workspace.unitId] };
  return {
    sql: `${alias}.unit_id = ? AND (${alias}.restricted_to_user_id IS NULL OR ${alias}.restricted_to_user_id = ?)`,
    params: [workspace.unitId, workspace.userId],
  };
}

async function hasInternalShare(workspace, resource, action = 'read', db = pool) {
  if (!workspace.enabled || !workspace.unitId) return false;
  const projectId = positiveId(resource.id || resource.project_id);
  const photoId = positiveId(resource.photo_id);
  if (!projectId && !photoId) return false;
  const allowedModes = action === 'read' ? ['read', 'collaborate']
    : action === 'edit' || action === 'upload' ? ['collaborate'] : [];
  if (!allowedModes.length) return false;
  const [rows] = await db.query(
    `SELECT 1 FROM internal_shares s
     LEFT JOIN internal_share_items si ON si.share_id = s.id AND si.photo_id = ?
     WHERE s.organization_id = ? AND s.revoked_at IS NULL
       AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND s.mode IN (?)
       AND s.target_unit_id = ? AND (s.target_user_id IS NULL OR s.target_user_id = ?)
       AND ((s.share_type = 'album' AND s.project_id = ?)
         OR (s.share_type = 'collection' AND si.photo_id IS NOT NULL))
     LIMIT 1`,
    [photoId || 0, workspace.orgId, allowedModes, workspace.unitId, workspace.userId, projectId || 0]
  );
  return rows.length > 0;
}

async function canAccessProject(workspace, project, action = 'read', db = pool) {
  if (!project || positiveId(project.organization_id) !== workspace.orgId) return false;
  if (!workspace.enabled) return true;
  if (positiveId(project.restricted_to_user_id) && !workspace.collegeAdmin
    && positiveId(project.restricted_to_user_id) !== workspace.userId) return false;
  const ownerUnitId = positiveId(project.unit_id);
  if (!ownerUnitId) return action === 'read' || workspace.collegeAdmin;
  if (workspace.collegeAdmin) return true;
  if (ownerUnitId === workspace.unitId && unitRoleAllows(workspace.role, action)) return true;
  return hasInternalShare(workspace, project, action, db);
}

async function requireProjectAccess(req, projectId, action = 'read', db = pool) {
  const workspace = await resolveWorkspace(req, db);
  const [rows] = await db.query(
    'SELECT id, organization_id, unit_id, restricted_to_user_id FROM projects WHERE id = ? LIMIT 1', [projectId]
  );
  if (!rows.length || !await canAccessProject(workspace, rows[0], action, db)) {
    throw new WorkspaceAccessError('PROJECT_NOT_FOUND', 404);
  }
  return rows[0];
}

async function requirePhotoAccess(req, photoId, action = 'read', db = pool) {
  const workspace = await resolveWorkspace(req, db);
  const [rows] = await db.query(
    `SELECT ph.id AS photo_id, ph.project_id, ph.organization_id,
            COALESCE(p.unit_id, ph.unit_id) AS unit_id,
            p.restricted_to_user_id
     FROM photos ph LEFT JOIN projects p ON p.id = ph.project_id
     WHERE ph.id = ? LIMIT 1`, [photoId]
  );
  if (!rows.length || positiveId(rows[0].organization_id) !== workspace.orgId) {
    throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
  }
  const photo = rows[0];
  if (!workspace.enabled) return photo;
  if (positiveId(photo.restricted_to_user_id) && !workspace.collegeAdmin
    && positiveId(photo.restricted_to_user_id) !== workspace.userId) {
    throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
  }
  const unitId = positiveId(photo.unit_id);
  if (!unitId && (action === 'read' || workspace.collegeAdmin)) return photo;
  if (workspace.collegeAdmin) return photo;
  if (unitId === workspace.unitId && unitRoleAllows(workspace.role, action)) return photo;
  if (await hasInternalShare(workspace, { id: photo.project_id, photo_id: photo.photo_id }, action, db)) return photo;
  throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
}

async function requirePhotosAccess(req, photoIds, action = 'read', db = pool) {
  const ids = Array.from(new Set((photoIds || []).map(positiveId).filter(Boolean)));
  if (!ids.length || ids.length > 2000) throw new WorkspaceAccessError('INVALID_PHOTO_IDS', 400);
  const workspace = await resolveWorkspace(req, db);
  const [rows] = await db.query(
    `SELECT ph.id, ph.project_id, ph.organization_id,
            COALESCE(p.unit_id, ph.unit_id) AS unit_id,
            p.restricted_to_user_id
     FROM photos ph LEFT JOIN projects p ON p.id = ph.project_id
     WHERE ph.id IN (?)`, [ids]
  );
  if (rows.length !== ids.length || rows.some((row) => positiveId(row.organization_id) !== workspace.orgId)) {
    throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
  }
  if (!workspace.enabled || workspace.collegeAdmin) return rows;
  if (rows.some((row) => positiveId(row.restricted_to_user_id)
    && positiveId(row.restricted_to_user_id) !== workspace.userId)) {
    throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
  }
  const unowned = rows.filter((row) => {
    const unitId = positiveId(row.unit_id);
    if (!unitId) return action !== 'read';
    return unitId !== workspace.unitId || !unitRoleAllows(workspace.role, action);
  });
  if (!unowned.length) return rows;
  const allowedModes = action === 'read' ? ['read', 'collaborate']
    : action === 'edit' || action === 'upload' ? ['collaborate'] : [];
  if (!allowedModes.length || !workspace.unitId) throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
  const [shares] = await db.query(
    `SELECT DISTINCT ph.id
     FROM photos ph
     JOIN internal_shares s ON s.organization_id = ph.organization_id
       AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at > NOW())
       AND s.mode IN (?) AND s.target_unit_id = ?
       AND (s.target_user_id IS NULL OR s.target_user_id = ?)
       AND ((s.share_type = 'album' AND s.project_id = ph.project_id)
         OR (s.share_type = 'collection' AND EXISTS
           (SELECT 1 FROM internal_share_items si WHERE si.share_id = s.id AND si.photo_id = ph.id)))
     WHERE ph.id IN (?)`,
    [allowedModes, workspace.unitId, workspace.userId, unowned.map((row) => row.id)]
  );
  const sharedIds = new Set(shares.map((row) => Number(row.id)));
  if (unowned.some((row) => !sharedIds.has(Number(row.id)))) {
    throw new WorkspaceAccessError('PHOTO_NOT_FOUND', 404);
  }
  return rows;
}

async function assertNoActiveCopySource(db, photoIds) {
  if (process.env.ORGANIZATION_UNITS_ACTIVE !== '1' || !photoIds.length) return;
  const [rows] = await db.query(
    `SELECT 1 FROM internal_share_items si
     JOIN organization_copy_jobs j ON j.share_id = si.share_id
     WHERE si.photo_id IN (?) AND j.status IN ('queued', 'copying') LIMIT 1`,
    [photoIds]
  );
  if (rows.length) throw new WorkspaceAccessError('COPY_IN_PROGRESS', 409);
}

function sendWorkspaceError(res, err) {
  if (!(err instanceof WorkspaceAccessError)) return false;
  res.status(err.status).json({ error: err.code });
  return true;
}

module.exports = {
  WorkspaceAccessError,
  positiveId,
  unitRoleAllows,
  resolveWorkspace,
  projectListScope,
  canAccessProject,
  requireProjectAccess,
  requirePhotoAccess,
  requirePhotosAccess,
  assertNoActiveCopySource,
  sendWorkspaceError,
};
