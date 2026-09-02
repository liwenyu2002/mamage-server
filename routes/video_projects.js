const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');
const { probeVideo, renderProject, normalizeProjectClips } = require('../lib/video_render');
const { analyzeVideo } = require('../lib/video_analysis');
const videoStorage = require('../lib/video_editor_storage');
const cosStorage = require('../lib/cos_storage');
const { getMaxVideoUploadBytes, getMaxVideoApiFallbackBytes } = require('../config/video_upload_limits');

const router = express.Router();
const assetUploadDir = videoStorage.getUploadTempDir();
const MAX_VIDEO_UPLOAD_BYTES = getMaxVideoUploadBytes();
const MAX_VIDEO_API_FALLBACK_BYTES = getMaxVideoApiFallbackBytes();
const DIRECT_ASSET_UPLOAD_TTL_MS = Math.max(10 * 60 * 1000, Number(process.env.VIDEO_DIRECT_UPLOAD_TTL_MINUTES || 30) * 60 * 1000);
const DIRECT_ASSET_UPLOAD_EXPIRES_SECONDS = Math.max(60, Number(process.env.COS_SIGNED_UPLOAD_EXPIRES_SECONDS || 900));
const DIRECT_ASSET_UPLOAD_MAX_EXPIRES_SECONDS = Math.max(
  DIRECT_ASSET_UPLOAD_EXPIRES_SECONDS,
  Number(process.env.VIDEO_DIRECT_UPLOAD_MAX_EXPIRES_SECONDS || 48 * 60 * 60)
);
const DIRECT_ASSET_UPLOAD_ESTIMATED_BYTES_PER_SECOND = Math.max(
  128 * 1024,
  Number(process.env.VIDEO_DIRECT_UPLOAD_ESTIMATED_BYTES_PER_SECOND || 768 * 1024)
);
const DIRECT_ASSET_UPLOAD_FINISHING_BUFFER_SECONDS = 10 * 60;
const directAssetUploads = new Map();
let directAssetCleanupTimer = null;

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, assetUploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12) || '.mp4';
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  // 该接口会先写入 Mac Mini 临时目录，只作为小文件兼容兜底。
  limits: { fileSize: MAX_VIDEO_API_FALLBACK_BYTES },
  fileFilter: (_req, file, cb) => {
    const accepted = String(file.mimetype || '').startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|avi|ogv|ogg)$/i.test(file.originalname || '');
    cb(accepted ? null : new Error('仅支持视频文件'), accepted);
  },
});

const activeRenders = new Map();
const renderQueue = [];
let runningRenderCount = 0;
const renderConcurrency = Math.max(1, Math.min(4, Number(process.env.VIDEO_RENDER_CONCURRENCY) || 1));
const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
};
const projectDuration = (project) => {
  const clips = Array.isArray(project.clips)
    ? project.clips
    : ((((project.tracks || []).find((track) => track.type === 'video' && (track.primary || track.id === 'V1'))) || {}).clips || []);
  return clips.reduce((sum, clip, index) => {
    const duration = Math.max(0, (Number(clip.outPoint) - Number(clip.inPoint)) / Math.max(0.01, Number(clip.speed) || 1));
    const transition = String(clip && clip.transition || '').toLowerCase();
    const previous = clips[index - 1];
    const previousDuration = previous
      ? Math.max(0, (Number(previous.outPoint) - Number(previous.inPoint)) / Math.max(0.01, Number(previous.speed) || 1))
      : 0;
    const overlap = index > 0 && ['dissolve', 'fade', 'flash'].includes(transition)
      ? Math.min(0.35, duration / 2, previousDuration / 2)
      : 0;
    return sum + duration - overlap;
  }, 0);
};

function normalizeVideoMime(value, filename) {
  const mime = String(value || '').trim().toLowerCase();
  if (mime.startsWith('video/')) return mime;
  const ext = path.extname(String(filename || '')).toLowerCase();
  const known = {
    '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
    '.ogv': 'video/ogg', '.ogg': 'video/ogg', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  };
  return known[ext] || '';
}

function normalizeDirectAssetMetadata(body = {}) {
  const name = String(body.fileName || body.name || '视频').trim().slice(0, 255) || '视频';
  const size = Number(body.fileSize || body.size);
  const mimeType = normalizeVideoMime(body.mimeType || body.type, name);
  if (!Number.isFinite(size) || size <= 0) {
    const error = new Error('INVALID_FILE_SIZE');
    error.status = 400;
    throw error;
  }
  if (size > MAX_VIDEO_UPLOAD_BYTES) {
    const error = new Error('VIDEO_FILE_TOO_LARGE');
    error.status = 413;
    error.maxFileBytes = MAX_VIDEO_UPLOAD_BYTES;
    throw error;
  }
  if (!mimeType) {
    const error = new Error('UNSUPPORTED_VIDEO_TYPE');
    error.status = 415;
    throw error;
  }
  const number = (value, min, max) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
  };
  return {
    name,
    size: Math.floor(size),
    mimeType,
    duration: number(body.duration, 0, 4 * 60 * 60),
    width: Math.floor(number(body.width, 0, 16384)),
    height: Math.floor(number(body.height, 0, 16384)),
    hasAudio: Boolean(body.hasAudio),
  };
}

function directAssetUploadExpiresSeconds(size) {
  // Give large files enough time on a modest campus/public connection. The signed
  // form is still restricted to one object key and its declared max size.
  const estimatedSeconds = Math.ceil(Number(size || 0) / DIRECT_ASSET_UPLOAD_ESTIMATED_BYTES_PER_SECOND)
    + DIRECT_ASSET_UPLOAD_FINISHING_BUFFER_SECONDS;
  return Math.min(
    DIRECT_ASSET_UPLOAD_MAX_EXPIRES_SECONDS,
    Math.max(DIRECT_ASSET_UPLOAD_EXPIRES_SECONDS, estimatedSeconds)
  );
}

function scheduleDirectAssetCleanup() {
  if (directAssetCleanupTimer) return;
  directAssetCleanupTimer = setTimeout(async () => {
    directAssetCleanupTimer = null;
    const now = Date.now();
    const expired = [...directAssetUploads.values()].filter((session) => session.expiresAt <= now);
    expired.forEach((session) => directAssetUploads.delete(session.id));
    await Promise.all(expired.map((session) => cosStorage.deleteObjects([session.key]).catch(() => null)));
    if (directAssetUploads.size) scheduleDirectAssetCleanup();
  }, Math.min(DIRECT_ASSET_UPLOAD_TTL_MS, 5 * 60 * 1000));
  if (typeof directAssetCleanupTimer.unref === 'function') directAssetCleanupTimer.unref();
}

function getDirectAssetSession(req, sessionId) {
  const session = directAssetUploads.get(String(sessionId || ''));
  if (!session || session.userId !== req.user.id || session.expiresAt <= Date.now()) return null;
  return session;
}

async function createAssetRecord({ user, metadata, key }) {
  const [result] = await pool.query(
    `INSERT INTO video_editor_assets
     (user_id, org_id, name, storage_path, public_url, mime_type, file_size, duration_seconds, width, height, has_audio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, user.organization_id || null, metadata.name, key, null, metadata.mimeType, metadata.size,
      metadata.duration, metadata.width, metadata.height, metadata.hasAudio ? 1 : 0]
  );
  const [rows] = await pool.query('SELECT * FROM video_editor_assets WHERE id = ? AND user_id = ? LIMIT 1', [result.insertId, user.id]);
  return rows[0];
}
const assetDto = (row) => ({
  id: String(row.id), assetId: String(row.id), name: row.name, url: videoStorage.mediaProxyUrl(row.storage_path) || row.public_url,
  type: row.mime_type, size: Number(row.file_size) || 0, duration: Number(row.duration_seconds) || 0,
  width: Number(row.width) || 0, height: Number(row.height) || 0, hasAudio: Boolean(row.has_audio),
  analysis: parseJson(row.analysis_json, null), createdAt: row.created_at,
});
const projectDto = (row, detail = false) => ({
  id: String(row.id), name: row.name, aspectRatio: row.aspect_ratio, duration: Number(row.duration_seconds) || 0,
  version: Number(row.version) || 1, createdAt: row.created_at, updatedAt: row.updated_at,
  ...(detail ? { project: parseJson(row.project_json, {}) } : {}),
});
const renderDto = (row) => ({
  id: String(row.id), projectId: String(row.project_id), status: row.status, progress: Number(row.progress) || 0,
  stage: row.stage, outputUrl: (row.output_path && videoStorage.mediaProxyUrl(row.output_path)) || row.output_url,
  error: row.error_text, options: parseJson(row.render_options, {}),
  createdAt: row.created_at, startedAt: row.started_at, finishedAt: row.finished_at,
});

router.get('/assets', requirePermission('ai.generate'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM video_editor_assets WHERE user_id = ? ORDER BY created_at DESC LIMIT 300', [req.user.id]);
  res.json({ assets: rows.map(assetDto) });
});

router.post('/assets', requirePermission('ai.generate'), (req, res) => {
  const contentLength = Number(req.headers && req.headers['content-length']);
  if (Number.isFinite(contentLength)
    && contentLength > MAX_VIDEO_API_FALLBACK_BYTES + 32 * 1024 * 1024) {
    return res.status(413).json({
      error: 'VIDEO_UPLOAD_FAILED',
      message: '超过 5GB 的视频必须直传对象存储',
      maxFileBytes: MAX_VIDEO_API_FALLBACK_BYTES,
      directUploadRequiredAboveBytes: MAX_VIDEO_API_FALLBACK_BYTES,
    });
  }
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) {
      const status = uploadError && uploadError.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({
        error: 'VIDEO_UPLOAD_FAILED',
        message: uploadError.message,
        maxFileBytes: MAX_VIDEO_API_FALLBACK_BYTES,
        directUploadRequiredAboveBytes: MAX_VIDEO_API_FALLBACK_BYTES,
      });
    }
    if (!req.file) return res.status(400).json({ error: 'VIDEO_REQUIRED', message: '请选择视频文件' });
    try {
      const metadata = await probeVideo(req.file.path);
      if (!metadata.duration || !metadata.width || !metadata.height) throw new Error('无法识别视频轨道');
      const stored = await videoStorage.uploadAsset(req.file.path, {
        orgId: req.user.organization_id,
        userId: req.user.id,
        originalName: req.file.originalname,
        mimeType: req.file.mimetype,
      });
      try {
        const asset = await createAssetRecord({
          user: req.user,
          key: stored.key,
          metadata: {
            name: String(req.file.originalname || '视频').slice(0, 255),
            size: req.file.size || 0,
            mimeType: normalizeVideoMime(req.file.mimetype, req.file.originalname) || req.file.mimetype || 'video/mp4',
            duration: metadata.duration,
            width: metadata.width,
            height: metadata.height,
            hasAudio: metadata.hasAudio,
          },
        });
        res.status(201).json({ asset: assetDto(asset) });
      } catch (dbError) {
        await videoStorage.deleteObject(stored.key).catch(() => null);
        throw dbError;
      }
    } catch (error) {
      const status = error.status || (error.code === 'VIDEO_STORAGE_NOT_CONFIGURED' ? 503 : 400);
      res.status(status).json({ error: error.code || 'INVALID_VIDEO', message: error.message || '无法读取视频' });
    } finally {
      if (req.file && req.file.path) fs.unlink(req.file.path, () => {});
    }
  });
});

// 浏览器只得到一次性 S3 POST 表单；对象存储密钥始终留在服务端。
// 失败时前端会降级到上面的 /assets 接口，兼容对象存储 CORS 不可用的网络环境。
router.post('/assets/direct/init', requirePermission('ai.generate'), async (req, res) => {
  try {
    videoStorage.assertObjectStorage();
    const metadata = normalizeDirectAssetMetadata(req.body || {});
    const expiresIn = directAssetUploadExpiresSeconds(metadata.size);
    const key = videoStorage.assetObjectKey({
      orgId: req.user.organization_id,
      userId: req.user.id,
      originalName: metadata.name,
      mimeType: metadata.mimeType,
    });
    const post = await cosStorage.signedPost(key, {
      expires: expiresIn,
      contentType: metadata.mimeType,
      cacheControl: 'private, max-age=0, no-store',
      maxBytes: metadata.size,
    });
    const id = crypto.randomUUID();
    directAssetUploads.set(id, {
      id,
      userId: req.user.id,
      key,
      metadata,
      expiresAt: Date.now() + Math.max(
        DIRECT_ASSET_UPLOAD_TTL_MS,
        (expiresIn + DIRECT_ASSET_UPLOAD_FINISHING_BUFFER_SECONDS) * 1000
      ),
    });
    scheduleDirectAssetCleanup();
    return res.json({
      uploadMode: 'direct-post',
      sessionId: id,
      expiresIn,
      maxFileBytes: MAX_VIDEO_UPLOAD_BYTES,
      upload: { uploadUrl: post.postUrl, formFields: post.fields },
    });
  } catch (error) {
    return res.status(error.status || (error.code === 'VIDEO_STORAGE_NOT_CONFIGURED' ? 503 : 500)).json({
      error: error.code || error.message || 'DIRECT_VIDEO_INIT_FAILED',
      maxFileBytes: error.maxFileBytes,
    });
  }
});

router.post('/assets/direct/complete', requirePermission('ai.generate'), async (req, res) => {
  let session = null;
  try {
    session = getDirectAssetSession(req, req.body && req.body.sessionId);
    if (!session) return res.status(404).json({ error: 'DIRECT_VIDEO_SESSION_NOT_FOUND' });
    const head = await cosStorage.headObject(session.key);
    if (!head || Number(head.ContentLength) !== Number(session.metadata.size)) {
      const error = new Error('DIRECT_VIDEO_SIZE_MISMATCH');
      error.status = 400;
      throw error;
    }
    const asset = await createAssetRecord({ user: req.user, metadata: session.metadata, key: session.key });
    directAssetUploads.delete(session.id);
    return res.status(201).json({ asset: assetDto(asset) });
  } catch (error) {
    if (session) {
      directAssetUploads.delete(session.id);
      await cosStorage.deleteObjects([session.key]).catch(() => null);
    }
    return res.status(error.status || 500).json({ error: error.code || error.message || 'DIRECT_VIDEO_COMPLETE_FAILED' });
  }
});

router.post('/assets/direct/abort', requirePermission('ai.generate'), async (req, res) => {
  const session = getDirectAssetSession(req, req.body && req.body.sessionId);
  if (!session) return res.json({ ok: true });
  directAssetUploads.delete(session.id);
  await cosStorage.deleteObjects([session.key]).catch(() => null);
  return res.json({ ok: true });
});

router.post('/assets/:assetId/analyze', requirePermission('ai.generate'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM video_editor_assets WHERE id = ? AND user_id = ? LIMIT 1', [req.params.assetId, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'VIDEO_ASSET_NOT_FOUND' });
  let workDir = null;
  try {
    let input = await videoStorage.analysisInput(rows[0]);
    let metadata;
    try {
      metadata = await probeVideo(input);
    } catch (probeError) {
      // Legacy/non-faststart assets may not be seekable over the storage gateway.
      // Materialize only those exceptional files and clean them immediately after.
      workDir = await videoStorage.createJobWorkDir(`analyze-${rows[0].id}`);
      input = await videoStorage.materializeAsset(rows[0], workDir);
      metadata = await probeVideo(input);
    }
    if (!metadata.duration || !metadata.width || !metadata.height) throw new Error('无法识别视频轨道');
    await pool.query(
      'UPDATE video_editor_assets SET duration_seconds = ?, width = ?, height = ?, has_audio = ? WHERE id = ? AND user_id = ?',
      [metadata.duration, metadata.width, metadata.height, metadata.hasAudio ? 1 : 0, rows[0].id, req.user.id]
    );
    const analysis = await analyzeVideo(input, metadata.duration, {
      workDir,
      onProgress: ({ phase, completed, total }) => {
        if (phase === 'visual') console.log(`[video-projects] asset ${rows[0].id} temporal segment ${completed + 1}/${total}`);
      },
    });
    await pool.query('UPDATE video_editor_assets SET analysis_json = ? WHERE id = ? AND user_id = ?', [JSON.stringify(analysis), rows[0].id, req.user.id]);
    res.json({ analysis });
  } catch (error) {
    res.status(500).json({ error: 'VIDEO_ANALYSIS_FAILED', message: error.message || '视频分析失败' });
  } finally {
    await videoStorage.removeWorkDir(workDir).catch(() => null);
  }
});

router.get('/', requirePermission('ai.generate'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM video_projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100', [req.user.id]);
  res.json({ projects: rows.map((row) => projectDto(row, false)) });
});

router.post('/', requirePermission('ai.generate'), async (req, res) => {
  const project = req.body && req.body.project;
  if (!project || typeof project !== 'object') return res.status(400).json({ error: 'VIDEO_PROJECT_REQUIRED' });
  const name = String(req.body.name || project.name || '未命名视频工程').trim().slice(0, 160) || '未命名视频工程';
  const ratio = String(req.body.aspectRatio || project.aspectRatio || (project.canvas && project.canvas.aspectRatio) || '16:9').slice(0, 16);
  const [result] = await pool.query(
    'INSERT INTO video_projects (user_id, org_id, name, aspect_ratio, project_json, duration_seconds) VALUES (?, ?, ?, ?, ?, ?)',
    [req.user.id, req.user.organization_id || null, name, ratio, JSON.stringify(project), projectDuration(project)]
  );
  const [rows] = await pool.query('SELECT * FROM video_projects WHERE id = ? LIMIT 1', [result.insertId]);
  res.status(201).json({ project: projectDto(rows[0], true) });
});

router.get('/:id', requirePermission('ai.generate'), async (req, res, next) => {
  if (!/^\d+$/.test(req.params.id)) return next();
  const [rows] = await pool.query('SELECT * FROM video_projects WHERE id = ? AND user_id = ? LIMIT 1', [req.params.id, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'VIDEO_PROJECT_NOT_FOUND' });
  res.json({ project: projectDto(rows[0], true) });
});

router.put('/:id', requirePermission('ai.generate'), async (req, res) => {
  const project = req.body && req.body.project;
  if (!project || typeof project !== 'object') return res.status(400).json({ error: 'VIDEO_PROJECT_REQUIRED' });
  const name = String(req.body.name || project.name || '未命名视频工程').trim().slice(0, 160) || '未命名视频工程';
  const ratio = String(req.body.aspectRatio || project.aspectRatio || (project.canvas && project.canvas.aspectRatio) || '16:9').slice(0, 16);
  const [result] = await pool.query(
    'UPDATE video_projects SET name = ?, aspect_ratio = ?, project_json = ?, duration_seconds = ?, version = version + 1 WHERE id = ? AND user_id = ?',
    [name, ratio, JSON.stringify(project), projectDuration(project), req.params.id, req.user.id]
  );
  if (!result.affectedRows) return res.status(404).json({ error: 'VIDEO_PROJECT_NOT_FOUND' });
  const [rows] = await pool.query('SELECT * FROM video_projects WHERE id = ? AND user_id = ? LIMIT 1', [req.params.id, req.user.id]);
  res.json({ project: projectDto(rows[0], true) });
});

router.delete('/:id', requirePermission('ai.generate'), async (req, res) => {
  const [result] = await pool.query('DELETE FROM video_projects WHERE id = ? AND user_id = ?', [req.params.id, req.user.id]);
  if (!result.affectedRows) return res.status(404).json({ error: 'VIDEO_PROJECT_NOT_FOUND' });
  res.json({ ok: true });
});

function audioTrackClips(project) {
  if (Array.isArray(project.audioClips)) return project.audioClips;
  const tracks = Array.isArray(project.tracks) ? project.tracks : [];
  const track = tracks.find((item) => item && (item.type === 'audio' || item.id === 'A1'));
  return (track && Array.isArray(track.clips)) ? track.clips : [];
}

function referencedSourceIds(project) {
  const result = new Set();
  [...normalizeProjectClips(project), ...audioTrackClips(project)].forEach((clip) => {
    if (!clip || clip.kind === 'blank') return;
    const id = clip.sourceId || clip.assetId || clip.asset_id;
    if (id !== undefined && id !== null && String(id).trim()) result.add(String(id));
  });
  return result;
}

async function loadProductionRenderAssets(project, projectRow) {
  const sourceIds = referencedSourceIds(project);
  const sources = (Array.isArray(project.sources) ? project.sources : [])
    .filter((source) => source && sourceIds.has(String(source.id)) && /^\d+$/.test(String(source.productionPhotoId || '')));
  if (!sources.length) return [];

  const photoIds = [...new Set(sources.map((source) => Number(source.productionPhotoId)))];
  const orgId = projectRow.org_id === null || projectRow.org_id === undefined ? null : Number(projectRow.org_id);
  const orgClause = orgId === null ? 'p.organization_id IS NULL' : 'p.organization_id = ?';
  const params = [...photoIds];
  if (orgId !== null) params.push(orgId);
  const [rows] = await pool.query(
    `SELECT p.id, p.url, p.playback_url, p.title, p.type
       FROM photos p
      WHERE p.id IN (${photoIds.map(() => '?').join(',')})
        AND ${orgClause}
        AND (p.type = 'video' OR (p.playback_url IS NOT NULL AND p.playback_url <> ''))`,
    params
  );
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const assets = [];
  for (const source of sources) {
    const photo = byId.get(String(source.productionPhotoId));
    if (!photo || !(photo.playback_url || photo.url)) {
      const error = new Error(`图库素材「${String(source.name || source.productionPhotoId)}」不存在或无访问权限`);
      error.code = 'PRODUCTION_VIDEO_NOT_AVAILABLE';
      throw error;
    }
    // Only the trusted database path is used during export. Never trust a saved client URL.
    assets.push({
      id: String(source.id),
      name: String(photo.title || source.name || `视频 ${photo.id}`).slice(0, 255),
      storage_path: photo.playback_url || photo.url,
      mime_type: normalizeVideoMime(source.type, photo.title) || 'video/mp4',
      file_size: Number(source.size) || 0,
      duration_seconds: Number(source.duration) || 0,
      width: Number(source.width) || 0,
      height: Number(source.height) || 0,
      has_audio: 1,
      source_kind: 'production',
    });
  }
  return assets;
}

async function materializeRenderAssets(assets, workDir, userId) {
  return Promise.all(assets.map(async (asset) => {
    const localPath = await videoStorage.materializeAsset(asset, workDir);
    const metadata = await probeVideo(localPath);
    if (!metadata.duration || !metadata.width || !metadata.height) {
      throw new Error(`素材「${asset.name || asset.id}」无法识别视频轨道`);
    }
    if (asset.source_kind !== 'production') {
      await pool.query(
        'UPDATE video_editor_assets SET duration_seconds = ?, width = ?, height = ?, has_audio = ? WHERE id = ? AND user_id = ?',
        [metadata.duration, metadata.width, metadata.height, metadata.hasAudio ? 1 : 0, asset.id, userId]
      );
    }
    return {
      ...asset,
      storage_path: localPath,
      duration_seconds: metadata.duration,
      width: metadata.width,
      height: metadata.height,
      has_audio: metadata.hasAudio ? 1 : 0,
    };
  }));
}

async function runRender(jobId, userId, projectRow, options) {
  const signalRef = { child: null, canceled: false };
  let workDir = null;
  activeRenders.set(String(jobId), signalRef);
  try {
    await pool.query("UPDATE video_render_jobs SET status = 'running', progress = 1, stage = '准备素材', started_at = NOW() WHERE id = ?", [jobId]);
    const project = parseJson(projectRow.project_json, {});
    const sourceIds = referencedSourceIds(project);
    const renderSources = (Array.isArray(project.sources) ? project.sources : [])
      .filter((source) => source && sourceIds.has(String(source.id)));
    const ids = [...new Set(renderSources.map((source) => String(source.assetId || source.asset_id || '')).filter((id) => /^\d+$/.test(id)))];
    const hasBlankClip = normalizeProjectClips(project).some((clip) => clip && clip.kind === 'blank');
    const hasProductionSource = renderSources.some((source) => /^\d+$/.test(String(source.productionPhotoId || '')));
    if (!ids.length && !hasProductionSource && !hasBlankClip) throw new Error('工程素材尚未上传到服务端');
    const assets = ids.length
      ? (await pool.query(`SELECT * FROM video_editor_assets WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [userId, ...ids]))[0]
      : [];
    if (assets.length !== ids.length) throw new Error('工程包含无权访问或已经不存在的素材');
    const productionAssets = await loadProductionRenderAssets(project, projectRow);
    workDir = await videoStorage.createJobWorkDir(jobId);
    const localAssets = await materializeRenderAssets([...assets, ...productionAssets], workDir, userId);
    const outputPath = path.join(workDir, 'output.mp4');
    await renderProject({
      project, assetRows: localAssets, outputPath, options, signalRef,
      onProgress: (progress, stage) => pool.query('UPDATE video_render_jobs SET progress = ?, stage = ? WHERE id = ? AND status = \'running\'', [progress, stage, jobId]).catch(() => {}),
    });
    if (signalRef.canceled) return;
    await pool.query("UPDATE video_render_jobs SET progress = 99, stage = '上传导出文件' WHERE id = ? AND status = 'running'", [jobId]);
    const stored = await videoStorage.uploadRender(outputPath, {
      orgId: projectRow.org_id,
      userId,
      projectId: projectRow.id,
      jobId,
    });
    if (signalRef.canceled) {
      await videoStorage.deleteObject(stored.key).catch(() => null);
      return;
    }
    await pool.query(
      "UPDATE video_render_jobs SET status = 'completed', progress = 100, stage = '导出完成', output_path = ?, output_url = NULL, finished_at = NOW() WHERE id = ?",
      [stored.key, jobId]
    );
  } catch (error) {
    const status = signalRef.canceled ? 'canceled' : 'failed';
    await pool.query('UPDATE video_render_jobs SET status = ?, stage = ?, error_text = ?, finished_at = NOW() WHERE id = ?', [status, status === 'canceled' ? '已取消' : '导出失败', String(error.message || error).slice(0, 4000), jobId]);
  } finally {
    activeRenders.delete(String(jobId));
    await videoStorage.removeWorkDir(workDir).catch(() => null);
  }
}

function drainRenderQueue() {
  while (runningRenderCount < renderConcurrency && renderQueue.length) {
    const task = renderQueue.shift();
    runningRenderCount += 1;
    runRender(task.jobId, task.userId, task.projectRow, task.options)
      .catch((error) => console.error('[video-render] queue task failed:', error && error.stack ? error.stack : error))
      .finally(() => {
        runningRenderCount = Math.max(0, runningRenderCount - 1);
        drainRenderQueue();
      });
  }
}

function enqueueRender(task) {
  const id = String(task.jobId);
  if (activeRenders.has(id) || renderQueue.some((queued) => String(queued.jobId) === id)) return;
  renderQueue.push(task);
  drainRenderQueue();
}

async function recoverInterruptedRenders() {
  await pool.query(
    "UPDATE video_render_jobs SET status = 'queued', progress = 0, stage = '服务重启后重新排队', started_at = NULL WHERE status = 'running'"
  );
  const [rows] = await pool.query(
    `SELECT j.id AS job_id, j.user_id AS job_user_id, j.render_options, p.*
       FROM video_render_jobs j
       INNER JOIN video_projects p ON p.id = j.project_id AND p.user_id = j.user_id
      WHERE j.status = 'queued'
      ORDER BY j.created_at ASC
      LIMIT 100`
  );
  rows.forEach((row) => enqueueRender({
    jobId: row.job_id,
    userId: row.job_user_id,
    projectRow: row,
    options: parseJson(row.render_options, {}),
  }));
  if (rows.length) console.log(`[video-render] recovered ${rows.length} queued job(s)`);
}

router.post('/:id/render', requirePermission('ai.generate'), async (req, res) => {
  const [projects] = await pool.query('SELECT * FROM video_projects WHERE id = ? AND user_id = ? LIMIT 1', [req.params.id, req.user.id]);
  if (!projects.length) return res.status(404).json({ error: 'VIDEO_PROJECT_NOT_FOUND' });
  try {
    videoStorage.assertObjectStorage();
  } catch (error) {
    return res.status(error.status || 503).json({ error: error.code || 'VIDEO_STORAGE_NOT_CONFIGURED', message: error.message });
  }
  const options = req.body && typeof req.body === 'object' ? req.body : {};
  const [result] = await pool.query(
    "INSERT INTO video_render_jobs (project_id, user_id, status, progress, stage, render_options) VALUES (?, ?, 'queued', 0, '等待渲染', ?)",
    [req.params.id, req.user.id, JSON.stringify(options)]
  );
  const [rows] = await pool.query('SELECT * FROM video_render_jobs WHERE id = ? LIMIT 1', [result.insertId]);
  enqueueRender({ jobId: result.insertId, userId: req.user.id, projectRow: projects[0], options });
  res.status(202).json({ job: renderDto(rows[0]) });
});

router.get('/renders/:jobId', requirePermission('ai.generate'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM video_render_jobs WHERE id = ? AND user_id = ? LIMIT 1', [req.params.jobId, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'VIDEO_RENDER_NOT_FOUND' });
  res.json({ job: renderDto(rows[0]) });
});

router.post('/renders/:jobId/cancel', requirePermission('ai.generate'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM video_render_jobs WHERE id = ? AND user_id = ? LIMIT 1', [req.params.jobId, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'VIDEO_RENDER_NOT_FOUND' });
  const running = activeRenders.get(String(req.params.jobId));
  if (running) { running.canceled = true; if (running.child) running.child.kill('SIGTERM'); }
  const queuedIndex = renderQueue.findIndex((task) => String(task.jobId) === String(req.params.jobId));
  if (queuedIndex >= 0) renderQueue.splice(queuedIndex, 1);
  await pool.query("UPDATE video_render_jobs SET status = 'canceled', stage = '已取消', finished_at = NOW() WHERE id = ? AND user_id = ? AND status IN ('queued','running')", [req.params.jobId, req.user.id]);
  res.json({ ok: true });
});

router.use((error, _req, res, _next) => {
  console.error('[video-projects]', error && error.stack ? error.stack : error);
  res.status(500).json({ error: 'VIDEO_EDITOR_SERVER_ERROR', message: error.message || '视频编辑服务异常' });
});

module.exports = router;

if (String(process.env.VIDEO_RENDER_RECOVER_ON_BOOT || '1') !== '0') {
  const recoveryTimer = setTimeout(() => recoverInterruptedRenders().catch((error) => {
    console.warn('[video-render] startup recovery skipped:', error.message || error);
  }), 3000);
  if (typeof recoveryTimer.unref === 'function') recoveryTimer.unref();
}
