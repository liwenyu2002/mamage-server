// routes/upload.js
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const { buildUploadUrl } = require('../db');
const jwt = require('jsonwebtoken');
const keys = require('../config/keys');
const JWT_SECRET = keys.JWT_SECRET || 'please-change-this-secret';

// === Tencent COS 初始化（可选） ===
let COS;
let cosClient = null;
const COS_BUCKET = keys.COS_BUCKET || null;
const COS_REGION = keys.COS_REGION || null;
const COS_BASE_URL = keys.COS_BASE_URL || null; // e.g. https://your-bucket.cos.region.myqcloud.com
try {
  COS = require('cos-nodejs-sdk-v5');
  if (keys.COS_SECRET_ID && keys.COS_SECRET_KEY && COS_BUCKET && COS_REGION) {
    cosClient = new COS({
      SecretId: keys.COS_SECRET_ID,
      SecretKey: keys.COS_SECRET_KEY
    });
    console.log('[upload] COS client initialized');
  }
} catch (e) {
  // cos sdk not installed or failed to load
  cosClient = null;
}

// Ensure COS client initialized lazily (useful if env vars are set after module load)
function ensureCosClient() {
  if (cosClient) return;
  try {
    if (!COS) COS = require('cos-nodejs-sdk-v5');
  } catch (e) {
    console.warn('[upload] cos-nodejs-sdk-v5 not available');
    return;
  }

  const sid = keys.COS_SECRET_ID;
  const skey = keys.COS_SECRET_KEY;
  const bucket = keys.COS_BUCKET;
  const region = keys.COS_REGION;
  if (sid && skey && bucket && region) {
    try {
      cosClient = new COS({ SecretId: sid, SecretKey: skey });
      console.log('[upload] COS client lazily initialized');
    } catch (e) {
      console.error('[upload] failed to initialize COS client', e && e.message ? e.message : e);
      cosClient = null;
    }
  }
}

// Helper: 上传本地文件到 COS，返回公开 URL（或抛错）
function uploadFileToCOS(localFilePath, key) {
  ensureCosClient();
  if (!cosClient) return Promise.reject(new Error('COS client not configured'));
  const fsRead = require('fs');
  let size = undefined;
  try {
    const st = fsRead.statSync(localFilePath);
    size = st.size;
  } catch (e) {
    // ignore, size optional
  }

  return new Promise((resolve, reject) => {
    const bucket = keys.COS_BUCKET || COS_BUCKET;
    const region = keys.COS_REGION || COS_REGION;
    cosClient.putObject(
      {
        Bucket: bucket,
        Region: region,
        Key: key,
        Body: fsRead.createReadStream(localFilePath),
        ContentLength: size
      },
      (err, data) => {
        if (err) return reject(err);
        const base = (keys.COS_BASE_URL || COS_BASE_URL) ? (keys.COS_BASE_URL || COS_BASE_URL).replace(/\/$/, '') : `https://${bucket}.cos.${region}.myqcloud.com`;
        resolve(base + '/' + key);
      }
    );
  });
}

// 上传根目录：优先使用环境变量 UPLOAD_ABS_DIR，否则回退到仓库内的 uploads
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
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
    const description = req.body.description ? String(req.body.description).trim() : null;
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

    // 如果配置了 COS 客户端，尝试上传原图和缩略图到 COS，并在成功后删除本地文件
    let remoteUrl = null;
    let remoteThumbUrl = null;
    // 确保尝试延迟初始化 COS 客户端（允许在进程启动后通过环境变量配置）
    ensureCosClient();
    if (cosClient) {
      try {
        // 使用相对 uploads/... 作为对象 Key（去掉前导 '/'
        const key = relPath.replace(/^\/+/g, '');
        const thumbKey = thumbRel.replace(/^\/+/g, '');

        remoteUrl = await uploadFileToCOS(absPath, key);
        remoteThumbUrl = await uploadFileToCOS(thumbAbsPath, thumbKey);

        // 删除本地文件（异步）
        try { fs.unlink(absPath, () => {}); } catch (e) {}
        try { fs.unlink(thumbAbsPath, () => {}); } catch (e) {}

        // 把将要写入 DB 的路径替换为远程 URL（完整地址）
        relPath = remoteUrl;
        thumbRel = remoteThumbUrl;
        console.log('[upload] uploaded to COS', remoteUrl, remoteThumbUrl);
      } catch (e) {
        console.error('[upload] upload to COS failed, falling back to local paths', e && e.message ? e.message : e);
        // keep local relPath/thumbRel
      }
    } else {
      console.log('[upload] COS client not available, storing local paths');
    }

    const [result] = await pool.query(
      `INSERT INTO photos
        (uuid, project_id, url, thumb_url, title, description, tags, type)
       VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?)`,
      [
        projectId || null,
        relPath,
        thumbRel,
        title,
        description,
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

    const respPayload = {
      id: insertedId,
      projectId: projectId || null,
      url: buildUploadUrl(relPath),
      thumbUrl: buildUploadUrl(thumbRel),
      title,
      type
    };

    // 异步入队 AI 分析（不阻塞上传响应）
    // 我们排队的是缩略图（thumbRel），模型读取缩略图即可生成 description/tags
    try {
      const aiWorker = require('../lib/ai_tags_worker');
      // 传入 relPath 为缩略图的相对 URL，和缩略图的绝对路径以备需要
      aiWorker.enqueue({ id: insertedId, relPath: thumbRel, absPath: thumbAbsPath });
      console.log('[upload] enqueued thumbnail for ai analyze', insertedId, thumbRel);
    } catch (e) {
      console.error('[upload] enqueue ai analyze failed:', e && e.message ? e.message : e);
    }

    res.json(respPayload);
  } catch (err) {
    console.error('POST /api/upload/photo error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
const { requirePermission } = require('../lib/permissions');

// 保护上传路由（基于 role_permissions）
router.post('/photo', requirePermission('upload.photo'), upload.single('file'), processUpload);

// Attach multer instance and handler to router so other modules can reuse them

router.upload = upload;
router.processUpload = processUpload;

module.exports = router;
