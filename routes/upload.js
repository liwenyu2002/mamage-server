// routes/upload.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');

// 上传根目录：/Users/liwenyu/imgmgr-api/uploads
const uploadRoot = path.join(__dirname, '..', 'uploads');

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
router.post('/photo', upload.single('file'), async (req, res) => {
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
    const absPath = req.file.path; // e.g. /Users/liwenyu/imgmgr-api/uploads/2025/11/16/xxx.jpg

    // 相对路径（给前端用）：把 uploadRoot 去掉，然后统一换成 /uploads/...
    let relPath = absPath.replace(uploadRoot, '');   // => /2025/11/16/xxx.jpg
    relPath = relPath.split(path.sep).join('/');     // 处理 windows 反斜杠
    relPath = '/uploads' + relPath;                  // => /uploads/2025/11/16/xxx.jpg

    // === 生成缩略图 ===
    const dirName = path.dirname(absPath);           // .../uploads/2025/11/16
    const thumbDir = path.join(dirName, 'thumbs');   // .../uploads/2025/11/16/thumbs
    fs.mkdirSync(thumbDir, { recursive: true });

    const baseName = path.basename(absPath);         // xxx.jpg
    const thumbName = 'thumb_' + baseName;           // thumb_xxx.jpg
    const thumbAbsPath = path.join(thumbDir, thumbName);

    // 用 sharp 生成压缩图（宽度 800 以内）
    await sharp(absPath)
      .resize(800) // 宽 800，高度按比例
      .jpeg({ quality: 80 })
      .toFile(thumbAbsPath);

    let thumbRel = thumbAbsPath.replace(uploadRoot, '');
    thumbRel = thumbRel.split(path.sep).join('/');
    thumbRel = '/uploads' + thumbRel;               // => /uploads/2025/11/16/thumbs/thumb_xxx.jpg

    // === 写入数据库 ===
    const [result] = await pool.query(
      `INSERT INTO photos
        (uuid, project_id, url, thumb_url, local_path, title, tags, type)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId || null,
        relPath,
        thumbRel,
        absPath,
        title,
        tags ? JSON.stringify(tags) : null,
        type
      ]
    );

    const insertedId = result.insertId;

    // 返回给前端
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
});

module.exports = router;
