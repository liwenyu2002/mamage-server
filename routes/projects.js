// routes/projects.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

// 上传根目录（和 upload.js 保持一致）
const uploadRoot = path.join(__dirname, '..', 'uploads');

// TODO: 这里先“假装登录用户”，一步到位写死你的管理员 id
// 去 users 表里查一下你自己的 id，把 1 改成真实值
const CURRENT_ADMIN_ID = 1;

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

// ==============================
// 1. 首页项目列表：GET /api/projects?limit=4
// ==============================
router.get('/', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 50) {
      limit = 10;
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
      ORDER BY p.created_at DESC
      LIMIT ?
      `,
      [limit]
    );

    const list = rows.map((r) => ({
      ...r,
      meta: parseMeta(r.meta)
    }));

    res.json(list);
  } catch (err) {
    console.error('[GET /api/projects] error:', err);
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
      whereClauses.push(`
        (
          p.name LIKE ?
          OR p.description LIKE ?
          OR p.event_date LIKE ?
          OR p.meta LIKE ?
        )
      `);
      params.push(like, like, like, like);
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
      ${whereSql}
      ORDER BY p.created_at DESC
      LIMIT ? OFFSET ?
      `,
      [...params, pageSize, offset]
    );

    const list = rows.map((r) => ({
      ...r,
      meta: parseMeta(r.meta)
    }));

    const hasMore = page * pageSize < total;

    res.json({
      list,
      page,
      pageSize,
      total,
      hasMore
    });
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

    const [projRows] = await pool.query(
      `
      SELECT
        p.id,
        p.uuid,
        p.name AS projectName,
        p.description,
        p.event_date AS eventDate,
        p.meta,
        p.photo_ids AS photoIds,
        p.admin_id AS adminId,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM projects p
      WHERE p.id = ?
      `,
      [id]
    );

    if (!projRows.length) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = projRows[0];
    project.meta = parseMeta(project.meta);

    // 查该项目的所有照片
    const [photoRows] = await pool.query(
      `
      SELECT
        ph.id,
        ph.uuid,
        ph.project_id AS projectId,
        ph.url,
        ph.thumb_url AS thumbUrl,
        ph.local_path AS localPath,
        ph.title,
        ph.tags,
        ph.type,
        ph.photographer_id AS photographerId,
        ph.created_at AS createdAt,
        ph.updated_at AS updatedAt
      FROM photos ph
      WHERE ph.project_id = ?
      ORDER BY ph.created_at ASC, ph.id ASC
      `,
      [id]
    );

    project.photos = photoRows;

    res.json(project);
  } catch (err) {
    console.error('[GET /api/projects/:id] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 4. 创建项目：POST /api/projects
// ==============================
router.post('/', async (req, res) => {
  try {
    const body = req.body || {};

    const finalName = (body.projectName || body.name || body.title || '').trim();
    const finalDesc = (body.description || body.desc || '').trim();
    const rawEventDate = (body.eventDate || '').trim() || null;

    if (!finalName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    const uuid = uuidv4();
    const adminId = CURRENT_ADMIN_ID; // 以后接入登录后改成 req.user.id

    const metaObj = {};
    if (rawEventDate) {
      metaObj.eventDate = rawEventDate;
    }

    const [result] = await pool.query(
      `
      INSERT INTO projects
        (uuid, name, description, event_date, meta, admin_id, created_at, updated_at)
      VALUES
        (?, ?, ?, ?, ?, ?, NOW(), NOW())
      `,
      [uuid, finalName, finalDesc, rawEventDate, JSON.stringify(metaObj), adminId]
    );

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

    res.json(project);
  } catch (err) {
    console.error('[POST /api/projects] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 5. 更新项目：POST /api/projects/:id/update
// ==============================
router.post('/:id/update', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ error: 'Invalid project id' });
    }

    const body = req.body || {};

    const finalName = (body.projectName || body.name || body.title || '').trim();
    const finalDesc = (body.description || body.desc || '').trim();
    const rawEventDate = (body.eventDate || '').trim() || null;

    if (!finalName) {
      return res.status(400).json({ error: 'projectName is required' });
    }

    const [result] = await pool.query(
      `
      UPDATE projects
      SET
        name = ?,
        description = ?,
        event_date = ?,
        updated_at = NOW()
      WHERE id = ?
      `,
      [finalName, finalDesc, rawEventDate, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Project not found' });
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

    res.json(project);
  } catch (err) {
    console.error('[POST /api/projects/:id/update] error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==============================
// 6. 删除项目：DELETE /api/projects/:id
// ==============================
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id || Number.isNaN(id)) {
    return res.status(400).json({ error: 'invalid project id' });
  }

  try {
    // 1. 查询该项目下所有照片
    const [photos] = await pool.query(
      `SELECT id, local_path AS localPath, thumb_url AS thumbUrl
       FROM photos
       WHERE project_id = ?`,
      [id]
    );

    // 2. 删除照片文件（原图 + 缩略图）
    for (const p of photos) {
      // 原图
      if (p.localPath) {
        try {
          if (fs.existsSync(p.localPath)) {
            fs.unlink(p.localPath, err => {
              if (err) {
                console.error('unlink photo file error:', p.localPath, err.message);
              } else {
                console.log('photo file deleted:', p.localPath);
              }
            });
          }
        } catch (e) {
          console.error('check/unlink photo error:', p.localPath, e.message);
        }
      }

      // 缩略图（通过 thumbUrl 还原绝对路径）
      if (p.thumbUrl) {
        try {
          // 形如 /uploads/2025/11/16/thumbs/thumb_xxx.jpg
          let rel = p.thumbUrl.replace(/^\/uploads[\\/]/, ''); // 去掉 /uploads/
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
        } catch (e) {
          console.error('check/unlink thumb error:', p.thumbUrl, e.message);
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
