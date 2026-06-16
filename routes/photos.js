const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const keys = require('../config/keys');
const cosStorage = require('../lib/cos_storage');
const JWT_SECRET = keys.JWT_SECRET;
// 与 upload.js/app.js 保持一致：优先使用 UPLOAD_ABS_DIR 环境变量（从 config/keys 读取）
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
const uploadRoot = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

// 当图片迁移到远程对象存储（如腾讯云 COS）时，
// 默认在部署到没有本地 uploads 的环境（例如 ECS）时跳过本地文件存在性检查，
// 或者可通过环境变量 UPLOAD_SKIP_LOCAL_FILE_CHECK=1 强制跳过。
const skipLocalFileCheck = (() => {
  const envVal = String(process.env.UPLOAD_SKIP_LOCAL_FILE_CHECK || '').trim().toLowerCase();
  if (envVal === '1' || envVal === 'true' || envVal === 'yes') return true;
  // 如果配置了 UPLOAD_BASE_URL 并且是一个 http(s) 地址且不是 localhost/127.0.0.1，则默认跳过本地检查
  try {
    const base = (keys.UPLOAD_BASE_URL || '').trim();
    if (base && /^https?:\/\//i.test(base) && !/localhost|127\.0\.0\.1/.test(base)) return true;
  } catch (e) { }
  // 如果没有配置 UPLOAD_ABS_DIR，说明没有本地 uploads 目录，跳过本地检查
  if (!keys.UPLOAD_ABS_DIR) return true;
  return false;
})();

// ========= 1) 照片列表接口：支持 projectId + random =========
// 如果挂在 /api/photos 下：GET /api/photos?projectId=1&limit=4&random=1&type=normal(可选)
const { requirePermission, requireAdmin, hasPermissionForUserId } = require('../lib/permissions');
const MAX_SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_TOKENS = 5;
const MAX_SEARCH_QUERY_LEN = 64;
const MAX_DELETE_PHOTOS = Math.max(1, Number(process.env.PHOTO_DELETE_MAX_IDS || 200));
const MAX_ZIP_PHOTOS = Math.max(1, Number(process.env.PHOTO_ZIP_MAX_IDS || 50));
const ZIP_REMOTE_TIMEOUT_MS = Math.max(1000, Number(process.env.PHOTO_ZIP_REMOTE_TIMEOUT_MS || 20000));
const ZIP_MAX_REMOTE_BYTES = Math.max(1024 * 1024, Number(process.env.PHOTO_ZIP_MAX_REMOTE_BYTES || 1024 * 1024 * 1024));

async function populateReqUserFromAuthIfPresent(req) {
  try {
    if (req.user && req.user.id !== undefined) return;
    const auth = req.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.*)$/i);
    if (!m) return;
    const token = m[1];
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return; }
    if (!payload || !payload.id) return;
    const [rows] = await pool.query('SELECT id, organization_id, role FROM users WHERE id = ? LIMIT 1', [payload.id]);
    if (!rows || rows.length === 0) return;
    const u = rows[0];
    const org = (u.organization_id !== undefined && u.organization_id !== null) ? Number(u.organization_id) : null;
    req.user = { id: u.id, role: u.role || null, organization_id: org };
  } catch (e) {
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

function escapeLikeToken(input) {
  return String(input || '').replace(/[#%_]/g, '#$&');
}

function tokenizeSearchQuery(query) {
  const normalized = String(query || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_QUERY_LEN);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS);
}

function parsePhotoTags(rawTags) {
  if (!rawTags) return null;
  if (Array.isArray(rawTags)) return rawTags;
  try {
    const parsed = typeof rawTags === 'string' ? JSON.parse(rawTags) : rawTags;
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizePhotoAdjustments(input) {
  if (input === null) return null;
  if (input === undefined) return undefined;

  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const rawGains = Array.isArray(parsed.wbGains) ? parsed.wbGains : [];
  const wbGains = [0, 1, 2].map((idx) => clampNumber(rawGains[idx], 0.5, 1.8, 1));
  const source = String(parsed.source || 'manual').trim().slice(0, 24) || 'manual';

  return {
    version: 1,
    engine: 'mamage-tone-v1',
    brightness: clampNumber(parsed.brightness, -100, 100, 0),
    contrast: clampNumber(parsed.contrast, -100, 100, 0),
    temperature: clampNumber(parsed.temperature, -100, 100, 0),
    tint: clampNumber(parsed.tint, -100, 100, 0),
    wbGains,
    source,
    updatedAt: parsed.updatedAt ? String(parsed.updatedAt).slice(0, 64) : new Date().toISOString(),
  };
}

function parsePhotoAdjustments(rawAdjustments) {
  if (!rawAdjustments) return null;
  if (typeof rawAdjustments === 'object') return normalizePhotoAdjustments(rawAdjustments) || null;
  try {
    return normalizePhotoAdjustments(JSON.parse(rawAdjustments)) || null;
  } catch (e) {
    return null;
  }
}

function parseProjectPhotoIds(existing) {
  if (!existing) return [];
  if (Array.isArray(existing)) return existing.map(Number).filter(Number.isFinite);
  if (typeof existing === 'string') {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isFinite);
    } catch (e) {
      // fall back below
    }
    return existing.split(',').map((s) => Number(String(s).trim())).filter(Number.isFinite);
  }
  return [];
}

// GET /api/photos - require permission and organization scope
router.get('/', requirePermission('photos.view'), async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (Number.isNaN(limit) || limit <= 0 || limit > 100) {
      limit = 10;
    }

    const type = req.query.type || null;
    const projectId = req.query.projectId
      ? parseInt(req.query.projectId, 10)
      : null;
    const random = req.query.random === '1' || req.query.random === 'true';

    let sql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id      AS projectId,
        p.url,
        p.thumb_url       AS thumbUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.type,
        p.photographer_id AS photographerId,
        u.name            AS photographerName,
        p.created_at      AS createdAt,
        p.updated_at      AS updatedAt
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
    `;
    const conds = [];
    const params = [];

    if (type) {
      conds.push('p.type = ?');
      params.push(type);
    }
    if (!Number.isNaN(projectId) && projectId) {
      conds.push('p.project_id = ?');
      params.push(projectId);
    }

    // organization scoping: only return photos for user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    if (orgId === null) {
      conds.push('p.organization_id IS NULL');
    } else {
      conds.push('p.organization_id = ?');
      params.push(orgId);
    }

    if (conds.length > 0) {
      sql += ' WHERE ' + conds.join(' AND ');
    }

    if (random) {
      sql += ' ORDER BY RAND()';
    } else {
      sql += ' ORDER BY p.created_at DESC';
    }

    sql += ' LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(sql, params);

    const mapped = rows.map((p) => {
      // 如果文件不存在，返回一个内联 SVG 占位图（data URL）以避免浏览器断图
      function resolveUrl(raw) {
        if (!raw) return null;
        const str = String(raw);

        // 远程 URL 直接透传（例如 COS 返回的 https://bucket.cos...）
        if (/^https?:\/\//i.test(str)) {
          return str;
        }

        const finalUrl = buildUploadUrl(str);

        if (skipLocalFileCheck) {
          return finalUrl;
        }

        try {
          let rel = str;
          if (rel.startsWith('/uploads/')) {
            rel = rel.replace(/^\/uploads[\\/]/, '');
          } else if (rel.startsWith('uploads/')) {
            rel = rel.replace(/^uploads[\\/]/, '');
          }
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          if (fs.existsSync(abs)) return finalUrl;
        } catch (e) {
          // 本地检查失败时忽略，后面走占位图
        }

        // simple SVG placeholder（本地文件不存在且未跳过检查时使用）
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='%23f3f3f3'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='20' fill='%23999'>占位图</text></svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      }

      return {
        ...p,
        url: resolveUrl(p.url),
        thumbUrl: resolveUrl(p.thumbUrl),
        description: p.description || null,
        adjustments: parsePhotoAdjustments(p.adjustments)
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error('GET /api/photos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取随机风景（scenery 项目）照片
// GET /api/photos/scenery/random?limit=4&random=1
// 说明：风景由 projects.type = 'scenery' 决定
router.get('/scenery/random', requirePermission('photos.view'), async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (Number.isNaN(limit) || limit <= 0 || limit > 100) {
      limit = 4;
    }
    const random = req.query.random === '1' || req.query.random === 'true' || req.query.random === undefined;

    // organization scoping: only return photos for user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;

    let sql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id      AS projectId,
        p.url,
        p.thumb_url       AS thumbUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.type,
        p.photographer_id AS photographerId,
        u.name            AS photographerName,
        p.created_at      AS createdAt,
        p.updated_at      AS updatedAt
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
      INNER JOIN projects pr ON p.project_id = pr.id
      WHERE pr.type = 'scenery'
    `;

    const params = [];
    if (orgId === null) {
      sql += ' AND p.organization_id IS NULL';
    } else {
      sql += ' AND p.organization_id = ?';
      params.push(orgId);
    }

    if (random) {
      sql += ' ORDER BY RAND()';
    } else {
      sql += ' ORDER BY p.created_at DESC';
    }

    sql += ' LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(sql, params);

    const mapped = (rows || []).map((p) => {
      function resolveUrl(raw) {
        if (!raw) return null;
        const str = String(raw);
        if (/^https?:\/\//i.test(str)) return str;

        const finalUrl = buildUploadUrl(str);
        if (skipLocalFileCheck) return finalUrl;

        try {
          let rel = str;
          if (rel.startsWith('/uploads/')) {
            rel = rel.replace(/^\/uploads[\\/]/, '');
          } else if (rel.startsWith('uploads/')) {
            rel = rel.replace(/^uploads[\\/]/, '');
          }
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          if (fs.existsSync(abs)) return finalUrl;
        } catch (e) {
          // ignore
        }

        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='%23f3f3f3'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='20' fill='%23999'>占位图</text></svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      }

      return {
        ...p,
        url: resolveUrl(p.url),
        thumbUrl: resolveUrl(p.thumbUrl),
        description: p.description || null,
        adjustments: parsePhotoAdjustments(p.adjustments)
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error('GET /api/photos/scenery/random error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 基于数据库的权限检查（使用 role_permissions 表）

// 照片删除（仅 admin）
// GET /api/photos/search?q=xxx&page=1&pageSize=20&projectId=1&sort=relevance|newest
router.get('/search', async (req, res) => {
  try {
    await populateReqUserFromAuthIfPresent(req);
    const userId = req && req.user && req.user.id ? Number(req.user.id) : null;
    if (userId) {
      const ok = await hasPermissionForUserId(userId, 'photos.view');
      if (!ok) return res.status(403).json({ error: 'forbidden' });
    } else if (!isDemoRequest(req)) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }

    let page = parseInt(req.query.page, 10);
    let pageSize = parseInt(req.query.pageSize, 10);
    const rawSort = String(req.query.sort || '').toLowerCase();
    const sort = rawSort === 'newest' ? 'newest' : 'relevance';
    const tokens = tokenizeSearchQuery(req.query.q || '');

    if (!Number.isFinite(page) || page <= 0) page = 1;
    if (!Number.isFinite(pageSize) || pageSize <= 0 || pageSize > MAX_SEARCH_PAGE_SIZE) {
      pageSize = 20;
    }

    const hasProjectIdParam = req.query.projectId !== undefined && req.query.projectId !== null && String(req.query.projectId).trim() !== '';
    let projectId = null;
    if (hasProjectIdParam) {
      projectId = parseInt(req.query.projectId, 10);
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ error: 'invalid projectId' });
      }
    }

    const whereClauses = [];
    const whereParams = [];

    const orgId = getScopedOrgIdFromReq(req);
    if (orgId === null) {
      whereClauses.push('p.organization_id IS NULL');
    } else {
      whereClauses.push('p.organization_id = ?');
      whereParams.push(orgId);
    }

    if (projectId) {
      whereClauses.push('p.project_id = ?');
      whereParams.push(projectId);
    }

    if (tokens.length > 0) {
      tokens.forEach((token) => {
        const escaped = escapeLikeToken(token);
        const like = `%${escaped}%`;
        whereClauses.push(`(
          LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(CAST(p.tags AS CHAR), '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(p.url, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(p.thumb_url, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(u.nickname, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(u.student_no, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(CAST(p.photographer_id AS CHAR), '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(CONCAT('摄影师#', CAST(p.photographer_id AS CHAR)), '')) LIKE ? ESCAPE '#'
        )`);
        whereParams.push(like, like, like, like, like, like, like, like, like, like, like);
      });
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const baseFromSql = `
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
      LEFT JOIN projects pr ON p.project_id = pr.id
    `;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total ${baseFromSql} ${whereSql}`,
      whereParams
    );
    const total = (countRows && countRows[0] && Number(countRows[0].total)) || 0;
    const offset = (page - 1) * pageSize;

    const scoreParts = [];
    const scoreParams = [];
    if (tokens.length > 0) {
      tokens.forEach((token) => {
        const escaped = escapeLikeToken(token);
        const prefixLike = `${escaped}%`;
        const containLike = `%${escaped}%`;
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#' THEN 30 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#' THEN 26 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '#' THEN 24 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.nickname, '')) LIKE ? ESCAPE '#' THEN 24 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#' THEN 16 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#' THEN 14 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '#' THEN 12 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.nickname, '')) LIKE ? ESCAPE '#' THEN 12 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.student_no, '')) LIKE ? ESCAPE '#' THEN 8 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(CAST(p.photographer_id AS CHAR), '')) LIKE ? ESCAPE '#' THEN 6 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(CONCAT('摄影师#', CAST(p.photographer_id AS CHAR)), '')) LIKE ? ESCAPE '#' THEN 6 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '#' THEN 10 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(CAST(p.tags AS CHAR), '')) LIKE ? ESCAPE '#' THEN 10 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.url, '')) LIKE ? ESCAPE '#' THEN 4 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.thumb_url, '')) LIKE ? ESCAPE '#' THEN 4 ELSE 0 END`);
        scoreParams.push(containLike);
      });
    }
    const relevanceScoreSql = scoreParts.length ? scoreParts.join(' + ') : '0';
    const orderBySql = sort === 'relevance' && tokens.length > 0
      ? 'ORDER BY relevanceScore DESC, p.created_at DESC, p.id DESC'
      : 'ORDER BY p.created_at DESC, p.id DESC';

    const selectSql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id AS projectId,
        pr.name AS projectName,
        p.url,
        p.thumb_url AS thumbUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.type,
        p.photographer_id AS photographerId,
        COALESCE(NULLIF(u.name, ''), NULLIF(u.nickname, '')) AS photographerName,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        ${relevanceScoreSql} AS relevanceScore
      ${baseFromSql}
      ${whereSql}
      ${orderBySql}
      LIMIT ? OFFSET ?
    `;
    const selectParams = [...scoreParams, ...whereParams, pageSize, offset];
    const [rows] = await pool.query(selectSql, selectParams);

    const list = (rows || []).map((p) => ({
      id: p.id,
      uuid: p.uuid,
      projectId: p.projectId,
      projectName: p.projectName || null,
      url: p.url ? buildUploadUrl(p.url) : null,
      thumbUrl: p.thumbUrl ? buildUploadUrl(p.thumbUrl) : null,
      title: p.title || null,
      description: p.description || null,
      adjustments: parsePhotoAdjustments(p.adjustments),
      tags: parsePhotoTags(p.tags),
      type: p.type,
      photographerId: p.photographerId || null,
      photographerName: p.photographerName || null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      relevanceScore: Number(p.relevanceScore) || 0,
    }));

    const hasMore = page * pageSize < total;
    res.json({
      list,
      page,
      pageSize,
      total,
      hasMore,
      q: String(req.query.q || '').trim(),
      tokens,
      sort,
    });
  } catch (err) {
    console.error('GET /api/photos/search error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/delete', requirePermission('photos.delete'), async (req, res) => {
  let rows = [];
  let foundIds = [];
  let notFoundIds = [];
  try {
    let ids = req.body.photoIds;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'photoIds must be a non-empty array' });
    }

    ids = ids
      .map((n) => parseInt(n, 10))
      .filter((n) => !Number.isNaN(n));

    ids = Array.from(new Set(ids));

    // debug log: who requested deletion and which ids
    try { console.log('[photos.delete] requested by user=%s ids=%o', req.user && req.user.id, ids); } catch (e) { }

    if (ids.length === 0) {
      return res.status(400).json({ error: 'no valid photo id' });
    }
    if (ids.length > MAX_DELETE_PHOTOS) {
      return res.status(413).json({ error: 'TOO_MANY_PHOTOS', maxPhotoIds: MAX_DELETE_PHOTOS });
    }

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let selSql = 'SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl FROM photos WHERE id IN (?)';
      const selParams = [ids];
      if (orgId === null) {
        selSql += ' AND organization_id IS NULL';
      } else {
        selSql += ' AND organization_id = ?';
        selParams.push(orgId);
      }
      const [selectedRows] = await conn.query(selSql, selParams);
      rows = selectedRows || [];

      if (rows.length === 0) {
        await conn.rollback();
        return res.json({ deletedIds: [], notFoundIds: ids });
      }

      foundIds = rows.map((r) => r.id);
      notFoundIds = ids.filter((id) => !foundIds.includes(id));

      await conn.query('DELETE FROM photos WHERE id IN (?)', [foundIds]);

      const byProject = {};
      for (const r of rows) {
        if (!r.projectId) continue;
        byProject[r.projectId] = byProject[r.projectId] || [];
        byProject[r.projectId].push(r.id);
      }

      for (const [projIdStr, removedIds] of Object.entries(byProject)) {
        const projId = Number(projIdStr);
        const [projRows] = await conn.query('SELECT photo_ids FROM projects WHERE id = ? FOR UPDATE', [projId]);
        if (!projRows || !projRows.length) continue;
        const arr = parseProjectPhotoIds(projRows[0].photo_ids).filter((id) => !removedIds.includes(id));
        await conn.query('UPDATE projects SET photo_ids = ? WHERE id = ?', [arr.length ? JSON.stringify(arr) : null, projId]);
      }

      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch (e) { }
      throw err;
    } finally {
      try { conn.release(); } catch (e) { }
    }

    // 删除文件（使用 promises 并汇总结果，避免大量逐文件日志）
    const fsp = fs.promises;
    const deletedFiles = [];
    const notFoundFiles = [];

    async function tryUnlink(absPath) {
      try {
        await fsp.unlink(absPath);
        deletedFiles.push(absPath);
      } catch (err) {
        if (err && err.code === 'ENOENT') {
          notFoundFiles.push(absPath);
        } else {
          console.error('[photos.delete] unlink error:', absPath, err && err.message ? err.message : err);
        }
      }
    }

    const storageDeleteResult = await cosStorage.deleteObjectsForPhotoRows(rows);
    if (storageDeleteResult.errors && storageDeleteResult.errors.length) {
      console.error('[photos.delete] COS delete errors:', storageDeleteResult.errors);
    }

    for (const row of rows) {
      try {
        if (row.url && !skipLocalFileCheck && !/^https?:\/\//i.test(String(row.url))) {
          let rel = row.url.replace(/^\/uploads[\\/]/, '');
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          // 尝试删除（如果不存在会被记录到 notFoundFiles）
          await tryUnlink(abs);
        }

        if (row.thumbUrl && !skipLocalFileCheck && !/^https?:\/\//i.test(String(row.thumbUrl))) {
          let relt = row.thumbUrl.replace(/^\/uploads[\\/]/, '');
          relt = relt.split('/').join(path.sep);
          const absThumb = path.join(uploadRoot, relt);
          await tryUnlink(absThumb);
        }
      } catch (e) {
        console.error('[photos.delete] check/unlink file error:', e && e.message ? e.message : e);
      }
    }

    // 输出一条摘要日志；详细列表为 debug
    try {
      console.info('[photos.delete] user=%s deletedPhotoIds=%o deletedFiles=%d notFoundFiles=%d storageDeleted=%d storageErrors=%d', req.user && req.user.id, foundIds, deletedFiles.length, notFoundFiles.length, (storageDeleteResult.deleted || []).length, (storageDeleteResult.errors || []).length);
      console.debug && console.debug('[photos.delete] deletedFiles=%o notFoundFiles=%o', deletedFiles, notFoundFiles);
    } catch (e) { }

    res.json({
      deletedIds: foundIds,
      notFoundIds,
      storageDeleted: storageDeleteResult.deleted || [],
      storageErrors: storageDeleteResult.errors || [],
    });
  } catch (err) {
    console.error('POST /api/photos/delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// POST /api/photos/zip
// 请求 body: { photoIds: [1,2,3], zipName: 'my-photos' }
// 返回: application/zip attachment
router.post('/zip', requirePermission('photos.view'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.photoIds)
      ? Array.from(new Set(req.body.photoIds.map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n))))
      : [];
    if (ids.length === 0) return res.status(400).json({ error: 'photoIds must be a non-empty array' });
    if (ids.length > MAX_ZIP_PHOTOS) {
      return res.status(413).json({ error: 'TOO_MANY_PHOTOS', maxPhotoIds: MAX_ZIP_PHOTOS });
    }

    // 延迟 require archiver，这样在缺少依赖时能返回友好提示
    let archiver;
    try {
      archiver = require('archiver');
    } catch (e) {
      console.error('archiver not installed:', e.message);
      return res.status(500).json({ error: 'Server requires module "archiver". Run: npm install archiver' });
    }

    // 查询照片及其 project_id
    // enforce organization scoping for zip
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let zipSql = `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, title FROM photos WHERE id IN (?)`;
    const zipParams = [ids];
    if (orgId === null) {
      zipSql += ' AND organization_id IS NULL';
    } else {
      zipSql += ' AND organization_id = ?';
      zipParams.push(orgId);
    }
    const [rows] = await pool.query(zipSql, zipParams);

    if (!rows || rows.length === 0) return res.status(404).json({ error: 'no photos found' });

    // 查询相关项目名
    const projIds = [...new Set(rows.map(r => r.projectId).filter(Boolean))];
    let projMap = {};
    if (projIds.length > 0) {
      const [projRows] = await pool.query(`SELECT id, name FROM projects WHERE id IN (?)`, [projIds]);
      for (const p of projRows) {
        projMap[p.id] = p.name || `project-${p.id}`;
      }
    }

    // prepare zip
    const rawZipName = req.body.zipName && String(req.body.zipName).trim() ? String(req.body.zipName).trim() : `photos-${Date.now()}`;
    const safeZipBase = rawZipName.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 96) || `photos-${Date.now()}`;
    const zipName = safeZipBase.toLowerCase().endsWith('.zip') ? safeZipBase : `${safeZipBase}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.setHeader('X-Accel-Buffering', 'no');

    const archive = archiver('zip', { store: true, zlib: { level: 0 } });
    const activeRequests = new Set();
    let clientClosed = false;

    res.on('close', () => {
      if (res.writableEnded) return;
      clientClosed = true;
      for (const activeReq of activeRequests) {
        try { activeReq.destroy(new Error('CLIENT_CLOSED')); } catch (e) { }
      }
      try { archive.abort(); } catch (e) { }
    });

    archive.on('error', (err) => {
      console.error('archive error:', err.message);
      try { res.status(500).end(); } catch (e) { }
    });
    archive.on('warning', (err) => {
      console.warn('archive warning:', err && err.message ? err.message : err);
    });

    // pipe archive to response
    archive.pipe(res);

    // counters per project
    const counters = {};
    let addedFileCount = 0;

    const getExtFromUrl = (u) => {
      try {
        return path.extname(new URL(u).pathname) || '';
      } catch (e) {
        return path.extname(String(u || '')) || '';
      }
    };

    const appendRemoteFileToArchive = async (remoteUrl, nameInZip) => {
      try {
        if (clientClosed) return false;
        const client = remoteUrl.startsWith('https') ? require('https') : require('http');
        const { PassThrough } = require('stream');
        return await new Promise((resolve) => {
          const req = client.get(remoteUrl, (response) => {
            activeRequests.delete(req);
            if (response.statusCode >= 200 && response.statusCode < 300) {
              const contentLength = Number(response.headers['content-length'] || 0);
              if (Number.isFinite(contentLength) && contentLength > ZIP_MAX_REMOTE_BYTES) {
                console.warn('[photos.zip] remote file too large, skip:', remoteUrl, contentLength);
                response.resume();
                resolve(false);
                return;
              }
              const passthrough = new PassThrough();
              let received = 0;
              response.on('data', (chunk) => {
                received += chunk.length;
                if (received > ZIP_MAX_REMOTE_BYTES) {
                  console.warn('[photos.zip] remote stream exceeded max bytes, abort:', remoteUrl);
                  response.destroy(new Error('REMOTE_FILE_TOO_LARGE'));
                  passthrough.destroy(new Error('REMOTE_FILE_TOO_LARGE'));
                }
              });
              response.on('error', (err) => {
                console.error('[photos.zip] remote response error:', remoteUrl, err && err.message ? err.message : err);
              });
              response.pipe(passthrough);
              archive.append(passthrough, { name: nameInZip, store: true });
              addedFileCount += 1;
              resolve(true);
              return;
            }
            console.warn('[photos.zip] remote file not available, skip:', remoteUrl, response.statusCode);
            response.resume();
            resolve(false);
          });
          activeRequests.add(req);
          req.setTimeout(ZIP_REMOTE_TIMEOUT_MS, () => {
            req.destroy(new Error('REMOTE_DOWNLOAD_TIMEOUT'));
          });
          req.on('error', (err) => {
            activeRequests.delete(req);
            console.error('[photos.zip] remote download error:', remoteUrl, err && err.message ? err.message : err);
            resolve(false);
          });
        });
      } catch (e) {
        console.error('[photos.zip] append remote file failed:', e && e.message ? e.message : e);
        return false;
      }
    };

    // add files with project-based sequential naming
    for (const r of rows) {
      if (clientClosed) break;
      try {
        if (!r.url) continue;
        const rawPath = String(r.url).trim();
        if (!rawPath) continue;

        const projId = r.projectId || 0;
        const rawProjName = projMap[projId] || `project-${projId}`;
        // sanitize project name for file names
        const safeProjName = String(rawProjName).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || `project-${projId}`;

        counters[projId] = (counters[projId] || 0) + 1;
        const seq = counters[projId];

        // 如果是远程 URL（例如 COS 上的图片），通过 HTTP(S) 下载并把响应流追加到 zip
        if (/^https?:\/\//i.test(rawPath)) {
          const ext = getExtFromUrl(rawPath);
          const nameInZip = `${safeProjName}-${seq}${ext}`;
          await appendRemoteFileToArchive(rawPath, nameInZip);
        } else {
          // 本地文件处理（保留原有行为）
          let rel = rawPath.replace(/^\/?uploads[\\\/]/i, '');
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          if (!fs.existsSync(abs)) {
            // local miss -> fallback to remote original URL
            const fallbackRemoteUrl = buildUploadUrl(rawPath);
            if (/^https?:\/\//i.test(String(fallbackRemoteUrl || ''))) {
              const ext = getExtFromUrl(fallbackRemoteUrl);
              const nameInZip = `${safeProjName}-${seq}${ext}`;
              await appendRemoteFileToArchive(fallbackRemoteUrl, nameInZip);
              continue;
            }
            console.warn('[photos.zip] file not found and no remote fallback URL:', rawPath);
            continue;
          }

          const ext = path.extname(abs) || '';
          const nameInZip = `${safeProjName}-${seq}${ext}`;
          archive.file(abs, { name: nameInZip, store: true });
          addedFileCount += 1;
        }
      } catch (e) {
        console.error('add file to zip error:', e && e.message ? e.message : e);
      }
    }

    if (addedFileCount === 0) {
      console.warn('[photos.zip] no files were added to archive, check photo urls and upload config');
    }

    // finalize
    if (!clientClosed) archive.finalize();
  } catch (err) {
    console.error('POST /api/photos/zip error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// GET /api/photos/:id/pixel-source
// Authenticated same-origin image bytes for front-end canvas analysis.
router.get('/:id/pixel-source', requirePermission('photos.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let sql = 'SELECT id, url, thumb_url AS thumbUrl FROM photos WHERE id = ?';
    const params = [id];
    if (orgId === null) {
      sql += ' AND organization_id IS NULL';
    } else {
      sql += ' AND organization_id = ?';
      params.push(orgId);
    }
    sql += ' LIMIT 1';

    const [rows] = await pool.query(sql, params);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'photo not found' });

    const row = rows[0];
    const variant = String(req.query.variant || 'thumb').toLowerCase();
    const raw = variant === 'original' ? (row.url || row.thumbUrl) : (row.thumbUrl || row.url);
    if (!raw) return res.status(404).json({ error: 'photo source not found' });

    const built = /^https?:\/\//i.test(String(raw)) ? String(raw) : buildUploadUrl(raw);
    const targetUrl = /^https?:\/\//i.test(built)
      ? built
      : `${req.protocol}://${req.get('host')}${String(built).startsWith('/') ? built : `/${built}`}`;
    const response = await fetch(targetUrl, {
      timeout: Math.max(1000, Number(process.env.PHOTO_PIXEL_SOURCE_TIMEOUT_MS || 15000)),
      headers: { 'User-Agent': 'MaMage pixel analyzer' },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'photo source unavailable', status: response.status });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(contentType)) {
      return res.status(415).json({ error: 'photo source is not an image' });
    }

    const contentLength = response.headers.get('content-length');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    response.body.on('error', (err) => {
      console.error('pixel-source stream error:', err && err.message ? err.message : err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    response.body.pipe(res);
  } catch (err) {
    console.error('GET /api/photos/:id/pixel-source error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// 获取单张照片（包含 photographerName）
// GET /api/photos/:id
router.get('/:id', requirePermission('photos.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let sql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id AS projectId,
        p.url,
        p.thumb_url AS thumbUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.type,
        p.photographer_id AS photographerId,
        u.name AS photographerName,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
      WHERE p.id = ?`;

    // apply organization scoping for single photo
    const params = [id];
    if (orgId === null) {
      sql += ' AND p.organization_id IS NULL';
    } else {
      sql += ' AND p.organization_id = ?';
      params.push(orgId);
    }
    sql += ' LIMIT 1';

    const [rows] = await pool.query(sql, params);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'photo not found' });

    const p = rows[0];

    function resolveUrl(raw) {
      if (!raw) return null;
      const str = String(raw);
      if (/^https?:\/\//i.test(str)) return str;
      return buildUploadUrl(str);
    }

    let parsedTags = null;
    try { parsedTags = p.tags ? JSON.parse(p.tags) : null; } catch (e) { parsedTags = null; }

    res.json({
      id: p.id,
      uuid: p.uuid,
      projectId: p.projectId,
      url: resolveUrl(p.url),
      thumbUrl: resolveUrl(p.thumbUrl),
      title: p.title,
      description: p.description || null,
      adjustments: parsePhotoAdjustments(p.adjustments),
      tags: parsedTags,
      type: p.type,
      photographerId: p.photographerId || null,
      photographerName: p.photographerName || null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    });
  } catch (err) {
    console.error('GET /api/photos/:id error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// 更新单张照片的 description 与 tags
// PATCH /api/photos/:id
router.patch('/:id', requirePermission('photos.edit'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const { description, tags, adjustments } = req.body || {};

    const updates = [];
    const params = [];

    if (typeof description !== 'undefined') {
      updates.push('description = ?');
      params.push(description === null ? null : String(description));
    }

    if (typeof tags !== 'undefined') {
      let tagsVal = null;
      if (tags === null) {
        tagsVal = null;
      } else if (Array.isArray(tags)) {
        tagsVal = JSON.stringify(tags);
      } else if (typeof tags === 'string') {
        // try parse JSON string like '["a","b"]' or comma separated 'a,b'
        try {
          const parsed = JSON.parse(tags);
          if (Array.isArray(parsed)) tagsVal = JSON.stringify(parsed);
          else tagsVal = JSON.stringify([String(tags)]);
        } catch (e) {
          // fallback: comma separated
          const arr = String(tags).split(',').map(s => s.trim()).filter(Boolean);
          tagsVal = arr.length ? JSON.stringify(arr) : JSON.stringify([]);
        }
      }

      updates.push('tags = ?');
      params.push(tagsVal);
    }

    if (typeof adjustments !== 'undefined') {
      const normalizedAdjustments = normalizePhotoAdjustments(adjustments);
      if (adjustments !== null && !normalizedAdjustments) {
        return res.status(400).json({ error: 'invalid adjustments' });
      }
      updates.push('adjustments = ?');
      params.push(normalizedAdjustments ? JSON.stringify(normalizedAdjustments) : null);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });

    // enforce organization scoping: ensure photo belongs to user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let ownershipSql = 'SELECT id FROM photos WHERE id = ?';
    const ownershipParams = [id];
    if (orgId === null) {
      ownershipSql += ' AND organization_id IS NULL';
    } else {
      ownershipSql += ' AND organization_id = ?';
      ownershipParams.push(orgId);
    }
    const [ownRows] = await pool.query(ownershipSql, ownershipParams);
    if (!ownRows || ownRows.length === 0) return res.status(404).json({ error: 'photo not found' });

    params.push(id);
    const sql = `UPDATE photos SET ${updates.join(', ')} WHERE id = ?`;
    await pool.query(sql, params);

    const [rows] = await pool.query('SELECT id, url, thumb_url AS thumbUrl, title, description, adjustments, tags FROM photos WHERE id = ?', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'photo not found' });

    const p = rows[0];
    // ensure tags is parsed for response
    let parsedTags = null;
    try { parsedTags = p.tags ? JSON.parse(p.tags) : null; } catch (e) { parsedTags = null; }

    res.json({
      id: p.id,
      url: buildUploadUrl(p.url),
      thumbUrl: buildUploadUrl(p.thumbUrl),
      title: p.title,
      description: p.description,
      adjustments: parsePhotoAdjustments(p.adjustments),
      tags: parsedTags
    });
  } catch (err) {
    console.error('PATCH /api/photos/:id error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
