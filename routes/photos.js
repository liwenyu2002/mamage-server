const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

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
        local_path      AS localPath,
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
    res.json(rows);
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
      `SELECT id, local_path AS localPath
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

    for (const row of rows) {
      const p = row.localPath;
      if (!p) continue;
      try {
        if (fs.existsSync(p)) {
          fs.unlink(p, (err) => {
            if (err) {
              console.error('unlink photo file error:', p, err.message);
            } else {
              console.log('photo file deleted:', p);
            }
          });
        }
      } catch (e) {
        console.error('check/unlink file error:', p, e.message);
      }
    }

    res.json({ deletedIds: foundIds, notFoundIds });
  } catch (err) {
    console.error('POST /api/photos/delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ========= 3) 创建新项目 =========
// 如果挂在 /api/projects 下：POST /api/projects
// 前端可以传的字段（都在 req.body 里）：
// {
//   projectName / name / title: 项目名称（必填，至少一个）
//   description / desc:         项目描述（可选）
//   deadline / deadlineDate / deadlineTime: 截止时间（可选）
// }
router.post('/', async (req, res) => {
  try {
    console.log('Create project body:', req.body);

    const {
      projectName,
      name,
      title,
      description,
      desc,
      deadline,
      deadlineDate,
      deadlineTime,
    } = req.body || {};

    // 1. 项目名：兼容多种字段名
    const finalName = projectName || name || title;
    if (!finalName || !finalName.trim()) {
      return res.status(400).json({ error: '项目名称不能为空' });
    }

    // 2. 描述
    const finalDesc = (description || desc || '').trim();

    // 3. 截止时间（可选）
    let deadlineStr = null;
    if (deadline && deadline.trim()) {
      deadlineStr = deadline.trim();
    } else if (deadlineDate) {
      // 例如：deadlineDate = '2025-11-16', deadlineTime = '18:00'
      deadlineStr = deadlineDate.trim();
      if (deadlineTime && deadlineTime.trim()) {
        deadlineStr += ' ' + deadlineTime.trim();
      }
    }

    // 4. 额外信息塞到 meta 里（TEXT/JSON 字段）
    const meta = {
      deadline: deadlineStr,
      deadlineDate: deadlineDate || null,
      deadlineTime: deadlineTime || null,
    };

    // 5. 管理员 id（现在先用固定值，等接入登录后再改成当前登录用户）
    const adminId = CURRENT_ADMIN_ID;

    // 6. 插入数据库
    // 假设表结构有：id, uuid, name, description, status, meta, admin_id, created_at, updated_at
    const [result] = await pool.query(
      `INSERT INTO projects
         (uuid, name, description, status, meta, admin_id, created_at, updated_at)
       VALUES
         (UUID(), ?, ?, ?, ?, ?, NOW(), NOW())`,
      [finalName.trim(), finalDesc, '进行中', JSON.stringify(meta), adminId]
    );

    const insertedId = result.insertId;

    // 7. 返回给前端
    res.json({
      id: insertedId,
      projectName: finalName.trim(),
      description: finalDesc,
      status: '进行中',
      meta,
      adminId, // ✅ 新增：把管理员 id 一起返回
    });
  } catch (err) {
    console.error('POST /api/projects error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
