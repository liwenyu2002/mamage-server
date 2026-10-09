const express = require('express');
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');
const { resolveWorkspace, projectListScope, unitRoleAllows, sendWorkspaceError } = require('../lib/workspace_access');
const { buildMediaUrl } = require('../lib/media_access');
const { invalid, json, validateGroups, validatePreferences } = require('../lib/album_desktop');
const router = express.Router();

router.use(requirePermission('photos.view'));
router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

async function context(req) {
  const workspace = await resolveWorkspace(req);
  if (!workspace.userId || !workspace.orgId) throw invalid('请登录后使用桌面', 401);
  return { ...workspace, unitKey: workspace.unitId || 0,
    canOrganize: workspace.enabled ? workspace.collegeAdmin || unitRoleAllows(workspace.role, 'edit')
      : ['admin', 'superadmin', 'editor'].includes(workspace.userRole) };
}

async function catalog(workspace, db = pool, full = true) {
  const scope = projectListScope(workspace, 'p');
  const params = [workspace.orgId, ...scope.params];
  const where = `p.organization_id = ?${scope.sql ? ` AND ${scope.sql}` : ''}`;
  if (!full) {
    const [rows] = await db.query(`SELECT p.id FROM projects p WHERE ${where}`, params);
    return rows;
  }
  const [rows] = await db.query(`SELECT p.id, p.name, p.description, p.meta,
    p.created_at AS createdAt, p.updated_at AS updatedAt, p.event_date AS eventDate,
    (SELECT COUNT(*) FROM photos c WHERE c.project_id = p.id AND c.organization_id = p.organization_id) AS count,
    ph.id AS photoId, ph.thumb_url AS coverThumb, ph.url AS coverUrl
    FROM projects p LEFT JOIN photos ph ON ph.id = (
      SELECT i.id FROM photos i WHERE i.project_id = p.id AND i.organization_id = p.organization_id
      AND (i.type IS NULL OR i.type <> 'video') ORDER BY i.created_at DESC, i.id DESC LIMIT 1
    ) WHERE ${where} ORDER BY COALESCE(p.updated_at, p.created_at) DESC, p.id DESC`, params);
  return rows.map(row => ({ id: Number(row.id), name: row.name, title: row.name,
    description: row.description || '', count: Number(row.count) || 0,
    originLabel: (() => { const lineage = json(row.meta, {}).shareLineage; const last = Array.isArray(lineage) ? lineage[lineage.length-1] : null; return [last?.organizationName,last?.unitName].filter(Boolean).join(' / '); })(),
    createdAt: row.createdAt, updatedAt: row.updatedAt, eventDate: row.eventDate,
    year: String(new Date(row.eventDate || row.createdAt).getFullYear()),
    image: row.coverThumb || row.coverUrl ? buildMediaUrl(row.coverThumb || row.coverUrl, { userId: workspace.userId, photoId: row.photoId }) : null }));
}

function fail(res, error) {
  if (sendWorkspaceError(res, error)) return;
  if (error.status) return res.status(error.status).json({ message: error.message });
  console.error('[album-desktop]', error);
  res.status(500).json({ message: '桌面暂时无法加载，请稍后重试' });
}

router.get('/', async (req, res) => {
  try {
    const workspace = await context(req);
    const albums = await catalog(workspace);
    const [shared] = await pool.query('SELECT state, revision FROM album_desktop_workspaces WHERE organization_id = ? AND unit_key = ?', [workspace.orgId, workspace.unitKey]);
    const [personal] = await pool.query('SELECT state, revision FROM album_desktop_users WHERE user_id = ? AND organization_id = ? AND unit_key = ?', [workspace.userId, workspace.orgId, workspace.unitKey]);
    const ids = new Set(albums.map(a => a.id));
    const storedGroups = json(shared[0]?.state, {}).groups || [];
    const groups = storedGroups.map(g => ({ ...g, projectIds: (g.projectIds || []).filter(id => ids.has(Number(id))) }));
    res.json({ albums, groups, preferences: validatePreferences(json(personal[0]?.state, {}), groups, ids),
      scope: { userId: workspace.userId, organizationId: workspace.orgId, unitId: workspace.unitId },
      workspaceRevision: Number(shared[0]?.revision || 0), userRevision: Number(personal[0]?.revision || 0), canOrganize: workspace.canOrganize });
  } catch (error) { fail(res, error); }
});

router.put('/state', async (req, res) => {
  let conn;
  try {
    const workspace = await context(req);
    const body = req.body || {};
    if (body.scope && (Number(body.scope.userId) !== workspace.userId
      || Number(body.scope.organizationId) !== workspace.orgId || Number(body.scope.unitId || 0) !== workspace.unitKey)) {
      throw invalid('账号或工作空间已切换，请重新加载桌面', 409);
    }
    const changesGroups = Object.hasOwn(body, 'groups');
    if (changesGroups && !workspace.canOrganize) throw invalid('只有小组织编辑人员可以整理相册集', 403);
    if (Buffer.byteLength(JSON.stringify(body)) > 512 * 1024) throw invalid('桌面数据过大', 413);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    await conn.query('INSERT IGNORE INTO album_desktop_workspaces (organization_id, unit_key, state) VALUES (?, ?, ?)', [workspace.orgId, workspace.unitKey, '{"groups":[]}']);
    await conn.query('INSERT IGNORE INTO album_desktop_users (user_id, organization_id, unit_key, state) VALUES (?, ?, ?, ?)', [workspace.userId, workspace.orgId, workspace.unitKey, '{}']);
    const [shared] = await conn.query('SELECT state, revision FROM album_desktop_workspaces WHERE organization_id = ? AND unit_key = ? FOR UPDATE', [workspace.orgId, workspace.unitKey]);
    const [personal] = await conn.query('SELECT state, revision FROM album_desktop_users WHERE user_id = ? AND organization_id = ? AND unit_key = ? FOR UPDATE', [workspace.userId, workspace.orgId, workspace.unitKey]);
    if ((changesGroups && Number(body.workspaceRevision) !== Number(shared[0].revision))
      || (body.preferences && Number(body.userRevision) !== Number(personal[0].revision))) throw invalid('桌面已在其他页面更新，请重新加载后再操作', 409);
    const albums = await catalog(workspace, conn, false);
    const ids = new Set(albums.map(a => Number(a.id)));
    const storedGroups = json(shared[0].state, {}).groups || [];
    const groups = changesGroups ? validateGroups(body.groups, ids).map(group => ({...group,
      projectIds: group.kind === 'smart' ? [] : [...new Set([...group.projectIds,
        ...(storedGroups.find(old=>old.id===group.id)?.projectIds || []).filter(id=>!ids.has(Number(id)))])] })) : storedGroups;
    if (changesGroups) await conn.query('UPDATE album_desktop_workspaces SET state = ?, revision = revision + 1 WHERE organization_id = ? AND unit_key = ?', [JSON.stringify({ groups }), workspace.orgId, workspace.unitKey]);
    if (body.preferences) {
      const preferences = validatePreferences(body.preferences, groups, ids);
      await conn.query('UPDATE album_desktop_users SET state = ?, revision = revision + 1 WHERE user_id = ? AND organization_id = ? AND unit_key = ?', [JSON.stringify(preferences), workspace.userId, workspace.orgId, workspace.unitKey]);
    }
    await conn.commit();
    res.json({ workspaceRevision: Number(shared[0].revision) + (changesGroups ? 1 : 0),
      userRevision: Number(personal[0].revision) + (body.preferences ? 1 : 0) });
  } catch (error) {
    if (conn) await conn.rollback();
    fail(res, error);
  } finally { conn?.release(); }
});

module.exports = router;
