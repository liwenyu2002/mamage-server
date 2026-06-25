// routes/upload.js
const express = require('express');
const router = express.Router();
const path = require('path');
const net = require('net');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { pool, buildUploadUrl } = require('../db');
const cosStorage = require('../lib/cos_storage');
const { requirePermission } = require('../lib/permissions');

const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.UPLOAD_MAX_FILE_MB || 30)) * 1024 * 1024;
const THUMB_MAX_DIMENSION = Math.max(320, Number(process.env.UPLOAD_THUMB_MAX_DIMENSION || process.env.UPLOAD_THUMB_MAX_WIDTH || 800));
const THUMB_QUALITY = Math.min(95, Math.max(50, Number(process.env.UPLOAD_THUMB_JPEG_QUALITY || 80)));
const UPLOAD_CACHE_CONTROL = process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable';
const SIGNED_UPLOAD_EXPIRES_SECONDS = Number(process.env.COS_SIGNED_UPLOAD_EXPIRES_SECONDS || 900);

const IMAGE_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
]);
const ALLOWED_IMAGE_MIMES = new Set(IMAGE_MIME_BY_EXT.values());

function parseEnvBoolean(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return null;
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost') return true;

  const ipType = net.isIP(host);
  if (ipType === 4) {
    const parts = host.split('.').map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
    const [a, b] = parts;
    return a === 10
      || a === 127
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168);
  }
  if (ipType === 6) {
    return host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:');
  }
  return false;
}

function getDirectUploadUnavailableReason() {
  const explicit = parseEnvBoolean(process.env.COS_DIRECT_UPLOAD_ENABLED);
  if (explicit === true) return null;
  if (explicit === false) return 'DIRECT_UPLOAD_DISABLED';

  const endpoint = cosStorage.getEndpointUrl && cosStorage.getEndpointUrl();
  if (!endpoint) return 'STORAGE_ENDPOINT_MISSING';

  try {
    const parsed = new URL(endpoint);
    if (isPrivateHostname(parsed.hostname)) return 'PRIVATE_STORAGE_ENDPOINT';
  } catch (e) {
    return 'INVALID_STORAGE_ENDPOINT';
  }

  return null;
}

try {
  const sharpConcurrency = Number(process.env.SHARP_CONCURRENCY || 0);
  if (Number.isFinite(sharpConcurrency) && sharpConcurrency > 0) {
    sharp.concurrency(Math.min(8, sharpConcurrency));
  }
} catch (e) {
  // ignore
}

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 1,
    fields: 16,
    parts: 24,
  },
  fileFilter: (req, file, cb) => {
    const mime = inferImageMime(file && file.mimetype, file && file.originalname);
    if (!mime || !ALLOWED_IMAGE_MIMES.has(mime)) {
      const err = new Error('UNSUPPORTED_FILE_TYPE');
      err.status = 415;
      return cb(err);
    }
    file.mimetype = mime;
    cb(null, true);
  },
});

function inferImageMime(mimeType, filename) {
  const mime = String(mimeType || '').trim().toLowerCase();
  if (ALLOWED_IMAGE_MIMES.has(mime)) return mime;
  const ext = path.extname(String(filename || '')).toLowerCase();
  return IMAGE_MIME_BY_EXT.get(ext) || null;
}

function parseProjectId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const projectId = parseInt(raw, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) return null;
  return projectId;
}

function trimText(value, maxLen) {
  if (value === undefined || value === null) return null;
  const str = String(value).trim();
  if (!str) return null;
  return str.slice(0, maxLen);
}

function parseTags(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  let parsed = raw;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      parsed = raw.split(/[;,，、|]/);
    }
  }
  if (!Array.isArray(parsed)) return null;
  const tags = [];
  for (const item of parsed) {
    const tag = String(item || '').trim();
    if (!tag || tags.includes(tag)) continue;
    tags.push(tag.slice(0, 64));
    if (tags.length >= 20) break;
  }
  return tags.length ? tags : null;
}

function getOrgId(req) {
  const raw = req && req.user ? req.user.organization_id : null;
  if (raw === undefined || raw === null || raw === '') return null;
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

function readPhotoMetadata(body) {
  return {
    projectId: parseProjectId(body && body.projectId),
    title: trimText(body && body.title, 255) || '',
    description: trimText(body && body.description, 2000),
    type: trimText(body && body.type, 32) || 'normal',
    tags: parseTags(body && body.tags),
  };
}

function buildObjectKeys(projectId, originalName, mimeType) {
  let keyPrefix;
  if (Number(projectId) === 1) {
    keyPrefix = 'uploads/scenery';
  } else {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    keyPrefix = `uploads/${year}/${month}/${day}`;
  }
  const ext = cosStorage.extFromFilenameOrMime(originalName, mimeType, '.jpg');
  const filename = `${uuidv4()}${ext}`;
  const originalKey = `${keyPrefix}/${filename}`;
  const thumbKey = `${keyPrefix}/thumbs/thumb_${path.basename(filename, ext)}.jpg`;
  return {
    originalKey,
    thumbKey,
    relPath: `/${originalKey}`,
    thumbRel: `/${thumbKey}`,
  };
}

function parseProjectPhotoIds(existing) {
  if (!existing) return [];
  if (Array.isArray(existing)) return existing.map(Number).filter(Number.isFinite);
  if (typeof existing === 'string') {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isFinite);
    } catch (e) {
      // fall back to comma-separated legacy values
    }
    return existing.split(',').map((s) => Number(String(s).trim())).filter(Number.isFinite);
  }
  return [];
}

async function ensureProjectInScope(db, projectId, orgId) {
  if (!projectId) return;
  let sql = 'SELECT id FROM projects WHERE id = ?';
  const params = [projectId];
  if (orgId === null) {
    sql += ' AND organization_id IS NULL';
  } else {
    sql += ' AND organization_id = ?';
    params.push(orgId);
  }
  try {
    const [rows] = await db.query(sql, params);
    if (!rows || rows.length === 0) {
      const err = new Error('PROJECT_NOT_FOUND');
      err.status = 404;
      throw err;
    }
  } catch (err) {
    if (err && (err.code === 'ER_BAD_FIELD_ERROR' || String(err.message || '').includes('Unknown column'))) {
      const [rows] = await db.query('SELECT id FROM projects WHERE id = ?', [projectId]);
      if (!rows || rows.length === 0) {
        const notFound = new Error('PROJECT_NOT_FOUND');
        notFound.status = 404;
        throw notFound;
      }
      return;
    }
    throw err;
  }
}

async function appendPhotoIdToProject(conn, projectId, insertedId) {
  if (!projectId || !insertedId) return;
  const [projRows] = await conn.query('SELECT photo_ids FROM projects WHERE id = ? FOR UPDATE', [projectId]);
  if (!projRows || projRows.length === 0) return;
  const arr = parseProjectPhotoIds(projRows[0].photo_ids);
  if (!arr.includes(insertedId)) arr.push(insertedId);
  await conn.query('UPDATE projects SET photo_ids = ? WHERE id = ?', [arr.length ? JSON.stringify(arr) : null, projectId]);
}

async function createPhotoRecord(payload) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await ensureProjectInScope(conn, payload.projectId, payload.orgId);

    let result;
    try {
      [result] = await conn.query(
        `INSERT INTO photos
          (uuid, project_id, url, thumb_url, title, description, tags, type, photographer_id, organization_id)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          payload.projectId || null,
          payload.relPath,
          payload.thumbRel,
          payload.title,
          payload.description,
          payload.tags ? JSON.stringify(payload.tags) : null,
          payload.type,
          payload.photographerId || null,
          payload.orgId,
        ]
      );
    } catch (err) {
      if (err && (err.code === 'ER_BAD_FIELD_ERROR' || String(err.message || '').includes('Unknown column'))) {
        [result] = await conn.query(
          `INSERT INTO photos
            (uuid, project_id, url, thumb_url, title, description, tags, type, photographer_id)
           VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            payload.projectId || null,
            payload.relPath,
            payload.thumbRel,
            payload.title,
            payload.description,
            payload.tags ? JSON.stringify(payload.tags) : null,
            payload.type,
            payload.photographerId || null,
          ]
        );
      } else if (err && (err.code === 'ER_NO_DEFAULT_FOR_FIELD' || String(err.message || '').includes("doesn't have a default value"))) {
        err.status = 400;
        err.publicMessage = 'Database requires photos.organization_id. Assign organization to the uploading user.';
        throw err;
      } else {
        throw err;
      }
    }

    const insertedId = result.insertId;
    await appendPhotoIdToProject(conn, payload.projectId, insertedId);
    await conn.commit();
    return insertedId;
  } catch (err) {
    try { await conn.rollback(); } catch (e) { }
    throw err;
  } finally {
    conn.release();
  }
}

async function getPhotographerName(photographerId) {
  if (!photographerId) return null;
  try {
    const [rows] = await pool.query('SELECT name FROM users WHERE id = ? LIMIT 1', [photographerId]);
    return rows && rows[0] ? rows[0].name || null : null;
  } catch (err) {
    console.warn('[upload] fetch photographer name failed:', err && err.message ? err.message : err);
    return null;
  }
}

async function createThumbBuffer(originalBuffer) {
  return sharp(originalBuffer, { failOn: 'none' })
    .rotate()
    .resize({ width: THUMB_MAX_DIMENSION, height: THUMB_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toBuffer();
}

function fetchBuffer(url, maxBytes, timeoutMs) {
  return new Promise((resolve, reject) => {
    const client = String(url || '').startsWith('https') ? require('https') : require('http');
    const req = client.get(url, (response) => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        reject(new Error(`FETCH_FAILED_${response.statusCode}`));
        return;
      }
      const chunks = [];
      let total = 0;
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy(new Error('FETCH_TOO_LARGE'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('FETCH_TIMEOUT')));
    req.on('error', reject);
  });
}

function enqueuePostUploadJobs({ insertedId, thumbRel, thumbBuffer, photographerId }) {
  try {
    const aiWorker = require('../lib/ai_tags_worker');
    aiWorker.enqueue({ id: insertedId, relPath: thumbRel });
  } catch (err) {
    console.error('[upload] enqueue ai analyze failed:', err && err.message ? err.message : err);
  }

  try {
    const imageSim = require('../lib/image_similarity');
    const run = async () => {
      let buf = thumbBuffer;
      if (!buf) {
        const thumbUrl = buildUploadUrl(thumbRel);
        buf = await fetchBuffer(thumbUrl, Number(process.env.IMAGE_SIMILARITY_FETCH_MAX_BYTES || 5 * 1024 * 1024), Number(process.env.IMAGE_SIMILARITY_FETCH_TIMEOUT_MS || 15000));
      }
      const emb = await imageSim.encodeImageFromBuffer(buf);
      await imageSim.saveEmbedding(insertedId, emb);
    };
    setImmediate(() => {
      run().catch((err) => console.error('[image_similarity] encode/save failed', err && err.message ? err.message : err));
    });
  } catch (err) {
    console.error('[upload] enqueue embedding failed:', err && err.message ? err.message : err);
  }

  try {
    const faceAutoWorker = require('../lib/face_auto_worker');
    faceAutoWorker.enqueueFaceAutoJob({
      photoId: insertedId,
      uploaderId: photographerId || null,
    });
  } catch (err) {
    console.error('[upload] enqueue face auto detect failed:', err && err.message ? err.message : err);
  }
}

function makeResponsePayload({ insertedId, projectId, relPath, thumbRel, title, type, photographerId, photographerName }) {
  return {
    id: insertedId,
    projectId: projectId || null,
    url: buildUploadUrl(relPath),
    thumbUrl: buildUploadUrl(thumbRel),
    title,
    type,
    photographerId: photographerId || null,
    photographerName: photographerName || null,
  };
}

function handleUploadMiddleware(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'FILE_TOO_LARGE', maxFileBytes: MAX_UPLOAD_BYTES });
      }
      return res.status(400).json({ error: err.code || 'UPLOAD_REJECTED' });
    }
    return res.status(err.status || 400).json({ error: err.message || 'UPLOAD_REJECTED' });
  });
}

async function processUpload(req, res) {
  let uploadedKeys = [];
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    if (!cosStorage.isConfigured()) {
      return res.status(503).json({
        error: 'COS_NOT_CONFIGURED',
        message: 'Server is not configured to upload to object storage. Configure COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION.',
      });
    }

    const metadata = readPhotoMetadata(req.body || {});
    const photographerId = req.user && req.user.id ? req.user.id : null;
    const orgId = getOrgId(req);
    await ensureProjectInScope(pool, metadata.projectId, orgId);

    const mimeType = inferImageMime(req.file.mimetype, req.file.originalname);
    const { originalKey, thumbKey, relPath, thumbRel } = buildObjectKeys(metadata.projectId, req.file.originalname, mimeType);

    let thumbBuffer = null;
    try {
      const originalUploadPromise = cosStorage.uploadBuffer(originalKey, req.file.buffer, {
        contentType: mimeType,
        cacheControl: UPLOAD_CACHE_CONTROL,
      }).then((result) => {
        uploadedKeys.push(originalKey);
        return result;
      });

      thumbBuffer = await createThumbBuffer(req.file.buffer);
      const thumbUploadPromise = cosStorage.uploadBuffer(thumbKey, thumbBuffer, {
        contentType: 'image/jpeg',
        cacheControl: UPLOAD_CACHE_CONTROL,
      }).then((result) => {
        uploadedKeys.push(thumbKey);
        return result;
      });

      await Promise.all([originalUploadPromise, thumbUploadPromise]);
    } catch (err) {
      await cosStorage.deleteObjects(uploadedKeys).catch(() => null);
      console.error('[upload] upload to COS failed:', err && err.message ? err.message : err);
      return res.status(502).json({ error: 'COS_UPLOAD_FAILED', message: String(err && err.message ? err.message : err) });
    }

    let insertedId;
    try {
      insertedId = await createPhotoRecord({
        ...metadata,
        relPath,
        thumbRel,
        photographerId,
        orgId,
      });
    } catch (err) {
      await cosStorage.deleteObjects([originalKey, thumbKey]).catch(() => null);
      const status = err.status || 500;
      const message = err.publicMessage || err.message || 'DB_INSERT_FAILED';
      console.error('[upload] DB insert failed, cleaned COS objects:', message);
      return res.status(status).json({ error: status === 404 ? 'PROJECT_NOT_FOUND' : 'DB_INSERT_FAILED', message });
    }

    const photographerName = await getPhotographerName(photographerId);
    enqueuePostUploadJobs({ insertedId, thumbRel, thumbBuffer, photographerId });

    return res.json(makeResponsePayload({
      insertedId,
      projectId: metadata.projectId,
      relPath,
      thumbRel,
      title: metadata.title,
      type: metadata.type,
      photographerId,
      photographerName,
    }));
  } catch (err) {
    await cosStorage.deleteObjects(uploadedKeys).catch(() => null);
    console.error('POST /api/upload/photo error:', err && err.stack ? err.stack : err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
}

router.post('/photo/direct/init', requirePermission('upload.photo'), async (req, res) => {
  try {
    if (!cosStorage.isConfigured()) {
      return res.status(503).json({ error: 'COS_NOT_CONFIGURED' });
    }
    const directUploadUnavailableReason = getDirectUploadUnavailableReason();
    if (directUploadUnavailableReason) {
      return res.status(409).json({
        error: 'DIRECT_UPLOAD_UNAVAILABLE',
        reason: directUploadUnavailableReason,
        fallback: 'api-upload',
      });
    }

    const metadata = readPhotoMetadata(req.body || {});
    const orgId = getOrgId(req);
    await ensureProjectInScope(pool, metadata.projectId, orgId);

    const fileName = trimText(req.body && req.body.fileName, 255) || 'photo.jpg';
    const fileSize = Number(req.body && req.body.fileSize);
    if (!Number.isFinite(fileSize) || fileSize <= 0) {
      return res.status(400).json({ error: 'INVALID_FILE_SIZE' });
    }
    if (fileSize > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ error: 'FILE_TOO_LARGE', maxFileBytes: MAX_UPLOAD_BYTES });
    }

    const mimeType = inferImageMime(req.body && req.body.mimeType, fileName);
    if (!mimeType || !ALLOWED_IMAGE_MIMES.has(mimeType)) {
      return res.status(415).json({ error: 'UNSUPPORTED_FILE_TYPE' });
    }

    const { originalKey, thumbKey, relPath, thumbRel } = buildObjectKeys(metadata.projectId, fileName, mimeType);
    const originalHeaders = {
      'Content-Type': mimeType,
      'Cache-Control': UPLOAD_CACHE_CONTROL,
    };
    const thumbHeaders = {
      'Content-Type': 'image/jpeg',
      'Cache-Control': UPLOAD_CACHE_CONTROL,
    };

    const [original, thumb] = await Promise.all([
      cosStorage.signedPutUrl(originalKey, { expires: SIGNED_UPLOAD_EXPIRES_SECONDS, headers: originalHeaders }),
      cosStorage.signedPutUrl(thumbKey, { expires: SIGNED_UPLOAD_EXPIRES_SECONDS, headers: thumbHeaders }),
    ]);

    res.json({
      uploadMode: 'direct-cos',
      maxFileBytes: MAX_UPLOAD_BYTES,
      expiresIn: SIGNED_UPLOAD_EXPIRES_SECONDS,
      original: {
        key: original.key,
        uploadUrl: original.signedUrl,
        url: original.publicUrl,
        relPath,
        headers: originalHeaders,
      },
      thumb: {
        key: thumb.key,
        uploadUrl: thumb.signedUrl,
        url: thumb.publicUrl,
        relPath: thumbRel,
        headers: thumbHeaders,
      },
    });
  } catch (err) {
    console.error('POST /api/upload/photo/direct/init error:', err && err.stack ? err.stack : err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/photo/direct/complete', requirePermission('upload.photo'), async (req, res) => {
  const originalKey = cosStorage.normalizeKey(req.body && req.body.originalKey);
  const thumbKey = cosStorage.normalizeKey(req.body && req.body.thumbKey);
  try {
    if (!originalKey || !thumbKey || !originalKey.startsWith('uploads/') || !thumbKey.startsWith('uploads/')) {
      return res.status(400).json({ error: 'INVALID_OBJECT_KEY' });
    }
    if (originalKey.includes('..') || thumbKey.includes('..')) {
      return res.status(400).json({ error: 'INVALID_OBJECT_KEY' });
    }

    const metadata = readPhotoMetadata(req.body || {});
    const photographerId = req.user && req.user.id ? req.user.id : null;
    const orgId = getOrgId(req);

    let insertedId;
    try {
      insertedId = await createPhotoRecord({
        ...metadata,
        relPath: `/${originalKey}`,
        thumbRel: `/${thumbKey}`,
        photographerId,
        orgId,
      });
    } catch (err) {
      await cosStorage.deleteObjects([originalKey, thumbKey]).catch(() => null);
      const status = err.status || 500;
      const message = err.publicMessage || err.message || 'DB_INSERT_FAILED';
      return res.status(status).json({ error: status === 404 ? 'PROJECT_NOT_FOUND' : 'DB_INSERT_FAILED', message });
    }

    const photographerName = await getPhotographerName(photographerId);
    enqueuePostUploadJobs({ insertedId, thumbRel: `/${thumbKey}`, thumbBuffer: null, photographerId });

    res.json(makeResponsePayload({
      insertedId,
      projectId: metadata.projectId,
      relPath: `/${originalKey}`,
      thumbRel: `/${thumbKey}`,
      title: metadata.title,
      type: metadata.type,
      photographerId,
      photographerName,
    }));
  } catch (err) {
    console.error('POST /api/upload/photo/direct/complete error:', err && err.stack ? err.stack : err);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  }
});

router.post('/photo/direct/abort', requirePermission('upload.photo'), async (req, res) => {
  try {
    const keys = [req.body && req.body.originalKey, req.body && req.body.thumbKey]
      .map(cosStorage.normalizeKey)
      .filter((key) => key && key.startsWith('uploads/') && !key.includes('..'));
    const result = await cosStorage.deleteObjects(keys);
    res.json({ ok: true, deleted: result.deleted || [], errors: result.errors || [] });
  } catch (err) {
    console.error('POST /api/upload/photo/direct/abort error:', err && err.message ? err.message : err);
    res.status(500).json({ error: 'DIRECT_UPLOAD_ABORT_FAILED' });
  }
});

router.post('/photo', requirePermission('upload.photo'), handleUploadMiddleware, processUpload);

router.upload = upload;
router.processUpload = processUpload;

module.exports = router;
