// routes/projects.js
const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const keys = require('../config/keys');
const cosStorage = require('../lib/cos_storage');
const JWT_SECRET = keys.JWT_SECRET;

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

function isDemoRequest(req) {
  const raw = req && req.query ? String(req.query.demo || '').trim().toLowerCase() : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

function getScopedOrgIdFromReq(req) {
  const authOrgId = req && req.user && req.user.organization_id !== undefined && req.user.organization_id !== null
    ? parseInt(req.user.organization_id, 10)
    : null;
  if (authOrgId !== null && Number.isFinite(authOrgId)) return authOrgId;

  if (!isDemoRequest(req)) return null;
  const demoOrgRaw = process.env.DEMO_ORGANIZATION_ID || process.env.PUBLIC_ORGANIZATION_ID || '';
  const demoOrgId = parseInt(String(demoOrgRaw).trim(), 10);
  if (!Number.isFinite(demoOrgId) || demoOrgId <= 0) return null;
  return demoOrgId;
}

// 上传根目录（和 upload.js/photos.js 保持一致）
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
const uploadRoot = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

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

function parsePhotoAdjustments(adjustments) {
  if (!adjustments) return null;
  const value = typeof adjustments === 'string' ? (() => {
    try { return JSON.parse(adjustments); } catch (e) { return null; }
  })() : adjustments;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const num = (v, fallback = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const gains = Array.isArray(value.wbGains) ? value.wbGains : [];
  return {
    version: 1,
    engine: value.engine || 'mamage-tone-v1',
    brightness: Math.min(100, Math.max(-100, num(value.brightness))),
    contrast: Math.min(100, Math.max(-100, num(value.contrast))),
    whites: Math.min(100, Math.max(-100, num(value.whites))),
    highlights: Math.min(100, Math.max(-100, num(value.highlights))),
    shadows: Math.min(100, Math.max(-100, num(value.shadows))),
    blacks: Math.min(100, Math.max(-100, num(value.blacks))),
    temperature: Math.min(100, Math.max(-100, num(value.temperature))),
    tint: Math.min(100, Math.max(-100, num(value.tint))),
    wbGains: [0, 1, 2].map((idx) => Math.min(1.8, Math.max(0.5, num(gains[idx], 1)))),
    source: value.source || 'manual',
    updatedAt: value.updatedAt || null,
  };
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
    if (String(p.type || p.mediaType || '').toLowerCase() === 'video') continue;
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

async function fetchProjectPreviewPhotos(projectIds, orgId, latestLimit = 6) {
  const ids = (Array.isArray(projectIds) ? projectIds : [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return [];

  const safeLatestLimit = Math.max(1, Math.min(12, Number(latestLimit) || 6));
  let sql = `
    SELECT
      ranked.id,
      ranked.projectId,
      ranked.url,
      ranked.thumbUrl,
      ranked.tags,
      ranked.type,
      ranked.created_at AS created_at
    FROM (
      SELECT
        ph.id,
        ph.project_id AS projectId,
        ph.url,
        ph.thumb_url AS thumbUrl,
        ph.tags,
        ph.type,
        ph.created_at,
        ROW_NUMBER() OVER (
          PARTITION BY ph.project_id
          ORDER BY ph.created_at DESC, ph.id DESC
        ) AS latestRank,
        ROW_NUMBER() OVER (
          PARTITION BY ph.project_id
          ORDER BY
            CASE
              WHEN ph.tags LIKE '%合影%' AND ph.tags LIKE '%推荐%' THEN 0
              WHEN ph.tags LIKE '%合影%' THEN 1
              WHEN ph.tags LIKE '%推荐%' THEN 2
              ELSE 3
            END,
            ph.created_at DESC,
            ph.id DESC
        ) AS coverRank
      FROM photos ph
      WHERE ph.project_id IN (?)
        AND (ph.type IS NULL OR ph.type <> 'video')
  `;
  const params = [ids];
  if (orgId === null) {
    sql += ' AND ph.organization_id IS NULL';
  } else {
    sql += ' AND ph.organization_id = ?';
    params.push(orgId);
  }
  sql += `
    ) ranked
    WHERE ranked.latestRank <= ? OR ranked.coverRank = 1
    ORDER BY ranked.projectId ASC, ranked.created_at DESC, ranked.id DESC
  `;
  params.push(safeLatestLimit);

  try {
    const [rows] = await pool.query(sql, params);
    return rows || [];
  } catch (err) {
    // Older MySQL variants may not support window functions. Keep a safe fallback
    // so deployments do not break, while MySQL 8+ gets bounded per-project reads.
    console.warn('[projects] preview window query fallback:', err && err.message ? err.message : err);
    let fallbackSql = `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, tags, type, created_at FROM photos WHERE project_id IN (?) AND (type IS NULL OR type <> 'video')`;
    const fallbackParams = [ids];
    if (orgId === null) {
      fallbackSql += ' AND organization_id IS NULL';
    } else {
      fallbackSql += ' AND organization_id = ?';
      fallbackParams.push(orgId);
    }
    fallbackSql += ' ORDER BY created_at DESC, id DESC';
    const [rows] = await pool.query(fallbackSql, fallbackParams);
    return rows || [];
  }
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

function parseBooleanInput(value) {
  if (value === undefined || value === null || value === '') return false;
  if (typeof value === 'boolean') return value;
  const raw = String(value).trim().toLowerCase();
  return ['1', 'true', 'yes', 'y', 'on'].includes(raw);
}

function normalizeTimelineSectionsInput(input) {
  if (input === undefined || input === null || input === '') return [];
  let arr = input;
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input);
      arr = Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      arr = input.split(/\r?\n/).map((line) => ({ name: line }));
    }
  }
  if (!Array.isArray(arr)) return [];

  const sections = [];
  const seenNames = new Set();
  arr.forEach((item, idx) => {
    const rawName = typeof item === 'string' ? item : (item && (item.name || item.title || item.label));
    const name = String(rawName || '').trim().slice(0, 100);
    if (!name || seenNames.has(name)) return;
    seenNames.add(name);
    const rawTime = typeof item === 'string' ? '' : (item && (item.sectionTime || item.section_time || item.time || item.eventTime));
    const sectionTime = String(rawTime || '').trim().slice(0, 64) || null;
    const sortRaw = typeof item === 'string' ? idx : (item && (item.sortOrder ?? item.sort_order ?? idx));
    const sortOrder = Number.isFinite(Number(sortRaw)) ? Math.max(0, Math.floor(Number(sortRaw))) : idx;
    // 带 id 表示"编辑已有环节"（支持重命名而不丢照片归属），无 id 表示新建
    const rawId = typeof item === 'string' ? null : (item && (item.id ?? item.sectionId ?? item.section_id));
    const id = Number.isFinite(Number(rawId)) && Number(rawId) > 0 ? Math.floor(Number(rawId)) : null;
    sections.push({ id, name, sectionTime, sortOrder });
  });

  return sections.slice(0, 50).map((section, idx) => ({
    ...section,
    sortOrder: Number.isFinite(section.sortOrder) ? section.sortOrder : idx,
  }));
}

function getTimelineConfigFromBody(body) {
  const sections = normalizeTimelineSectionsInput(body.timelineSections ?? body.timeline_sections ?? body.sections);
  const enabled = parseBooleanInput(body.timelineEnabled ?? body.timeline_enabled) || sections.length > 0;
  return { enabled, sections };
}

function projectTimelineEnabled(meta, sections) {
  return Boolean((meta && meta.timelineEnabled) || (Array.isArray(sections) && sections.length > 0));
}

function serializeTimelineSection(row) {
  return {
    id: row.id,
    projectId: row.projectId ?? row.project_id,
    name: row.name,
    sectionTime: row.sectionTime ?? row.section_time ?? null,
    sortOrder: Number(row.sortOrder ?? row.sort_order ?? 0) || 0,
  };
}

async function fetchTimelineSections(projectIds) {
  const ids = (Array.isArray(projectIds) ? projectIds : [projectIds])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);
  if (!ids.length) return {};

  const [rows] = await pool.query(
    `SELECT id, project_id AS projectId, name, section_time AS sectionTime, sort_order AS sortOrder
     FROM project_timeline_sections
     WHERE project_id IN (?)
     ORDER BY project_id ASC, sort_order ASC, id ASC`,
    [ids]
  );
  const byProject = {};
  (rows || []).forEach((row) => {
    const key = String(row.projectId);
    if (!byProject[key]) byProject[key] = [];
    byProject[key].push(serializeTimelineSection(row));
  });
  return byProject;
}

async function attachTimelineToProject(project) {
  if (!project || !project.id) return project;
  try {
    const byProject = await fetchTimelineSections([project.id]);
    const sections = byProject[String(project.id)] || [];
    project.timelineSections = sections;
    project.timelineEnabled = projectTimelineEnabled(project.meta, sections);
  } catch (err) {
    project.timelineSections = [];
    project.timelineEnabled = Boolean(project.meta && project.meta.timelineEnabled);
  }
  return project;
}

async function replaceTimelineSections(conn, projectId, sections) {
  const [existingRows] = await conn.query(
    'SELECT id, name FROM project_timeline_sections WHERE project_id = ? FOR UPDATE',
    [projectId]
  );
  const existingByName = new Map((existingRows || []).map((row) => [String(row.name || ''), row]));
  const existingById = new Map((existingRows || []).map((row) => [Number(row.id), row]));
  const keepIds = [];
  const claimedIds = new Set();

  for (let i = 0; i < sections.length; i += 1) {
    const section = sections[i];
    const sortOrder = Number.isFinite(section.sortOrder) ? section.sortOrder : i;
    // id 匹配优先：允许重命名已有环节而不触发"删旧建新"（那会把照片归属清空）；
    // 已被前面条目占用的行不再复用，避免两个输入项写同一行
    let existing = (section.id && existingById.get(section.id)) || existingByName.get(section.name);
    if (existing && claimedIds.has(Number(existing.id))) existing = null;
    if (existing && existing.id) {
      claimedIds.add(Number(existing.id));
      keepIds.push(existing.id);
      await conn.query(
        `UPDATE project_timeline_sections
         SET name = ?, section_time = ?, sort_order = ?, updated_at = NOW()
         WHERE id = ? AND project_id = ?`,
        [section.name, section.sectionTime || null, sortOrder, existing.id, projectId]
      );
    } else {
      const [result] = await conn.query(
        `INSERT INTO project_timeline_sections (project_id, name, section_time, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, NOW(), NOW())`,
        [projectId, section.name, section.sectionTime || null, sortOrder]
      );
      if (result && result.insertId) keepIds.push(result.insertId);
    }
  }

  if (keepIds.length) {
    await conn.query('DELETE FROM project_timeline_sections WHERE project_id = ? AND id NOT IN (?)', [projectId, keepIds]);
  } else {
    await conn.query('DELETE FROM project_timeline_sections WHERE project_id = ?', [projectId]);
  }
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
    const orgId = getScopedOrgIdFromReq(req);

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
            AND (ph.type IS NULL OR ph.type <> 'video')
          ORDER BY ph.created_at DESC, ph.id DESC
          LIMIT 1
        ) AS coverThumbUrl,
        (
          SELECT ph.url
          FROM photos ph
          WHERE ph.project_id = p.id
            AND (ph.type IS NULL OR ph.type <> 'video')
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
        const photos = await fetchProjectPreviewPhotos(projIds, orgId, 6);

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
    const orgId = getScopedOrgIdFromReq(req);

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
    const orgId = getScopedOrgIdFromReq(req);
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
          AND (ph.type IS NULL OR ph.type <> 'video')
          ORDER BY ph.created_at DESC, ph.id DESC
          LIMIT 1
        ) AS coverThumbUrl,
        (
          SELECT ph.url
          FROM photos ph
          WHERE ph.project_id = p.id
          ${orgId === null ? 'AND ph.organization_id IS NULL' : 'AND ph.organization_id = ?'}
          AND (ph.type IS NULL OR ph.type <> 'video')
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
        const photos = await fetchProjectPreviewPhotos(projIds, orgId, 6);

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
          item.previewImages = pRows.filter((ph) => String(ph.type || '').toLowerCase() !== 'video').slice(0, 6).map((ph) => ({
            id: ph.id,
            url: ph.url ? buildUploadUrl(ph.url) : null,
            thumbUrl: ph.thumbUrl ? buildUploadUrl(ph.thumbUrl) : null,
            fullThumbUrl: ph.thumbUrl ? buildUploadUrl(ph.thumbUrl) : null,
            type: ph.type || null,
          })).filter((ph) => ph && (ph.url || ph.thumbUrl));
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
    const includeFaces = String(req.query.includeFaces || '').trim().toLowerCase();
    const shouldIncludeFaces = includeFaces === '1' || includeFaces === 'true' || includeFaces === 'yes';

    await populateReqUserFromAuthIfPresent(req);
    const orgId = getScopedOrgIdFromReq(req);
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
    await attachTimelineToProject(project);

    // 查该项目的所有照片
    let photoSql = `
      SELECT
        ph.id,
        ph.uuid,
        ph.project_id AS projectId,
        ph.timeline_section_id AS timelineSectionId,
        ph.url,
        ph.thumb_url AS thumbUrl,
        ph.playback_url AS playbackUrl,
        /* local_path column removed from schema; do not select it */
        ph.title,
        ph.description,
        ph.adjustments,
        ph.tags,
        ph.ai_status AS aiStatus,
        ph.ai_error AS aiError,
        ph.ai_started_at AS aiStartedAt,
        ph.ai_finished_at AS aiFinishedAt,
        ph.type,
        ph.photographer_id AS photographerId,
        pts.name AS timelineSectionName,
        pts.section_time AS timelineSectionTime,
        u.name AS photographerName,
        ph.created_at AS createdAt,
        ph.updated_at AS updatedAt
      FROM photos ph
      LEFT JOIN users u ON ph.photographer_id = u.id
      LEFT JOIN project_timeline_sections pts ON ph.timeline_section_id = pts.id
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
      playbackUrl: p.playbackUrl ? buildUploadUrl(p.playbackUrl) : null,
      playback_url: p.playbackUrl ? buildUploadUrl(p.playbackUrl) : null,
      fullUrl: p.url ? buildUploadUrl(p.url) : null,
      fullThumbUrl: p.thumbUrl ? buildUploadUrl(p.thumbUrl) : null,
      description: p.description || null,
      adjustments: parsePhotoAdjustments(p.adjustments)
    }));

    if (shouldIncludeFaces && project.photos.length > 0) {
      try {
        let faceSql = `
          SELECT
            pf.photo_id AS photoId,
            pf.person_id AS personId,
            fp.name AS personName
          FROM photo_faces pf
          LEFT JOIN face_persons fp ON pf.person_id = fp.id
          WHERE pf.project_id = ?
        `;
        const faceParams = [id];
        if (orgId === null) {
          faceSql += ' AND pf.organization_id IS NULL';
        } else {
          faceSql += ' AND pf.organization_id = ?';
          faceParams.push(orgId);
        }
        faceSql += ' ORDER BY pf.photo_id ASC, pf.id ASC';

        const [faceRows] = await pool.query(faceSql, faceParams);
        const namesByPhotoId = {};

        (faceRows || []).forEach((row) => {
          const pid = row && row.photoId ? String(row.photoId) : '';
          if (!pid) return;

          let name = row && row.personName ? String(row.personName).trim() : '';
          if (!name && row && row.personId) {
            name = `人物#${row.personId}`;
          }
          if (!name) return;

          if (!namesByPhotoId[pid]) namesByPhotoId[pid] = [];
          if (!namesByPhotoId[pid].includes(name)) {
            namesByPhotoId[pid].push(name);
          }
        });

        project.photos = project.photos.map((p) => {
          const names = namesByPhotoId[String(p.id)] || [];
          return {
            ...p,
            faceNames: names,
            personNames: names,
          };
        });
      } catch (e) {
        console.warn('[GET /api/projects/:id] includeFaces failed:', e && e.message ? e.message : e);
      }
    }

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
    const timelineConfig = getTimelineConfigFromBody(body);

    if (!finalName) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    if (timelineConfig.enabled && timelineConfig.sections.length === 0) {
      return res.status(400).json({ error: 'TIMELINE_SECTIONS_REQUIRED', message: '开启时间轴后至少需要添加一个环节名称' });
    }

    const uuid = uuidv4();
    const adminId = req.user && req.user.id ? req.user.id : null;
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;

    const metaObj = parseMeta(body.meta);
    if (rawEventDate) {
      metaObj.eventDate = rawEventDate;
    }
    metaObj.timelineEnabled = Boolean(timelineConfig.enabled);

    // 强制要求创建项目的用户属于某个组织（projects.organization_id 为 NOT NULL 的情形）
    if (orgId === null) {
      return res.status(400).json({
        error: 'ORG_REQUIRED',
        message: '创建项目需要用户所属组织（organization_id）。请为该用户分配组织，或在注册时选择组织。'
      });
    }

    let result;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      try {
        [result] = await conn.query(
          `INSERT INTO projects (uuid, name, description, event_date, meta, tags, admin_id, organization_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [uuid, finalName, finalDesc, rawEventDate, JSON.stringify(metaObj), tagsArr ? JSON.stringify(tagsArr) : null, adminId, orgId]
        );
      } catch (e) {
        if (e && (e.code === 'ER_BAD_FIELD_ERROR' || (e.message && e.message.indexOf('Unknown column') !== -1))) {
          // projects.organization_id column doesn't exist; retry without it for compatibility with older DB schemas
          [result] = await conn.query(
            `INSERT INTO projects (uuid, name, description, event_date, meta, tags, admin_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
            [uuid, finalName, finalDesc, rawEventDate, JSON.stringify(metaObj), tagsArr ? JSON.stringify(tagsArr) : null, adminId]
          );
        } else {
          throw e;
        }
      }

      const newId = result.insertId;
      if (timelineConfig.enabled) {
        await replaceTimelineSections(conn, newId, timelineConfig.sections);
      }
      await conn.commit();

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
      await attachTimelineToProject(project);

      // 计算封面（如果有照片）并填充为可访问的完整 URL
      try {
        const [photos] = await pool.query(
          `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, tags, type, created_at FROM photos WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
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
    } catch (e) {
      try { await conn.rollback(); } catch (_) { }
      throw e;
    } finally {
      conn.release();
    }
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
    const timelineFieldsProvided = body.timelineEnabled !== undefined
      || body.timeline_enabled !== undefined
      || body.timelineSections !== undefined
      || body.timeline_sections !== undefined
      || body.sections !== undefined;
    const timelineConfig = timelineFieldsProvided ? getTimelineConfigFromBody(body) : null;

    if (!finalName) {
      return res.status(400).json({ error: 'projectName is required' });
    }
    if (timelineConfig && timelineConfig.enabled && timelineConfig.sections.length === 0) {
      return res.status(400).json({ error: 'TIMELINE_SECTIONS_REQUIRED', message: '开启时间轴后至少需要添加一个环节名称' });
    }

    // ensure project belongs to user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let ownershipSql = 'SELECT id, meta FROM projects WHERE id = ?';
    const ownershipParams = [id];
    if (orgId === null) {
      ownershipSql += ' AND organization_id IS NULL';
    } else {
      ownershipSql += ' AND organization_id = ?';
      ownershipParams.push(orgId);
    }
    const [ownRows] = await pool.query(ownershipSql, ownershipParams);
    if (!ownRows || ownRows.length === 0) return res.status(404).json({ error: 'Project not found' });
    const metaObj = parseMeta(ownRows[0].meta);
    if (rawEventDate) metaObj.eventDate = rawEventDate;
    else delete metaObj.eventDate;
    if (timelineConfig) metaObj.timelineEnabled = Boolean(timelineConfig.enabled);

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.query(
        `
        UPDATE projects
        SET
          name = ?,
          description = ?,
          event_date = ?,
          meta = ?,
          tags = ?,
          updated_at = NOW()
        WHERE id = ?
        `,
        [finalName, finalDesc, rawEventDate, JSON.stringify(metaObj), tagsArr ? JSON.stringify(tagsArr) : null, id]
      );
      if (timelineConfig) {
        await replaceTimelineSections(conn, id, timelineConfig.enabled ? timelineConfig.sections : []);
        await conn.query(
          `UPDATE photos p
           LEFT JOIN project_timeline_sections pts
             ON p.timeline_section_id = pts.id AND pts.project_id = ?
           SET p.timeline_section_id = NULL
           WHERE p.project_id = ? AND p.timeline_section_id IS NOT NULL AND pts.id IS NULL`,
          [id, id]
        );
      }
      await conn.commit();
    } catch (e) {
      try { await conn.rollback(); } catch (_) { }
      throw e;
    } finally {
      conn.release();
    }

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
    await attachTimelineToProject(project);

    // 计算封面（保持与列表/详情一致的行为）
    try {
      const [photos] = await pool.query(
        `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, tags, type, created_at FROM photos WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
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
// 时间线环节单条 CRUD（projects.update）
// ==============================

// 项目 org 归属校验，返回 {id} 或 null
async function findScopedProject(req, projectId) {
  const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
  let sql = 'SELECT id FROM projects WHERE id = ?';
  const params = [projectId];
  if (orgId === null) sql += ' AND organization_id IS NULL';
  else { sql += ' AND organization_id = ?'; params.push(orgId); }
  const [rows] = await pool.query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

// 新建环节
router.post('/:id/timeline-sections', requirePermission('projects.update'), async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) return res.status(400).json({ error: 'Invalid project id' });
    if (!(await findScopedProject(req, projectId))) return res.status(404).json({ error: 'Project not found' });

    const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
    if (!name) return res.status(400).json({ error: 'SECTION_NAME_REQUIRED' });
    const sectionTime = String((req.body && (req.body.sectionTime || req.body.section_time)) || '').trim().slice(0, 64) || null;

    const [dups] = await pool.query('SELECT id FROM project_timeline_sections WHERE project_id = ? AND name = ?', [projectId, name]);
    if (dups && dups.length) return res.status(409).json({ error: 'SECTION_NAME_EXISTS', message: '同名环节已存在' });

    const [[maxRow]] = await pool.query('SELECT COALESCE(MAX(sort_order), -1) AS maxOrder FROM project_timeline_sections WHERE project_id = ?', [projectId]);
    const sortOrder = Number(maxRow.maxOrder) + 1;
    const [result] = await pool.query(
      `INSERT INTO project_timeline_sections (project_id, name, section_time, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [projectId, name, sectionTime, sortOrder]
    );
    return res.status(201).json(serializeTimelineSection({ id: result.insertId, projectId, name, sectionTime, sortOrder }));
  } catch (err) {
    console.error('[POST /api/projects/:id/timeline-sections] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 重命名/改时间（重命名不影响照片归属）
router.patch('/:id/timeline-sections/:sectionId', requirePermission('projects.update'), async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const sectionId = parseInt(req.params.sectionId, 10);
    if (!Number.isFinite(projectId) || projectId <= 0 || !Number.isFinite(sectionId) || sectionId <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    if (!(await findScopedProject(req, projectId))) return res.status(404).json({ error: 'Project not found' });

    const [rows] = await pool.query('SELECT id FROM project_timeline_sections WHERE id = ? AND project_id = ?', [sectionId, projectId]);
    if (!rows || !rows.length) return res.status(404).json({ error: 'Section not found' });

    const sets = [];
    const params = [];
    if (req.body && req.body.name !== undefined) {
      const name = String(req.body.name || '').trim().slice(0, 100);
      if (!name) return res.status(400).json({ error: 'SECTION_NAME_REQUIRED' });
      const [dups] = await pool.query(
        'SELECT id FROM project_timeline_sections WHERE project_id = ? AND name = ? AND id <> ?',
        [projectId, name, sectionId]
      );
      if (dups && dups.length) return res.status(409).json({ error: 'SECTION_NAME_EXISTS', message: '同名环节已存在' });
      sets.push('name = ?');
      params.push(name);
    }
    if (req.body && (req.body.sectionTime !== undefined || req.body.section_time !== undefined)) {
      const sectionTime = String(req.body.sectionTime ?? req.body.section_time ?? '').trim().slice(0, 64) || null;
      sets.push('section_time = ?');
      params.push(sectionTime);
    }
    if (req.body && (req.body.sortOrder !== undefined || req.body.sort_order !== undefined)) {
      const so = Number(req.body.sortOrder ?? req.body.sort_order);
      if (Number.isFinite(so) && so >= 0) { sets.push('sort_order = ?'); params.push(Math.floor(so)); }
    }
    if (!sets.length) return res.status(400).json({ error: 'NO_FIELDS' });

    await pool.query(
      `UPDATE project_timeline_sections SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? AND project_id = ?`,
      [...params, sectionId, projectId]
    );
    const [[row]] = await pool.query(
      'SELECT id, project_id AS projectId, name, section_time AS sectionTime, sort_order AS sortOrder FROM project_timeline_sections WHERE id = ?',
      [sectionId]
    );
    return res.json(serializeTimelineSection(row));
  } catch (err) {
    console.error('[PATCH /api/projects/:id/timeline-sections/:sectionId] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 删除环节：照片回落"未归类"（timeline_section_id 无外键，必须显式回落）
router.delete('/:id/timeline-sections/:sectionId', requirePermission('projects.update'), async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    const sectionId = parseInt(req.params.sectionId, 10);
    if (!Number.isFinite(projectId) || projectId <= 0 || !Number.isFinite(sectionId) || sectionId <= 0) {
      return res.status(400).json({ error: 'Invalid id' });
    }
    if (!(await findScopedProject(req, projectId))) return res.status(404).json({ error: 'Project not found' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.query('DELETE FROM project_timeline_sections WHERE id = ? AND project_id = ?', [sectionId, projectId]);
      if (!result.affectedRows) {
        await conn.rollback();
        return res.status(404).json({ error: 'Section not found' });
      }
      const [fallback] = await conn.query(
        'UPDATE photos SET timeline_section_id = NULL WHERE project_id = ? AND timeline_section_id = ?',
        [projectId, sectionId]
      );
      await conn.commit();
      return res.json({ ok: true, unassignedPhotos: fallback.affectedRows || 0 });
    } catch (err) {
      try { await conn.rollback(); } catch (e) { }
      throw err;
    } finally {
      try { conn.release(); } catch (e) { }
    }
  } catch (err) {
    console.error('[DELETE /api/projects/:id/timeline-sections/:sectionId] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// 排序：按数组顺序写 sort_order
router.post('/:id/timeline-sections/reorder', requirePermission('projects.update'), async (req, res) => {
  try {
    const projectId = parseInt(req.params.id, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) return res.status(400).json({ error: 'Invalid project id' });
    if (!(await findScopedProject(req, projectId))) return res.status(404).json({ error: 'Project not found' });

    const ids = Array.isArray(req.body && req.body.sectionIds)
      ? req.body.sectionIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (!ids.length || ids.length > 50) return res.status(400).json({ error: 'INVALID_SECTION_IDS' });
    if (new Set(ids).size !== ids.length) return res.status(400).json({ error: 'DUPLICATE_SECTION_IDS' });

    const [rows] = await pool.query('SELECT id FROM project_timeline_sections WHERE project_id = ? AND id IN (?)', [projectId, ids]);
    if (!rows || rows.length !== ids.length) return res.status(400).json({ error: 'SECTION_NOT_IN_PROJECT' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (let i = 0; i < ids.length; i += 1) {
        await conn.query('UPDATE project_timeline_sections SET sort_order = ?, updated_at = NOW() WHERE id = ? AND project_id = ?', [i, ids[i], projectId]);
      }
      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch (e) { }
      throw err;
    } finally {
      try { conn.release(); } catch (e) { }
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/projects/:id/timeline-sections/reorder] error:', err);
    return res.status(500).json({ error: 'Internal server error' });
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
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let photos = [];
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let ownSql = 'SELECT id FROM projects WHERE id = ?';
      const ownParams = [id];
      if (orgId === null) {
        ownSql += ' AND organization_id IS NULL';
      } else {
        ownSql += ' AND organization_id = ?';
        ownParams.push(orgId);
      }
      ownSql += ' FOR UPDATE';
      const [ownRows] = await conn.query(ownSql, ownParams);
      if (!ownRows || ownRows.length === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'project not found' });
      }

      const [photoRows] = await conn.query(
        `SELECT id, url, thumb_url AS thumbUrl, playback_url AS playbackUrl
         FROM photos
         WHERE project_id = ?`,
        [id]
      );
      photos = photoRows || [];

      if (photos.length > 0) {
        await conn.query('DELETE FROM photos WHERE project_id = ?', [id]);
      }

      const [result] = await conn.query('DELETE FROM projects WHERE id = ?', [id]);
      if (result.affectedRows === 0) {
        await conn.rollback();
        return res.status(404).json({ error: 'project not found' });
      }

      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch (e) { }
      throw err;
    } finally {
      try { conn.release(); } catch (e) { }
    }

    const storageDeleteResult = await cosStorage.deleteObjectsForPhotoRows(photos);
    if (storageDeleteResult.errors && storageDeleteResult.errors.length) {
      console.error('[projects.delete] COS delete errors:', storageDeleteResult.errors);
    }

    const deletedFiles = [];
    const notFoundFiles = [];
    async function tryUnlink(absPath) {
      try {
        await fs.promises.unlink(absPath);
        deletedFiles.push(absPath);
      } catch (err) {
        if (err && err.code === 'ENOENT') notFoundFiles.push(absPath);
        else console.error('[projects.delete] unlink error:', absPath, err && err.message ? err.message : err);
      }
    }

    if (!skipLocalFileCheck) {
      for (const p of photos) {
        if (p.url && !/^https?:\/\//i.test(String(p.url))) {
          let rel = p.url.replace(/^\/uploads[\\\/]/, '');
          rel = rel.split('/').join(path.sep);
          await tryUnlink(path.join(uploadRoot, rel));
        }
        if (p.thumbUrl && !/^https?:\/\//i.test(String(p.thumbUrl))) {
          let rel = p.thumbUrl.replace(/^\/uploads[\\\/]/, '');
          rel = rel.split('/').join(path.sep);
          await tryUnlink(path.join(uploadRoot, rel));
        }
      }
    }

    res.json({
      success: true,
      deletedProjectId: id,
      deletedPhotoIds: photos.map(p => p.id),
      storageDeleted: storageDeleteResult.deleted || [],
      storageErrors: storageDeleteResult.errors || [],
      deletedFiles,
      notFoundFiles
    });
  } catch (err) {
    console.error('DELETE /api/projects/:id error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
