// routes/upload.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');

// 上传根目录：优先使用环境变量 UPLOAD_ABS_DIR，否则回退到仓库内的 uploads
const uploadsAbsDir = process.env.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
// 如果传入的是父目录（例如 C:/ALL/MaMage/Photo_Base），实际文件通常在其下的 'uploads' 子目录
const uploadRoot = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

// === multer 配置：按日期分目录，文件名用 uuid ===
const storage = multer.diskStorage({
  destination(req, file, cb) {
    // 注意：projectId 来自前端 wx.uploadFile 的 formData.projectId
    const projectId = req.body && req.body.projectId;
    let dir;

    if (projectId === '1') {
      // 特殊项目：校园风光
      // 实际目录：.../uploads/scenery
      dir = path.join(uploadRoot, 'scenery');
    } else {
      // 其它项目还是按日期分目录
      const now = new Date();
      const year = now.getFullYear().toString();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      dir = path.join(uploadRoot, year, month, day);
    }

    fs.mkdirSync(dir, { recursive: true });
    console.log('[upload] destination dir:', dir);
    cb(null, dir);
  },

  filename(req, file, cb) {
    const projectId = req.body && req.body.projectId;

    // 保留后缀：优先用原始后缀
    let ext = path.extname(file.originalname).toLowerCase();

    // 如果没后缀，就根据项目类型兜底
    if (!ext) {
      // 你现在校园风光用的是 png，这里强制一下也无妨
      ext = projectId === '1' ? '.png' : '.jpg';
    }

    const filename = uuidv4() + ext; // 至于 111.png/444.png 那些只是你手动起的名字，这里用 uuid 就能保证不冲突
    cb(null, filename);
  }
});
const upload = multer({
  storage,
  // 你也可以在这里加文件大小限制、类型过滤等
});

// === 单张照片上传接口 ===
// POST /api/upload/photo
// 表单字段：file（图片），projectId（可选），title（可选），type（可选），tags（可选 JSON）
async function processUpload(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const projectId = req.body.projectId
      ? parseInt(req.body.projectId, 10)
      : null;
    const title = req.body.title || '';
    const type = req.body.type || 'normal';

    let tags = null;
    if (req.body.tags) {
      try {
        tags = JSON.parse(req.body.tags); // 期望 tags 是 JSON 字符串，比如 '["校园","风光"]'
      } catch (e) {
        console.warn('invalid tags JSON, ignore:', req.body.tags);
      }
    }

    // 原图绝对路径
    const absPath = req.file.path;
    console.log('[upload] saved absPath:', absPath, ' uploadRoot:', uploadRoot);

    // 相对路径（给前端用）：把 uploadRoot 去掉，然后统一换成 /uploads/...
    let relPath = absPath.replace(uploadRoot, '');
    relPath = relPath.split(path.sep).join('/');
    relPath = '/uploads' + relPath;

    // === 生成缩略图 ===
    const dirName = path.dirname(absPath);
    const thumbDir = path.join(dirName, 'thumbs');
    fs.mkdirSync(thumbDir, { recursive: true });

    const baseName = path.basename(absPath);
    const thumbName = 'thumb_' + baseName;
    const thumbAbsPath = path.join(thumbDir, thumbName);

    await sharp(absPath)
      .resize(800)
      .jpeg({ quality: 80 })
      .toFile(thumbAbsPath);

    let thumbRel = thumbAbsPath.replace(uploadRoot, '');
    thumbRel = thumbRel.split(path.sep).join('/');
    thumbRel = '/uploads' + thumbRel;

    const [result] = await pool.query(
      `INSERT INTO photos
        (uuid, project_id, url, thumb_url, title, tags, type)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?)`,
      [
        projectId || null,
        relPath,
        thumbRel,
        title,
        tags ? JSON.stringify(tags) : null,
        type
      ]
    );

    const insertedId = result.insertId;

    if (projectId) {
      try {
        const [projRows] = await pool.query(
          `SELECT photo_ids FROM projects WHERE id = ? FOR UPDATE`,
          [projectId]
        );

        if (projRows && projRows.length) {
          const existing = projRows[0].photo_ids;
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

          if (!arr.includes(insertedId)) arr.push(insertedId);

          const newVal = arr.length ? JSON.stringify(arr) : null;
          await pool.query(
            `UPDATE projects SET photo_ids = ? WHERE id = ?`,
            [newVal, projectId]
          );
        }
      } catch (e) {
        console.error('append photo id to project failed:', e.message);
      }
    }

    res.json({
      id: insertedId,
      projectId: projectId || null,
      url: relPath,
      thumbUrl: thumbRel,
      title,
      type
    });
  } catch (err) {
    console.error('POST /api/upload/photo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

router.post('/photo', upload.single('file'), processUpload);

// Attach multer instance and handler to router so other modules can reuse them
router.upload = upload;
router.processUpload = processUpload;

module.exports = router;
