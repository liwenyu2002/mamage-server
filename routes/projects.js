// routes/projects.js
const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const keys = require('../config/keys');
const JWT_SECRET = keys.JWT_SECRET || 'please-change-this-secret';

// 如果请求没有运行全量 authMiddleware，但前端仍然携带了 Bearer token，
// 我们需要一个轻量的解析器来把用户 id 与 organization_id 加载进 req.user，
// 以便公开的列表/详情路由在有 token 时能按照用户组织返回数据。
async function populateReqUserFromAuthIfPresent(req) {
  try {
    if (req.user && req.user.id !== undefined) return; // already filled
    const auth = req.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.*)$/i);
    if (!m) return;
    const token = m[1];
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return; }
    if (!payload || !payload.id) return;
    try {
      const [rows] = await pool.query('SELECT id, organization_id, role FROM users WHERE id = ? LIMIT 1', [payload.id]);
      if (!rows || rows.length === 0) return;
      const u = rows[0];
      const org = (u.organization_id !== undefined && u.organization_id !== null) ? Number(u.organization_id) : null;
      req.user = { id: u.id, role: u.role || null, organization_id: org };
    } catch (e) {
      // ignore DB errors here; leave req.user unset
      return;
    }
  } catch (e) {
    // swallow any unexpected errors; this helper must not break public routes
    return;
  }
}

// 上传根目录（和 upload.js 保持一致）
const uploadRoot = path.join(__dirname, '..', 'uploads');

// 当部署到没有本地 uploads 的环境（例如 ECS）时，默认跳过本地文件删除/检查
const skipLocalFileCheck = (() => {
  const envVal = String(process.env.UPLOAD_SKIP_LOCAL_FILE_CHECK || '').trim().toLowerCase();
  if (envVal === '1' || envVal === 'true' || envVal === 'yes') return true;
  try {
    const base = (keys.UPLOAD_BASE_URL || '').trim();
    if (base && /^https?:\/\//i.test(base) && !/localhost|127\.0\.0\.1/.test(base)) return true;
  } catch (e) { }
  if (!keys.UPLOAD_ABS_DIR) return true;
  return false;
})();

// 基于数据库的权限检查（使用 role_permissions 表）
const { requirePermission } = require('../lib/permissions');

// 小工具：安全解析 meta JSON
function parseMeta(meta) {
  if (!meta) return {};
  if (typeof meta === 'string') {
    try {
      return JSON.parse(meta);
    } catch (e) {
      return {};
    }
  }
  return meta;
}

function parseTags(tags) {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') {
    const trimmed = tags.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      return trimmed.split(',').map(s => s.trim()).filter(Boolean);
    }
    return [];
  }
  return [];
}

// 选择封面：优先选同时包含标签 '合影' 和 '推荐' 的最新照片，次优包含 '合影'，次优包含 '推荐'，否则取最新一张
function chooseCoverFromPhotos(photoRows) {
  if (!photoRows || photoRows.length === 0) return { url: null, thumbUrl: null };

  // photoRows 假定按 created_at DESC, id DESC 排序（最新在前）
  let preferBoth = null;
  let preferHe = null; // 含 '合影'
  let preferTui = null; // 含 '推荐'
  let first = null;

  for (const p of photoRows) {
    if (!first) first = p;
    let tags = null;
    try {
      tags = parseTags(p.tags);
    } catch (e) {
      tags = [];
    }
    const hasHe = Array.isArray(tags) && tags.includes('合影');
    const hasTui = Array.isArray(tags) && tags.includes('推荐');

    if (hasHe && hasTui && !preferBoth) preferBoth = p;
    if (hasHe && !preferHe) preferHe = p;
    if (hasTui && !preferTui) preferTui = p;
    // 一旦同时命中则可以停止（因为按时间降序遍历，首个满足即为最新）
    if (preferBoth) break;
  }

  const chosen = preferBoth || preferHe || preferTui || first;
  return { url: chosen.url || null, thumbUrl: chosen.thumbUrl || null };
}

function normalizeTagsInput(input) {
  if (input === undefined || input === null) return null;
  let arr = [];
  if (Array.isArray(input)) {
    arr = input.map(String).map(s => s.trim()).filter(Boolean);
  } else if (typeof input === 'string') {
    const str = input.trim();
    if (!str) arr = [];
    else {
      try {
        const parsed = JSON.parse(str);
        if (Array.isArray(parsed)) arr = parsed.map(String).map(s => s.trim()).filter(Boolean);
        else arr = str.split(',').map(s => s.trim()).filter(Boolean);
      } catch (e) {
        arr = str.split(',').map(s => s.trim()).filter(Boolean);
      }
    }
  }
  return arr.length ? arr : null;
}

// ==============================
// 1. 首页项目列表：GET /api/projects?limit=4
// ==============================
router.get('/', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 50) {
      limit = 10;
    }

    // If frontend provided a Bearer token but this route wasn't protected by authMiddleware,
    // try to populate req.user from the token so organization scoping works.
    await populateReqUserFromAuthIfPresent(req);
    // organization scoping: only show projects for user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;

    let mainSql = `
      SELECT
        p.id,
        p.uuid,
        p.name AS projectName,
        p.description,
        p.event_date AS eventDate,
        p.meta,
        p.photo_ids AS photoIds,
        p.tags,
        p.admin_id AS adminId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        (
          SELECT ph.thumb_url
          FROM photos ph
          WHERE ph.project_id = p.id
          ORDER BY ph.created_at DESC, ph.id DESC
          LIMIT 1
        ) AS coverThumbUrl,
        (
          SELECT ph.url
          FROM photos ph
          WHERE ph.project_id = p.id
          ORDER BY ph.created_at DESC, ph.id DESC
          LIMIT 1
        ) AS coverUrl
      FROM projects p
    `;
    const mainParams = [];
    if (orgId === null) {
      mainSql += ' WHERE p.organization_id IS NULL';
    } else {
      mainSql += ' WHERE p.organization_id = ?';
      mainParams.push(orgId);
    }
    mainSql += ' ORDER BY p.created_at DESC LIMIT ?';
    mainParams.push(limit);

    const [rows] = await pool.query(mainSql, mainParams);

    const list = rows.map((r) => ({
      ...r,
      meta: parseMeta(r.meta),
      tags: parseTags(r.tags),
      // cover URL 会在下方统一计算（优先 '合影' + '推荐' 的最新照片）
      coverUrl: null,
      coverThumbUrl: null
    }));

    // 为所有项目批量查找照片并选封面（避免逐条查询）
    try {
      const projIds = rows.map(r => r.id).filter(Boolean);
      if (projIds.length) {
        // fetch photos within user's organization only
        let photoSql = `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, tags, created_at FROM photos WHERE project_id IN (?)`;
        const photoParams = [projIds];
        if (orgId === null) {
          photoSql += ' AND organization_id IS NULL';
        } else {
          photoSql += ' AND organization_id = ?';
          photoParams.push(orgId);
        }
        photoSql += ' ORDER BY created_at DESC, id DESC';
        const [photos] = await pool.query(photoSql, photoParams);

        const byProj = {};
        for (const ph of photos) {
          byProj[ph.projectId] = byProj[ph.projectId] || [];
          byProj[ph.projectId].push(ph);
        }

        for (const item of list) {
          const pRows = byProj[item.id] || [];
          const cover = chooseCoverFromPhotos(pRows);
          item.coverUrl = cover.url ? buildUploadUrl(cover.url) : null;
          item.coverThumbUrl = cover.thumbUrl ? buildUploadUrl(cover.thumbUrl) : null;
        }
      }
    } catch (e) {
      console.error('[GET /api/projects] cover selection error:', e && e.message ? e.message : e);
    }

    res.json(list);
  } catch (err) {
    console.error('[GET /api/projects] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// Scenery projects for current user's organization
// GET /api/projects/scenery
// Returns an array of projects of type 'scenery' (if any), each populated with its photos.
// If the DB lacks a `type` column on projects, falls back to searching name/tags for 'scenery'.
router.get('/scenery', async (req, res) => {
  try {
    // allow optional Bearer token even on this public route
    await populateReqUserFromAuthIfPresent(req);
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;

    // attempt to query by projects.type first
    let projSql = `
      SELECT
        p.id,
        p.uuid,
        p.name AS projectName,
        p.description,
        p.event_date AS eventDate,
        p.meta,
        p.photo_ids AS photoIds,
        p.tags,
        p.admin_id AS adminId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM projects p
      WHERE p.type = 'scenery'
    `;
    const projParams = [];
    if (orgId === null) {
      projSql += ' AND p.organization_id IS NULL';
    } else {
      projSql += ' AND p.organization_id = ?';
      projParams.push(orgId);
    }
    projSql += ' ORDER BY p.created_at DESC';

    let projRows;
    try {
      const [rows] = await pool.query(projSql, projParams);
      projRows = rows || [];
    } catch (e) {
      // fallback: maybe projects.type column doesn't exist — search by name or tags
      const fallbackSql = `
        SELECT
          p.id,
          p.uuid,
          p.name AS projectName,
          p.description,
          p.event_date AS eventDate,
          p.meta,
          p.photo_ids AS photoIds,
          p.tags,
          p.admin_id AS adminId,
          p.created_at AS createdAt,
          p.updated_at AS updatedAt
        FROM projects p
        WHERE (p.name LIKE ? OR p.tags LIKE ?)
      `;
      const like = '%scenery%';
      const fbParams = [like, like];
      if (orgId === null) {
        projRows = (await pool.query(fallbackSql + ' AND p.organization_id IS NULL', fbParams))[0] || [];
      } else {
        projRows = (await pool.query(fallbackSql + ' AND p.organization_id = ?', fbParams.concat([orgId])))[0] || [];
      }
    }

    // For each project, fetch photos (respecting org scoping)
    const projIds = projRows.map(r => r.id).filter(Boolean);
    let photos = [];
    if (projIds.length) {
      let photoSql = `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, title, type, tags, photographer_id AS photographerId, created_at FROM photos WHERE project_id IN (?)`;
      const photoParams = [projIds];
      if (orgId === null) {
        photoSql += ' AND organization_id IS NULL';
      } else {
        photoSql += ' AND organization_id = ?';
        photoParams.push(orgId);
      }
      photoSql += ' ORDER BY created_at DESC, id DESC';
      const [rows] = await pool.query(photoSql, photoParams);
      photos = rows || [];
    }

    const byProj = {};
    for (const ph of photos) {
      byProj[ph.projectId] = byProj[ph.projectId] || [];
      byProj[ph.projectId].push(ph);
    }

    const result = projRows.map(p => ({
      ...p,
      meta: parseMeta(p.meta),
      tags: parseTags(p.tags),
      photos: (byProj[p.id] || []).map(ph => ({
        ...ph,
        url: ph.url ? buildUploadUrl(ph.url) : null,
        thumbUrl: ph.thumbUrl ? buildUploadUrl(ph.thumbUrl) : null
      }))
    }));

    res.json(result);
  } catch (err) {
    console.error('[GET /api/projects/scenery] error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 2. 项目列表：GET /api/projects/list
//    支持分页 + keyword 搜索
// ==============================
router.get('/list', async (req, res) => {
  try {
    let page = parseInt(req.query.page, 10);
    let pageSize = parseInt(req.query.pageSize, 10);
    const keyword = (req.query.keyword || '').trim();

    if (!Number.isFinite(page) || page <= 0) page = 1;
    if (!Number.isFinite(pageSize) || pageSize <= 0 || pageSize > 50) {
      pageSize = 6;
    }

    const whereClauses = [];
    const params = [];

    if (keyword) {
      const like = `%${keyword}%`;
      // 在项目名、描述、meta、photo_ids 上做模糊匹配
      whereClauses.push('(p.name LIKE ? OR p.description LIKE ? OR p.meta LIKE ? OR p.photo_ids LIKE ? OR p.tags LIKE ?)');
      params.push(like, like, like, like, like);
    }

    // add organization scoping to whereClauses
    await populateReqUserFromAuthIfPresent(req);
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    if (orgId === null) {
      whereClauses.push('p.organization_id IS NULL');
    } else {
      whereClauses.push('p.organization_id = ?');
      params.push(orgId);
    }

    const whereSql = whereClauses.length
      ? `WHERE ${whereClauses.join(' AND ')}`
      : '';

    // 1) 先查总数
    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total FROM projects p ${whereSql}`,
      params
    );
    const total = countRows[0]?.total || 0;

    if (total === 0) {
      return res.json({
        list: [],
        page,
        pageSize,
        total: 0,
        hasMore: false
      });
    }

    const offset = (page - 1) * pageSize;

    // 2) 再查当前页
    const selectSql = `
      SELECT
        p.id,
        p.uuid,
        p.name AS projectName,
        p.description,
        p.event_date AS eventDate,
        p.meta,
        p.photo_ids AS photoIds,
        p.tags,
        p.admin_id AS adminId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        (
          SELECT ph.thumb_url
          FROM photos ph
          WHERE ph.project_id = p.id
          ${orgId === null ? 'AND ph.organization_id IS NULL' : 'AND ph.organization_id = ?'}
          ORDER BY ph.created_at DESC, ph.id DESC
          LIMIT 1
        ) AS coverThumbUrl,
        (
          SELECT ph.url
          FROM photos ph
          WHERE ph.project_id = p.id
          ${orgId === null ? 'AND ph.organization_id IS NULL' : 'AND ph.organization_id = ?'}
          ORDER BY ph.created_at DESC, ph.id DESC
          LIMIT 1
        ) AS coverUrl
      FROM projects p
      ${whereSql}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const selectParams = [...params];
    if (orgId !== null) {
      selectParams.push(orgId, orgId);
    }
    selectParams.push(pageSize, offset);
    const [rows] = await pool.query(selectSql, selectParams);

    const list = rows.map((r) => ({
      ...r,
      meta: parseMeta(r.meta),
      tags: parseTags(r.tags)
    }));

    const hasMore = page * pageSize < total;

    // 为分页列表中的项目批量查封面（优先 '合影' + '推荐'）
    try {
      const projIds = rows.map(r => r.id).filter(Boolean);
      if (projIds.length) {
        const [photos] = await pool.query(
          `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, tags, created_at FROM photos WHERE project_id IN (?) ORDER BY created_at DESC, id DESC`,
          [projIds]
        );

        const byProj = {};
        for (const ph of photos) {
          byProj[ph.projectId] = byProj[ph.projectId] || [];
          byProj[ph.projectId].push(ph);
        }

        for (const item of list) {
          const pRows = byProj[item.id] || [];
          const cover = chooseCoverFromPhotos(pRows);
          item.coverUrl = cover.url ? buildUploadUrl(cover.url) : null;
          item.coverThumbUrl = cover.thumbUrl ? buildUploadUrl(cover.thumbUrl) : null;
        }
      }
    } catch (e) {
      console.error('[GET /api/projects/list] cover selection error:', e && e.message ? e.message : e);
    }

    res.json({ list, page, pageSize, total, hasMore });
  } catch (err) {
    console.error('[GET /api/projects/list] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 3. 项目详情：GET /api/projects/:id
// ==============================
router.get('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    await populateReqUserFromAuthIfPresent(req);
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let projSql = `
      SELECT
        p.id,
        p.uuid,
        p.name AS projectName,
        p.description,
        p.event_date AS eventDate,
        p.meta,
        p.photo_ids AS photoIds,
        p.tags,
        p.admin_id AS adminId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM projects p
      WHERE p.id = ?
    `;
    const projParams = [id];
    if (orgId === null) {
      projSql += ' AND p.organization_id IS NULL';
    } else {
      projSql += ' AND p.organization_id = ?';
      projParams.push(orgId);
    }
    const [projRows] = await pool.query(projSql, projParams);

    if (!projRows.length) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = projRows[0];
    project.meta = parseMeta(project.meta);
    project.tags = parseTags(project.tags);

    // 查该项目的所有照片
    let photoSql = `
      SELECT
        ph.id,
        ph.uuid,
        ph.project_id AS projectId,
        ph.url,
        ph.thumb_url AS thumbUrl,
        /* local_path column removed from schema; do not select it */
        ph.title,
        ph.description,
        ph.tags,
        ph.type,
        ph.photographer_id AS photographerId,
        u.name AS photographerName,
        ph.created_at AS createdAt,
        ph.updated_at AS updatedAt
      FROM photos ph
      LEFT JOIN users u ON ph.photographer_id = u.id
      WHERE ph.project_id = ?
    `;
    const photoParams = [id];
    if (orgId === null) {
      photoSql += ' AND ph.organization_id IS NULL';
    } else {
      photoSql += ' AND ph.organization_id = ?';
      photoParams.push(orgId);
    }
    photoSql += ' ORDER BY ph.created_at ASC, ph.id ASC';
    const [photoRows] = await pool.query(photoSql, photoParams);

    project.photos = photoRows.map((p) => ({
      ...p,
      url: p.url ? buildUploadUrl(p.url) : null,
      thumbUrl: p.thumbUrl ? buildUploadUrl(p.thumbUrl) : null,
      fullUrl: p.url ? buildUploadUrl(p.url) : null,
      fullThumbUrl: p.thumbUrl ? buildUploadUrl(p.thumbUrl) : null,
      description: p.description || null
    }));

    // 根据照片列表选封面：优先 '合影' 且 被 AI 推荐('推荐') 的最新照片
    try {
      const cover = chooseCoverFromPhotos(photoRows);
      project.coverFullUrl = cover.url ? buildUploadUrl(cover.url) : null;
      project.coverFullThumbUrl = cover.thumbUrl ? buildUploadUrl(cover.thumbUrl) : null;
    } catch (e) {
      project.coverFullUrl = null;
      project.coverFullThumbUrl = null;
    }

    res.json(project);
  } catch (err) {
    console.error('[GET /api/projects/:id] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 4. 创建项目：POST /api/projects  (仅 admin)
// ==============================
router.post('/', requirePermission('projects.create'), async (req, res) => {
  try {
    const body = req.body || {};

    const finalName = (body.projectName || body.name || body.title || '').trim();
    const finalDesc = (body.description || body.desc || '').trim();
    const rawEventDate = (body.eventDate || '').trim() || null;
    const tagsArr = normalizeTagsInput(body.tags);

    if (!finalName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    const uuid = uuidv4();
    const adminId = req.user && req.user.id ? req.user.id : null;
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;

    const metaObj = {};
    if (rawEventDate) {
      metaObj.eventDate = rawEventDate;
    }

    // 强制要求创建项目的用户属于某个组织（projects.organization_id 为 NOT NULL 的情形）
    if (orgId === null) {
      return res.status(400).json({
        error: 'ORG_REQUIRED',
        message: '创建项目需要用户所属组织（organization_id）。请为该用户分配组织，或在注册时选择组织。'
      });
    }

    // 尝试写入包含 organization_id 的记录；如果数据库根本没有该列（旧 schema），则兼容重试不带该列的插入。
    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO projects (uuid, name, description, event_date, meta, tags, admin_id, organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [uuid, finalName, finalDesc, rawEventDate, JSON.stringify(metaObj), tagsArr ? JSON.stringify(tagsArr) : null, adminId, orgId]
      );
    } catch (e) {
      if (e && (e.code === 'ER_BAD_FIELD_ERROR' || (e.message && e.message.indexOf('Unknown column') !== -1))) {
        // projects.organization_id column doesn't exist; retry without it for compatibility with older DB schemas
        [result] = await pool.query(
          `INSERT INTO projects (uuid, name, description, event_date, meta, tags, admin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [uuid, finalName, finalDesc, rawEventDate, JSON.stringify(metaObj), tagsArr ? JSON.stringify(tagsArr) : null, adminId]
        );
      } else {
        throw e;
      }
    }

    const newId = result.insertId;

    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        p.uuid,
        p.name AS projectName,
        p.description,
        p.event_date AS eventDate,
        p.meta,
        p.photo_ids AS photoIds,
        p.tags,
        p.admin_id AS adminId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM projects p
      WHERE p.id = ?
      `,
      [newId]
    );

    const project = rows[0];
    project.meta = parseMeta(project.meta);
    project.tags = parseTags(project.tags);

    // 计算封面（如果有照片）并填充为可访问的完整 URL
    try {
      const [photos] = await pool.query(
        `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, tags, created_at FROM photos WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
        [newId]
      );
      const cover = chooseCoverFromPhotos(photos);
      project.coverFullUrl = cover.url ? buildUploadUrl(cover.url) : null;
      project.coverFullThumbUrl = cover.thumbUrl ? buildUploadUrl(cover.thumbUrl) : null;
    } catch (e) {
      project.coverFullUrl = null;
      project.coverFullThumbUrl = null;
    }

    res.json(project);
  } catch (err) {
    console.error('[POST /api/projects] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 5. 更新项目：POST /api/projects/:id/update  (仅 admin)
// ==============================
router.post('/:id/update', requirePermission('projects.update'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const body = req.body || {};

    const finalName = (body.projectName || body.name || body.title || '').trim();
    const finalDesc = (body.description || body.desc || '').trim();
    const rawEventDate = (body.eventDate || '').trim() || null;
    const tagsArr = normalizeTagsInput(body.tags);

    if (!finalName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    // ensure project belongs to user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let ownershipSql = 'SELECT id FROM projects WHERE id = ?';
    const ownershipParams = [id];
    if (orgId === null) {
      ownershipSql += ' AND organization_id IS NULL';
    } else {
      ownershipSql += ' AND organization_id = ?';
      ownershipParams.push(orgId);
    }
    const [ownRows] = await pool.query(ownershipSql, ownershipParams);
    if (!ownRows || ownRows.length === 0) return res.status(404).json({ error: 'Project not found' });

    const [result] = await pool.query(
      `
      UPDATE projects
      SET
        name = ?,
        description = ?,
        event_date = ?,
        tags = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [finalName, finalDesc, rawEventDate, tagsArr ? JSON.stringify(tagsArr) : null, id]
    );

    const [rows] = await pool.query(
      `
      SELECT
        p.id,
        p.uuid,
        p.name AS projectName,
        p.description,
        p.event_date AS eventDate,
        p.meta,
        p.photo_ids AS photoIds,
        p.tags,
        p.admin_id AS adminId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM projects p
      WHERE p.id = ?
      `,
      [id]
    );

    const project = rows[0];
    project.meta = parseMeta(project.meta);
    project.tags = parseTags(project.tags);

    // 计算封面（保持与列表/详情一致的行为）
    try {
      const [photos] = await pool.query(
        `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, tags, created_at FROM photos WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
        [id]
      );
      const cover = chooseCoverFromPhotos(photos);
      project.coverFullUrl = cover.url ? buildUploadUrl(cover.url) : null;
      project.coverFullThumbUrl = cover.thumbUrl ? buildUploadUrl(cover.thumbUrl) : null;
    } catch (e) {
      project.coverFullUrl = null;
      project.coverFullThumbUrl = null;
    }

    res.json(project);
  } catch (err) {
    console.error('[POST /api/projects/:id/update] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 6. 删除项目：DELETE /api/projects/:id  (仅 admin)
// ==============================
router.delete('/:id', requirePermission('projects.delete'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ error: 'invalid project id' });
  }

  try {
    // ensure project belongs to user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let ownSql = 'SELECT id FROM projects WHERE id = ?';
    const ownParams = [id];
    if (orgId === null) {
      ownSql += ' AND organization_id IS NULL';
    } else {
      ownSql += ' AND organization_id = ?';
      ownParams.push(orgId);
    }
    const [ownRows] = await pool.query(ownSql, ownParams);
    if (!ownRows || ownRows.length === 0) return res.status(404).json({ error: 'project not found' });

    // 1. 查询该项目下所有照片（不再包含已删除的 local_path 列）
    const [photos] = await pool.query(
      `SELECT id, url, thumb_url AS thumbUrl
       FROM photos
       WHERE project_id = ?`,
      [id]
    );

    // 2. 删除照片文件（原图 + 缩略图）
    for (const p of photos) {

      // 原图（通过 url 还原绝对路径）
      if (p.url) {
        try {
          // 如果是远程 URL（COS）或配置为跳过本地检查，则不尝试删除本地文件
          if (/^https?:\/\//i.test(String(p.url)) || skipLocalFileCheck) {
            // nothing to remove locally
          } else {
            let rel = p.url.replace(/^\/uploads[\\\/]/, '');
            rel = rel.split('/').join(path.sep);
            const abs = path.join(uploadRoot, rel);
            if (fs.existsSync(abs)) {
              fs.unlink(abs, err => {
                if (err) {
                  console.error('unlink photo file error:', abs, err.message);
                } else {
                  console.log('photo file deleted:', abs);
                }
              });
            }
          }
        } catch (e) {
          console.error('check/unlink photo error:', p.url, e && e.message ? e.message : e);
        }
      }

      // 缩略图（通过 thumbUrl 还原绝对路径）
      if (p.thumbUrl) {
        try {
          if (/^https?:\/\//i.test(String(p.thumbUrl)) || skipLocalFileCheck) {
            // skip local thumb delete
          } else {
            // 形如 /uploads/2025/11/16/thumbs/thumb_xxx.jpg
            let rel = p.thumbUrl.replace(/^\/uploads[\\\/]/, ''); // 去掉 /uploads/
            rel = rel.split('/').join(path.sep);
            const absThumb = path.join(uploadRoot, rel);

            if (fs.existsSync(absThumb)) {
              fs.unlink(absThumb, err => {
                if (err) {
                  console.error('unlink thumb file error:', absThumb, err.message);
                } else {
                  console.log('thumb file deleted:', absThumb);
                }
              });
            }
          }
        } catch (e) {
          console.error('check/unlink thumb error:', p.thumbUrl, e && e.message ? e.message : e);
        }
      }
    }

    // 3. 删除 photos 表记录
    if (photos.length > 0) {
      await pool.query(
        `DELETE FROM photos WHERE project_id = ?`,
        [id]
      );
    }

    // 4. 删除 projects 表记录
    const [result] = await pool.query(
      `DELETE FROM projects WHERE id = ?`,
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'project not found' });
    }

    res.json({
      success: true,
      deletedProjectId: id,
      deletedPhotoIds: photos.map(p => p.id)
    });
  } catch (err) {
    console.error('DELETE /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
