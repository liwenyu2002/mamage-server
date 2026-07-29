const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pipeline } = require('stream/promises');
const cosStorage = require('./cos_storage');
const { signMediaQuery } = require('../db');

const workRoot = path.resolve(process.env.VIDEO_WORK_DIR || path.join(os.tmpdir(), 'mamage-video-editor'));
const uploadTempDir = path.join(workRoot, 'uploads');

function ensureWorkDirectories() {
  fs.mkdirSync(uploadTempDir, { recursive: true });
}

ensureWorkDirectories();

function safeSegment(value, fallback = '0') {
  const normalized = String(value == null ? '' : value).trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return normalized || fallback;
}

function extensionFor(filename, mimeType, fallback = '.mp4') {
  return cosStorage.extFromFilenameOrMime(filename, mimeType, fallback);
}

function assetObjectKey({ orgId, userId, originalName, mimeType }) {
  const ext = extensionFor(originalName, mimeType);
  return `uploads/video-editor/assets/${safeSegment(orgId, 'no-org')}/${safeSegment(userId)}/${crypto.randomUUID()}${ext}`;
}

function renderObjectKey({ orgId, userId, projectId, jobId }) {
  return `uploads/video-editor/renders/${safeSegment(orgId, 'no-org')}/${safeSegment(userId)}/${safeSegment(projectId)}/${safeSegment(jobId)}.mp4`;
}

function mediaProxyUrl(keyOrPath) {
  const key = cosStorage.keyFromUrlOrPath(keyOrPath);
  if (!key || !cosStorage.isSafeKey(key)) return null;
  if (!key.startsWith('uploads/video-editor/')) return null;
  const encoded = key.split('/').filter(Boolean).map((part) => encodeURIComponent(part)).join('/');
  return `/api/image/${encoded}${signMediaQuery(`/${key}`)}`;
}

function assertObjectStorage() {
  if (cosStorage.isConfigured()) return;
  const error = new Error('生产视频对象存储尚未配置');
  error.code = 'VIDEO_STORAGE_NOT_CONFIGURED';
  error.status = 503;
  throw error;
}

async function createJobWorkDir(jobId) {
  ensureWorkDirectories();
  return fs.promises.mkdtemp(path.join(workRoot, `job-${safeSegment(jobId)}-`));
}

async function removeWorkDir(dir) {
  if (!dir) return;
  const resolved = path.resolve(dir);
  if (resolved === workRoot || !resolved.startsWith(`${workRoot}${path.sep}`)) return;
  await fs.promises.rm(resolved, { recursive: true, force: true });
}

async function sweepStaleWorkDirs(maxAgeMs = Number(process.env.VIDEO_WORK_MAX_AGE_MS) || 24 * 60 * 60 * 1000) {
  ensureWorkDirectories();
  const now = Date.now();
  const entries = await fs.promises.readdir(workRoot, { withFileTypes: true });
  await Promise.all(entries.filter((entry) => entry.isDirectory() && entry.name.startsWith('job-')).map(async (entry) => {
    const target = path.join(workRoot, entry.name);
    const stat = await fs.promises.stat(target).catch(() => null);
    if (stat && now - stat.mtimeMs > maxAgeMs) await removeWorkDir(target);
  }));
}

async function uploadAsset(localPath, context) {
  assertObjectStorage();
  const key = assetObjectKey(context);
  await cosStorage.uploadFile(key, localPath, {
    contentType: context.mimeType || 'video/mp4',
    cacheControl: 'private, max-age=0, no-store',
  });
  return { key, url: mediaProxyUrl(key) };
}

async function uploadRender(localPath, context) {
  assertObjectStorage();
  const key = renderObjectKey(context);
  await cosStorage.uploadFile(key, localPath, {
    contentType: 'video/mp4',
    cacheControl: 'private, max-age=0, no-store',
  });
  return { key, url: mediaProxyUrl(key) };
}

async function deleteObject(key) {
  if (!key) return;
  await cosStorage.deleteObjects([key]);
}

async function materializeAsset(row, workDir) {
  const storedPath = String(row && row.storage_path || '').trim();
  if (!storedPath) throw new Error(`素材 ${row && row.id ? row.id : ''} 缺少存储路径`);
  if (path.isAbsolute(storedPath) && fs.existsSync(storedPath)) return storedPath;

  assertObjectStorage();
  const key = cosStorage.keyFromUrlOrPath(storedPath);
  if (!key || !cosStorage.isSafeKey(key)) throw new Error(`素材 ${row.id} 的对象键无效`);
  const ext = extensionFor(row.name, row.mime_type);
  const targetPath = path.join(workDir, `asset-${safeSegment(row.id)}${ext}`);
  const object = await cosStorage.getObject(key);
  if (!object || !object.Body) throw new Error(`素材 ${row.id} 无法从对象存储读取`);
  await pipeline(object.Body, fs.createWriteStream(targetPath, { flags: 'wx' }));
  return targetPath;
}

async function analysisInput(row, options = {}) {
  const storedPath = String(row && row.storage_path || '').trim();
  if (!storedPath) throw new Error(`素材 ${row && row.id ? row.id : ''} 缺少存储路径`);
  if (path.isAbsolute(storedPath) && fs.existsSync(storedPath)) return storedPath;

  // FFmpeg can seek a presigned S3 URL directly. It normally uses HTTP Range
  // reads for the small temporal windows we sample, avoiding a full local copy.
  assertObjectStorage();
  const key = cosStorage.keyFromUrlOrPath(storedPath);
  if (!key || !cosStorage.isSafeKey(key)) throw new Error(`素材 ${row.id} 的对象键无效`);
  const signed = await cosStorage.signedGetUrl(key, {
    expires: Math.max(60, Number(options.expires) || 6 * 60 * 60),
  });
  if (!signed || !signed.signedUrl) throw new Error(`素材 ${row.id} 无法创建分析读取地址`);
  return signed.signedUrl;
}

module.exports = {
  assetObjectKey,
  analysisInput,
  assertObjectStorage,
  createJobWorkDir,
  deleteObject,
  getUploadTempDir: () => uploadTempDir,
  materializeAsset,
  mediaProxyUrl,
  removeWorkDir,
  sweepStaleWorkDirs,
  uploadAsset,
  uploadRender,
  workRoot,
};

sweepStaleWorkDirs().catch((error) => console.warn('[video-storage] stale work cleanup failed:', error.message));
const sweepTimer = setInterval(() => sweepStaleWorkDirs().catch(() => null), 6 * 60 * 60 * 1000);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
