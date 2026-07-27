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

const router = express.Router();
const assetUploadDir = videoStorage.getUploadTempDir();

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, assetUploadDir),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 12) || '.mp4';
      cb(null, `${Date.now()}-${crypto.randomUUID()}${ext}`);
    },
  }),
  limits: { fileSize: Math.max(10, Number(process.env.VIDEO_UPLOAD_MAX_MB) || 2048) * 1024 * 1024 },
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
  return clips.reduce((sum, clip) => sum + Math.max(0, (Number(clip.outPoint) - Number(clip.inPoint)) / Math.max(0.01, Number(clip.speed) || 1)), 0);
};
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
  upload.single('file')(req, res, async (uploadError) => {
    if (uploadError) return res.status(400).json({ error: 'VIDEO_UPLOAD_FAILED', message: uploadError.message });
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
        const [result] = await pool.query(
          `INSERT INTO video_editor_assets
           (user_id, org_id, name, storage_path, public_url, mime_type, file_size, duration_seconds, width, height, has_audio)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, req.user.organization_id || null, String(req.file.originalname || '视频').slice(0, 255), stored.key,
            null, req.file.mimetype || null, req.file.size || 0, metadata.duration, metadata.width, metadata.height, metadata.hasAudio ? 1 : 0]
        );
        const [rows] = await pool.query('SELECT * FROM video_editor_assets WHERE id = ? AND user_id = ? LIMIT 1', [result.insertId, req.user.id]);
        res.status(201).json({ asset: assetDto(rows[0]) });
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

router.post('/assets/:assetId/analyze', requirePermission('ai.generate'), async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM video_editor_assets WHERE id = ? AND user_id = ? LIMIT 1', [req.params.assetId, req.user.id]);
  if (!rows.length) return res.status(404).json({ error: 'VIDEO_ASSET_NOT_FOUND' });
  let workDir = null;
  try {
    workDir = await videoStorage.createJobWorkDir(`analyze-${rows[0].id}`);
    const localPath = await videoStorage.materializeAsset(rows[0], workDir);
    const analysis = await analyzeVideo(localPath, rows[0].duration_seconds);
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

async function runRender(jobId, userId, projectRow, options) {
  const signalRef = { child: null, canceled: false };
  let workDir = null;
  activeRenders.set(String(jobId), signalRef);
  try {
    await pool.query("UPDATE video_render_jobs SET status = 'running', progress = 1, stage = '准备素材', started_at = NOW() WHERE id = ?", [jobId]);
    const project = parseJson(projectRow.project_json, {});
    const ids = [...new Set((project.sources || []).map((source) => String(source.assetId || source.asset_id || '')).filter((id) => /^\d+$/.test(id)))];
    const hasBlankClip = normalizeProjectClips(project).some((clip) => clip && clip.kind === 'blank');
    if (!ids.length && !hasBlankClip) throw new Error('工程素材尚未上传到服务端');
    const assets = ids.length
      ? (await pool.query(`SELECT * FROM video_editor_assets WHERE user_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [userId, ...ids]))[0]
      : [];
    if (assets.length !== ids.length) throw new Error('工程包含无权访问或已经不存在的素材');
    workDir = await videoStorage.createJobWorkDir(jobId);
    const localAssets = await Promise.all(assets.map(async (asset) => ({
      ...asset,
      storage_path: await videoStorage.materializeAsset(asset, workDir),
    })));
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
