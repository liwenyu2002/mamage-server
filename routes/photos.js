const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const uploadModule = require('./upload');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
// 与 upload.js/app.js 保持一致：优先使用 UPLOAD_ABS_DIR 环境变量
const uploadsAbsDir = process.env.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
const uploadRoot = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

// 根据 users 表里实际的 id 改这两个值
// 例如：你自己的 admin 用户 id = 1，测试摄影师 id = 2
const CURRENT_ADMIN_ID = 1;
const CURRENT_PHOTOGRAPHER_ID = 2; // 暂时没在本文件里用，将来上传照片时会用上

// ========= 1) 照片列表接口：支持 projectId + random =========
// 如果挂在 /api/photos 下：GET /api/photos?projectId=1&limit=4&random=1&type=normal(可选)
router.get('/', async (req, res) => {
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
        id,
        uuid,
        project_id      AS projectId,
        url,
        thumb_url       AS thumbUrl,
        title,
        tags,
        type,
        photographer_id AS photographerId,   -- ✅ 新增：把摄影师 id 查出来
        created_at      AS createdAt,
        updated_at      AS updatedAt
      FROM photos
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

    const mapped = rows.map((p) => ({
      ...p,
      // 覆盖返回的 url/thumbUrl 为完整地址，保持字段名不变，便于前端不改代码
      url: p.url ? buildUploadUrl(p.url) : null,
      thumbUrl: p.thumbUrl ? buildUploadUrl(p.thumbUrl) : null
    }));

    res.json(mapped);
  } catch (err) {
    console.error('GET /api/photos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========= 2) 照片删除接口：POST /api/photos/delete =========
router.post('/delete', async (req, res) => {
  try {
    let ids = req.body.photoIds;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'photoIds must be a non-empty array' });
    }

    ids = ids
      .map((n) => parseInt(n, 10))
      .filter((n) => !Number.isNaN(n));

    if (ids.length === 0) {
      return res.status(400).json({ error: 'no valid photo id' });
    }

    const [rows] = await pool.query(
      `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl
       FROM photos
       WHERE id IN (?)`,
      [ids]
    );

    if (rows.length === 0) {
      return res.json({ deletedIds: [], notFoundIds: ids });
    }

    const foundIds = rows.map((r) => r.id);
    const notFoundIds = ids.filter((id) => !foundIds.includes(id));

    await pool.query(
      `DELETE FROM photos
       WHERE id IN (?)`,
      [foundIds]
    );

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

    for (const row of rows) {
      try {
        // 删除原图（通过 url 还原绝对路径）
        if (row.url) {
          let rel = row.url.replace(/^\/uploads[\\/]/, '');
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          console.log('[photos.delete] try unlink', abs);
          if (fs.existsSync(abs)) {
            fs.unlink(abs, (err) => {
              if (err) console.error('unlink photo file error:', abs, err.message);
              else console.log('photo file deleted:', abs);
            });
          } else {
            console.log('[photos.delete] file not found:', abs);
          }
        }

        // 删除缩略图（通过 thumbUrl 还原绝对路径）
        if (row.thumbUrl) {
          let relt = row.thumbUrl.replace(/^\/uploads[\\/]/, '');
          relt = relt.split('/').join(path.sep);
          const absThumb = path.join(uploadRoot, relt);
          console.log('[photos.delete] try unlink thumb', absThumb);
          if (fs.existsSync(absThumb)) {
            fs.unlink(absThumb, (err) => {
              if (err) console.error('unlink thumb file error:', absThumb, err.message);
              else console.log('thumb file deleted:', absThumb);
            });
          } else {
            console.log('[photos.delete] thumb not found:', absThumb);
          }
        }
      } catch (e) {
        console.error('check/unlink file error:', e.message);
      }
    }

    res.json({ deletedIds: foundIds, notFoundIds });
  } catch (err) {
    console.error('POST /api/photos/delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 兼容前端历史路径：POST /api/photos/upload -> 复用 upload.js 的处理逻辑
if (uploadModule && uploadModule.upload && uploadModule.processUpload) {
  router.post('/upload', uploadModule.upload.single('file'), uploadModule.processUpload);
}

module.exports = router;

// POST /api/photos/zip
// 请求 body: { photoIds: [1,2,3], zipName: 'my-photos' }
// 返回: application/zip attachment
router.post('/zip', async (req, res) => {
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
    const [rows] = await pool.query(
      `SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, title FROM photos WHERE id IN (?)`,
      [ids]
    );

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
        let rel = r.url.replace(/^\/uploads[\\/]/, '');
        rel = rel.split('/').join(path.sep);
        const abs = path.join(uploadRoot, rel);
        if (!fs.existsSync(abs)) {
          console.warn('[photos.zip] file not found, skip:', abs);
          continue;
        }

        const projId = r.projectId || 0;
        const rawProjName = projMap[projId] || `project-${projId}`;
        // sanitize project name for file names
        const safeProjName = String(rawProjName).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || `project-${projId}`;

        counters[projId] = (counters[projId] || 0) + 1;
        const seq = counters[projId];

        const ext = path.extname(abs) || '';
        const nameInZip = `${safeProjName}-${seq}${ext}`;
        archive.file(abs, { name: nameInZip });
      } catch (e) {
        console.error('add file to zip error:', e.message);
      }
    }

    // finalize
    archive.finalize();
  } catch (err) {
    console.error('POST /api/photos/zip error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});
