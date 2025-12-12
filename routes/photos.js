const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const uploadModule = require('./upload');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const keys = require('../config/keys');
const JWT_SECRET = keys.JWT_SECRET || 'please-change-this-secret';
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
  } catch (e) {}
  // 如果没有配置 UPLOAD_ABS_DIR，说明没有本地 uploads 目录，跳过本地检查
  if (!keys.UPLOAD_ABS_DIR) return true;
  return false;
})();

// 根据 users 表里实际的 id 改这两个值
// 例如：你自己的 admin 用户 id = 1，测试摄影师 id = 2
const CURRENT_ADMIN_ID = 1;
const CURRENT_PHOTOGRAPHER_ID = 2; // 暂时没在本文件里用，将来上传照片时会用上

// ========= 1) 照片列表接口：支持 projectId + random =========
// 如果挂在 /api/photos 下：GET /api/photos?projectId=1&limit=4&random=1&type=normal(可选)
const { requirePermission, requireAdmin } = require('../lib/permissions');

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
      conds.push('type = ?');
      params.push(type);
    }
    if (!Number.isNaN(projectId) && projectId) {
      conds.push('project_id = ?');
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
      sql += ' ORDER BY created_at DESC';
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
        description: p.description || null
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error('GET /api/photos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 基于数据库的权限检查（使用 role_permissions 表）

// 照片删除（仅 admin）
router.post('/delete', requirePermission('photos.delete'), async (req, res) => {
  try {
    let ids = req.body.photoIds;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'photoIds must be a non-empty array' });
    }

    ids = ids
      .map((n) => parseInt(n, 10))
      .filter((n) => !Number.isNaN(n));

    // debug log: who requested deletion and which ids
    try { console.log('[photos.delete] requested by user=%s ids=%o', req.user && req.user.id, ids); } catch (e) {}

    if (ids.length === 0) {
      return res.status(400).json({ error: 'no valid photo id' });
    }

    // enforce organization scoping on delete
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let selSql = `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl FROM photos WHERE id IN (?)`;
    const selParams = [ids];
    if (orgId === null) {
      selSql += ' AND organization_id IS NULL';
    } else {
      selSql += ' AND organization_id = ?';
      selParams.push(orgId);
    }
    const [rows] = await pool.query(selSql, selParams);

    if (rows.length === 0) {
      return res.json({ deletedIds: [], notFoundIds: ids });

    
    }

    const foundIds = rows.map((r) => r.id);
    const notFoundIds = ids.filter((id) => !foundIds.includes(id));

    // delete only within same organization (foundIds already filtered)
    if (foundIds.length > 0) {
      let delSql = 'DELETE FROM photos WHERE id IN (?)';
      const delParams = [foundIds];
      await pool.query(delSql, delParams);
    }

    // 同步更新 projects.photo_ids：对每个受影响的 project，移除这些 photo id
    const byProject = {};
    for (const r of rows) {
      if (!r.projectId) continue;
      byProject[r.projectId] = byProject[r.projectId] || [];
      byProject[r.projectId].push(r.id);
    }

    for (const [projIdStr, removedIds] of Object.entries(byProject)) {
      const projId = Number(projIdStr);
      try {
        const [projRows] = await pool.query(`SELECT photo_ids FROM projects WHERE id = ?`, [projId]);
        if (projRows && projRows.length) {
          let existing = projRows[0].photo_ids;
          let arr = [];
          if (existing) {
            if (typeof existing === 'string') {
              try {
                const parsed = JSON.parse(existing);
                if (Array.isArray(parsed)) arr = parsed.map(Number);
                else arr = String(existing).split(',').map(s => s.trim()).filter(Boolean).map(Number);
              } catch (e) {
                arr = String(existing).split(',').map(s => s.trim()).filter(Boolean).map(Number);
              }
            } else if (Array.isArray(existing)) {
              arr = existing.map(Number);
            }
          }

          arr = arr.filter(id => !removedIds.includes(id));
          const newVal = arr.length ? JSON.stringify(arr) : null;
          await pool.query(`UPDATE projects SET photo_ids = ? WHERE id = ?`, [newVal, projId]);
        }
      } catch (e) {
        console.error('failed to remove photo ids from project', projId, e.message);
      }
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

    for (const row of rows) {
      try {
        if (row.url) {
          let rel = row.url.replace(/^\/uploads[\\/]/, '');
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          // 尝试删除（如果不存在会被记录到 notFoundFiles）
          await tryUnlink(abs);
        }

        if (row.thumbUrl) {
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
      console.info('[photos.delete] user=%s deletedPhotoIds=%o deletedFiles=%d notFoundFiles=%d', req.user && req.user.id, foundIds, deletedFiles.length, notFoundFiles.length);
      console.debug && console.debug('[photos.delete] deletedFiles=%o notFoundFiles=%o', deletedFiles, notFoundFiles);
    } catch (e) {}

    res.json({ deletedIds: foundIds, notFoundIds });
  } catch (err) {
    console.error('POST /api/photos/delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});



module.exports = router;

// POST /api/photos/zip
// 请求 body: { photoIds: [1,2,3], zipName: 'my-photos' }
// 返回: application/zip attachment
router.post('/zip', requirePermission('photos.view'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body.photoIds) ? req.body.photoIds.map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n)) : [];
    if (ids.length === 0) return res.status(400).json({ error: 'photoIds must be a non-empty array' });

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
    const zipName = req.body.zipName && String(req.body.zipName).trim() ? `${String(req.body.zipName).trim()}.zip` : `photos-${Date.now()}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('error', (err) => {
      console.error('archive error:', err.message);
      try { res.status(500).end(); } catch (e) {}
    });

    // pipe archive to response
    archive.pipe(res);

    // counters per project
    const counters = {};

    // add files with project-based sequential naming
    for (const r of rows) {
      try {
        if (!r.url) continue;
        const urlStr = String(r.url);

        const projId = r.projectId || 0;
        const rawProjName = projMap[projId] || `project-${projId}`;
        // sanitize project name for file names
        const safeProjName = String(rawProjName).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || `project-${projId}`;

        counters[projId] = (counters[projId] || 0) + 1;
        const seq = counters[projId];

        // 如果是远程 URL（例如 COS 上的图片），通过 HTTP(S) 下载并把响应流追加到 zip
        if (/^https?:\/\//i.test(urlStr)) {
          const ext = path.extname(urlStr) || '';
          const nameInZip = `${safeProjName}-${seq}${ext}`;
          try {
            const client = urlStr.startsWith('https') ? require('https') : require('http');
            await new Promise((resolve) => {
              const req = client.get(urlStr, (response) => {
                if (response.statusCode >= 200 && response.statusCode < 300) {
                  archive.append(response, { name: nameInZip });
                } else {
                  console.warn('[photos.zip] remote file not available, skip:', urlStr, response.statusCode);
                  response.resume();
                }
                resolve();
              });
              req.on('error', (err) => {
                console.error('[photos.zip] remote download error:', urlStr, err && err.message ? err.message : err);
                resolve();
              });
            });
          } catch (e) {
            console.error('[photos.zip] append remote file failed:', e && e.message ? e.message : e);
          }
        } else {
          // 本地文件处理（保留原有行为）
          let rel = r.url.replace(/^\/uploads[\\\/]/, '');
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          if (!fs.existsSync(abs)) {
            console.warn('[photos.zip] file not found, skip:', abs);
            continue;
          }

          const ext = path.extname(abs) || '';
          const nameInZip = `${safeProjName}-${seq}${ext}`;
          archive.file(abs, { name: nameInZip });
        }
      } catch (e) {
        console.error('add file to zip error:', e && e.message ? e.message : e);
      }
    }

    // finalize
    archive.finalize();
  } catch (err) {
    console.error('POST /api/photos/zip error:', err);
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
router.patch('/:id', requirePermission('photos.update'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const { description, tags } = req.body || {};

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

    const [rows] = await pool.query('SELECT id, url, thumb_url AS thumbUrl, title, description, tags FROM photos WHERE id = ?', [id]);
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
      tags: parsedTags
    });
  } catch (err) {
    console.error('PATCH /api/photos/:id error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
