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

// note: we will avoid writing files to local disk when COS is enabled.
// uploadRoot kept for backward compatibility but not used when using memory storage.
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
const uploadRoot = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

// === multer 配置：按日期分目录，文件名用 uuid ===
// Use memory storage to avoid writing uploaded files to disk when COS is enabled.
const storage = multer.memoryStorage();
const upload = multer({ storage });

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

    // If multer.memoryStorage is used, file buffer is available at req.file.buffer
    if (!req.file || !req.file.buffer) return res.status(400).json({ error: 'No file uploaded' });
    const originalBuffer = req.file.buffer;

    // Build object keys (relative paths) similar to previous disk layout
    let keyPrefix;
    if (projectId === 1) {
      keyPrefix = 'scenery';
    } else {
      const now = new Date();
      const year = now.getFullYear().toString();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      keyPrefix = `${year}/${month}/${day}`;
    }

    // filename
    let ext = path.extname(req.file.originalname).toLowerCase();
    if (!ext) ext = projectId === 1 ? '.png' : '.jpg';
    const filename = uuidv4() + ext;
    let relPath = `/uploads/${keyPrefix}/${filename}`.replace(/\\/g, '/');

    // generate thumbnail buffer
    const thumbBuffer = await sharp(originalBuffer).resize(800).jpeg({ quality: 80 }).toBuffer();
    const thumbName = 'thumb_' + filename;
    let thumbRel = `/uploads/${keyPrefix}/thumbs/${thumbName}`.replace(/\\/g, '/');

    // upload buffers to COS
    ensureCosClient();
    if (!cosClient) {
      console.error('[upload] COS client not configured - rejecting upload to avoid local storage');
      return res.status(503).json({ error: 'COS_NOT_CONFIGURED', message: 'Server is not configured to upload to object storage. Configure COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION.' });
    }

    // helper to upload buffer directly
    async function uploadBufferToCOS(buffer, key) {
      return new Promise((resolve, reject) => {
        const bucket = keys.COS_BUCKET || COS_BUCKET;
        const region = keys.COS_REGION || COS_REGION;
        cosClient.putObject(
          {
            Bucket: bucket,
            Region: region,
            Key: key,
            Body: buffer,
            ContentLength: buffer.length
          },
          (err, data) => {
            if (err) return reject(err);
            const base = (keys.COS_BASE_URL || COS_BASE_URL) ? (keys.COS_BASE_URL || COS_BASE_URL).replace(/\/$/, '') : `https://${bucket}.cos.${region}.myqcloud.com`;
            resolve(base + '/' + key);
          }
        );
      });
    }

    let remoteUrl = null;
    let remoteThumbUrl = null;
    try {
      const key = relPath.replace(/^\/+/, '');
      const thumbKey = thumbRel.replace(/^\/+/, '');
      remoteUrl = await uploadBufferToCOS(originalBuffer, key);
      remoteThumbUrl = await uploadBufferToCOS(thumbBuffer, thumbKey);
      // use remote URLs only for logging; keep DB values as relative paths
      console.log('[upload] uploaded to COS', remoteUrl, remoteThumbUrl);
      // keep relative DB paths (leading slash)
      relPath = '/' + key;
      thumbRel = '/' + thumbKey;
    } catch (e) {
      console.error('[upload] upload to COS failed', e && e.message ? e.message : e);
      return res.status(502).json({ error: 'COS_UPLOAD_FAILED', message: String(e && e.message ? e.message : e) });
    }

    // photographerId MUST come from the authenticated token (req.user).
    // Do NOT trust client-supplied photographerId to avoid spoofing.
    const photographerId = (req.user && req.user.id) ? req.user.id : null;
    const orgId = (req.user && req.user.organization_id !== undefined && req.user.organization_id !== null) ? Number(req.user.organization_id) : null;

    let result;
    try {
      [result] = await pool.query(
        `INSERT INTO photos
          (uuid, project_id, url, thumb_url, title, description, tags, type, photographer_id, organization_id)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          projectId || null,
          relPath,
          thumbRel,
          title,
          description,
          tags ? JSON.stringify(tags) : null,
          type,
          photographerId || null,
          orgId
        ]
      );
    } catch (e) {
      if (e && (e.code === 'ER_BAD_FIELD_ERROR' || (e.message && e.message.indexOf('Unknown column') !== -1))) {
        // photos.organization_id column doesn't exist; retry without it for compatibility
        [result] = await pool.query(
          `INSERT INTO photos
            (uuid, project_id, url, thumb_url, title, description, tags, type, photographer_id)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            projectId || null,
            relPath,
            thumbRel,
            title,
            description,
            tags ? JSON.stringify(tags) : null,
            type,
            photographerId || null
          ]
        );
      } else if (e && (e.code === 'ER_NO_DEFAULT_FOR_FIELD' || (e.message && e.message.indexOf("doesn't have a default value") !== -1))) {
        return res.status(400).json({
          error: 'DB_SCHEMA_PHOTO_ORG_REQUIRED',
          message: 'Database column photos.organization_id is NOT NULL and has no default. Assign organization to the uploading user or make the column nullable.',
          sql: 'ALTER TABLE photos MODIFY COLUMN organization_id INT UNSIGNED NULL;'
        });
      } else {
        throw e;
      }
    }

    const insertedId = result.insertId;
    // 查询摄影师名字以便返回给前端（如果 photographerId 为 null 则返回 null）
    let photographerName = null;
    if (photographerId) {
      try {
        const [userRows] = await pool.query(`SELECT name FROM users WHERE id = ? LIMIT 1`, [photographerId]);
        if (userRows && userRows.length) photographerName = userRows[0].name || null;
      } catch (e) {
        console.warn('[upload] fetch photographer name failed', e && e.message ? e.message : e);
      }
    }

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
          await pool.query(`UPDATE projects SET photo_ids = ? WHERE id = ?`, [newVal, projectId]);
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
      type,
      photographerId: photographerId || null,
      photographerName: photographerName || null
    };

    // 异步入队 AI 分析（不阻塞上传响应）
    // 我们排队的是缩略图（thumbRel），模型读取缩略图即可生成 description/tags
    try {
      const aiWorker = require('../lib/ai_tags_worker');
      // 传入相对路径（缩略图的 URL），后台会用 buildUploadUrl 拼接完整地址
      aiWorker.enqueue({ id: insertedId, relPath: thumbRel });
      console.log('[upload] enqueued thumbnail for ai analyze', insertedId, thumbRel);
    } catch (e) {
      console.error('[upload] enqueue ai analyze failed:', e && e.message ? e.message : e);
    }

    // 异步生成并保存 image embedding（非阻塞）
    try {
      const imageSim = require('../lib/image_similarity');
      // thumbBuffer exists in this scope (generated earlier); encode directly from buffer
      imageSim.encodeImageFromBuffer(thumbBuffer).then((emb) => {
        return imageSim.saveEmbedding(insertedId, emb).catch((err) => console.error('[image_similarity] save failed', err && err.message ? err.message : err));
      }).catch((err) => console.error('[image_similarity] encode failed', err && err.message ? err.message : err));
      console.log('[upload] enqueued embedding generation', insertedId);
    } catch (e) {
      console.error('[upload] enqueue embedding failed:', e && e.message ? e.message : e);
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
