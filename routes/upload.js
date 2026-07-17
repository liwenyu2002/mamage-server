// routes/upload.js
const express = require('express');
const router = express.Router();
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const multer = require('multer');
const sharp = require('sharp');
const { v4: uuidv4 } = require('uuid');
const { pool, buildUploadUrl } = require('../db');
const cosStorage = require('../lib/cos_storage');
const { requirePermission } = require('../lib/permissions');

const execFileAsync = promisify(execFile);

const MAX_UPLOAD_BYTES = Math.max(1, Number(process.env.UPLOAD_MAX_FILE_MB || 30)) * 1024 * 1024;
const MAX_VIDEO_UPLOAD_BYTES = Math.max(1, Number(process.env.UPLOAD_MAX_VIDEO_MB || 512)) * 1024 * 1024;
const THUMB_MAX_DIMENSION = Math.max(320, Number(process.env.UPLOAD_THUMB_MAX_DIMENSION || process.env.UPLOAD_THUMB_MAX_WIDTH || 800));
const THUMB_QUALITY = Math.min(95, Math.max(50, Number(process.env.UPLOAD_THUMB_JPEG_QUALITY || 80)));
const UPLOAD_CACHE_CONTROL = process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable';
const SIGNED_UPLOAD_EXPIRES_SECONDS = Number(process.env.COS_SIGNED_UPLOAD_EXPIRES_SECONDS || 900);
const UPLOAD_TIMING_LOGS = parseEnvBoolean(process.env.UPLOAD_TIMING_LOGS) === true;
const VIDEO_FASTSTART_ENABLED = parseEnvBoolean(process.env.VIDEO_FASTSTART_ENABLED) !== false;
const VIDEO_FASTSTART_TIMEOUT_MS = Math.max(10000, Number(process.env.VIDEO_FASTSTART_TIMEOUT_MS || 120000));
const FFMPEG_PATH = process.env.FFMPEG_PATH || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const VIDEO_PREVIEW_ENABLED = parseEnvBoolean(process.env.VIDEO_PREVIEW_ENABLED) !== false;
const VIDEO_PREVIEW_MAX_WIDTH = Math.max(360, Number(process.env.VIDEO_PREVIEW_MAX_WIDTH || 1280));
const VIDEO_PREVIEW_TIMEOUT_MS = Math.max(10000, Number(process.env.VIDEO_PREVIEW_TIMEOUT_MS || 180000));
const VIDEO_POSTER_CAPTURE_SECONDS = Math.max(0, Number(process.env.VIDEO_POSTER_CAPTURE_SECONDS || 1));
const VIDEO_PLAYBACK_ENABLED = parseEnvBoolean(process.env.VIDEO_PLAYBACK_ENABLED) !== false;
const VIDEO_PLAYBACK_MAX_WIDTH = Math.max(640, envNumber(process.env.VIDEO_PLAYBACK_MAX_WIDTH, 1280));
const VIDEO_PLAYBACK_CRF = Math.min(32, Math.max(20, envNumber(process.env.VIDEO_PLAYBACK_CRF, 27)));
const VIDEO_PLAYBACK_MAXRATE = process.env.VIDEO_PLAYBACK_MAXRATE || '2800k';
const VIDEO_PLAYBACK_BUFSIZE = process.env.VIDEO_PLAYBACK_BUFSIZE || '5600k';
const VIDEO_PLAYBACK_TIMEOUT_MS = Math.max(30000, envNumber(process.env.VIDEO_PLAYBACK_TIMEOUT_MS, 900000));
const VIDEO_TMP_MIN_FREE_BYTES = Math.max(0, envNumber(process.env.VIDEO_TMP_MIN_FREE_MB, 2048)) * 1024 * 1024;

const IMAGE_MIME_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.avif', 'image/avif'], // 浏览器可显示、sharp 可处理，直存
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.tif', 'image/tiff'],  // 浏览器显示不了 → 与 heic 一样转码为 JPEG（sharp 可读）
  ['.tiff', 'image/tiff'],
  // 各厂 RAW：浏览器显示不了、sharp 也解不了传感器数据 → 抽内嵌 JPEG 预览转码（见 extractLargestEmbeddedJpeg）
  ['.dng', 'image/x-adobe-dng'], ['.cr2', 'image/x-canon-cr2'], ['.cr3', 'image/x-canon-cr3'],
  ['.crw', 'image/x-canon-crw'], ['.nef', 'image/x-nikon-nef'], ['.nrw', 'image/x-nikon-nrw'],
  ['.arw', 'image/x-sony-arw'], ['.sr2', 'image/x-sony-sr2'], ['.srf', 'image/x-sony-srf'],
  ['.raf', 'image/x-fuji-raf'], ['.orf', 'image/x-olympus-orf'], ['.rw2', 'image/x-panasonic-rw2'],
  ['.raw', 'image/x-panasonic-raw'], ['.pef', 'image/x-pentax-pef'], ['.srw', 'image/x-samsung-srw'],
  ['.x3f', 'image/x-sigma-x3f'], ['.rwl', 'image/x-leica-rwl'], ['.3fr', 'image/x-hasselblad-3fr'],
  ['.fff', 'image/x-hasselblad-fff'], ['.iiq', 'image/x-phaseone-iiq'], ['.mrw', 'image/x-minolta-mrw'],
  ['.dcr', 'image/x-kodak-dcr'], ['.kdc', 'image/x-kodak-kdc'], ['.mos', 'image/x-leaf-mos'],
  ['.erf', 'image/x-epson-erf'],
]);
const ALLOWED_IMAGE_MIMES = new Set(IMAGE_MIME_BY_EXT.values());
const VIDEO_MIME_BY_EXT = new Map([
  ['.mp4', 'video/mp4'],
  ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'],
  ['.webm', 'video/webm'],
  ['.ogg', 'video/ogg'],
  ['.ogv', 'video/ogg'],
]);
const ALLOWED_VIDEO_MIMES = new Set(VIDEO_MIME_BY_EXT.values());
const VIDEO_UPLOAD_TMP_DIR = process.env.UPLOAD_VIDEO_TMP_DIR || path.join(os.tmpdir(), 'mamage-video-uploads');
const DIRECT_VIDEO_PART_SIZE = Math.max(5 * 1024 * 1024, envNumber(process.env.DIRECT_VIDEO_PART_SIZE_MB, 16) * 1024 * 1024);
const DIRECT_VIDEO_MAX_PARTS = 10000;
const DIRECT_VIDEO_SESSION_TTL_MS = Math.max(10 * 60 * 1000, envNumber(process.env.DIRECT_VIDEO_SESSION_TTL_MINUTES, 180) * 60 * 1000);
const DIRECT_VIDEO_PART_URL_BATCH = Math.min(32, Math.max(1, envNumber(process.env.DIRECT_VIDEO_PART_URL_BATCH, 12)));
const directVideoUploads = new Map();

function parseEnvBoolean(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return null;
}

// 环境变量配成非数字时回退默认值，避免 NaN 传染（Math.max(x, NaN)=NaN）
function envNumber(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
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

function cleanupDirectVideoUploads() {
  const now = Date.now();
  for (const [id, session] of directVideoUploads) {
    if (!session || session.expiresAt > now) continue;
    directVideoUploads.delete(id);
    if (session.storageUploadId) cosStorage.abortMultipartUpload(session.originalKey, session.storageUploadId).catch(() => null);
    else cosStorage.deleteObjects([session.originalKey]).catch(() => null);
  }
}

function getDirectVideoSession(req, sessionId) {
  cleanupDirectVideoUploads();
  const session = directVideoUploads.get(String(sessionId || ''));
  if (!session) return null;
  const orgId = getOrgId(req);
  if (Number(session.userId) !== Number(req.user && req.user.id) || Number(session.orgId) !== Number(orgId)) return null;
  return session;
}

function scheduleDirectVideoCleanup() {
  const timer = setTimeout(cleanupDirectVideoUploads, DIRECT_VIDEO_SESSION_TTL_MS + 1000);
  if (timer && typeof timer.unref === 'function') timer.unref();
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

try {
  fs.mkdirSync(VIDEO_UPLOAD_TMP_DIR, { recursive: true });
} catch (err) {
  console.warn('[upload] create video tmp dir failed:', err && err.message ? err.message : err);
}

// 启动清扫：进程崩溃/pm2 restart 会把 multer 原件和转码半成品留在 tmp 目录，
// 超过 24h 的一律清掉（in-flight 任务不会活这么久）
(async () => {
  const maxAgeMs = Math.max(1, envNumber(process.env.VIDEO_TMP_SWEEP_HOURS, 24)) * 3600 * 1000;
  try {
    const entries = await fs.promises.readdir(VIDEO_UPLOAD_TMP_DIR);
    let removed = 0;
    for (const name of entries) {
      const full = path.join(VIDEO_UPLOAD_TMP_DIR, name);
      try {
        const st = await fs.promises.stat(full);
        if (st.isFile() && Date.now() - st.mtimeMs > maxAgeMs) {
          await fs.promises.unlink(full);
          removed += 1;
        }
      } catch (e) { /* 单文件失败忽略 */ }
    }
    if (removed) console.log(`[upload.video] tmp sweep removed ${removed} stale file(s)`);
  } catch (e) { /* 目录不可读则跳过 */ }
})();

const videoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, VIDEO_UPLOAD_TMP_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(String(file && file.originalname || '')).toLowerCase() || '.mp4';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const videoUpload = multer({
  storage: videoStorage,
  limits: {
    fileSize: MAX_VIDEO_UPLOAD_BYTES,
    files: 1,
    fields: 16,
    parts: 24,
  },
  fileFilter: (req, file, cb) => {
    const mime = inferVideoMime(file && file.mimetype, file && file.originalname);
    if (!mime || !ALLOWED_VIDEO_MIMES.has(mime)) {
      const err = new Error('UNSUPPORTED_VIDEO_TYPE');
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

function inferVideoMime(mimeType, filename) {
  const mime = String(mimeType || '').trim().toLowerCase();
  if (ALLOWED_VIDEO_MIMES.has(mime)) return mime;
  const ext = path.extname(String(filename || '')).toLowerCase();
  return VIDEO_MIME_BY_EXT.get(ext) || null;
}

function shouldFastStartVideo(mimeType, filePath) {
  if (!VIDEO_FASTSTART_ENABLED) return false;
  const mime = String(mimeType || '').toLowerCase();
  const ext = path.extname(String(filePath || '')).toLowerCase();
  return mime === 'video/mp4' || mime === 'video/quicktime' || ext === '.mp4' || ext === '.m4v' || ext === '.mov';
}

async function prepareVideoForStreaming(filePath, mimeType) {
  if (!filePath || !shouldFastStartVideo(mimeType, filePath)) {
    const stat = filePath ? await fs.promises.stat(filePath).catch(() => null) : null;
    return { filePath, cleanupPath: null, size: stat ? stat.size : null, fastStarted: false };
  }

  const ext = path.extname(String(filePath || '')).toLowerCase() || '.mp4';
  const outputPath = path.join(VIDEO_UPLOAD_TMP_DIR, `${uuidv4()}-faststart${ext}`);
  try {
    // 只挑视频/音频主流：iPhone 视频常带 timecode/data 流，'-map 0' 全流 copy 会因
    // "Could not find tag for codec none" 写 mp4 头失败（生产 2026-07-09 实际报错）
    await execFileAsync(FFMPEG_PATH, [
      '-y',
      '-v', 'error',
      '-i', filePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c', 'copy',
      '-movflags', '+faststart',
      '-avoid_negative_ts', 'make_zero',
      outputPath,
    ], {
      timeout: VIDEO_FASTSTART_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const stat = await fs.promises.stat(outputPath);
    if (!stat.size) throw new Error('ffmpeg produced empty video');
    return { filePath: outputPath, cleanupPath: outputPath, size: stat.size, fastStarted: true };
  } catch (err) {
    fs.promises.unlink(outputPath).catch(() => null);
    console.warn('[upload.video] faststart skipped:', err && err.message ? err.message : err);
    const stat = await fs.promises.stat(filePath).catch(() => null);
    return { filePath, cleanupPath: null, size: stat ? stat.size : null, fastStarted: false };
  }
}

async function createVideoPosterForPreview(filePath) {
  if (!VIDEO_PREVIEW_ENABLED || !filePath) return null;

  const outputPath = path.join(VIDEO_UPLOAD_TMP_DIR, `${uuidv4()}-poster.jpg`);
  const buildArgs = (seekSeconds) => [
    '-y',
    '-v', 'error',
    ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
    '-i', filePath,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', `scale=min(${VIDEO_PREVIEW_MAX_WIDTH}\\,iw):-2`,
    '-q:v', '3',
    outputPath,
  ];

  const runCapture = async (seekSeconds) => {
    await execFileAsync(FFMPEG_PATH, buildArgs(seekSeconds), {
      timeout: VIDEO_PREVIEW_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
  };

  try {
    try {
      await runCapture(VIDEO_POSTER_CAPTURE_SECONDS);
    } catch (err) {
      if (VIDEO_POSTER_CAPTURE_SECONDS <= 0) throw err;
      await runCapture(0);
    }
    const stat = await fs.promises.stat(outputPath);
    if (!stat.size) throw new Error('ffmpeg produced empty poster');
    return { filePath: outputPath, size: stat.size };
  } catch (err) {
    fs.promises.unlink(outputPath).catch(() => null);
    console.warn('[upload.video] poster skipped:', err && err.message ? err.message : err);
    return null;
  }
}

async function createVideoPlaybackForWeb(filePath) {
  if (!VIDEO_PLAYBACK_ENABLED || !filePath) return null;

  const outputPath = path.join(VIDEO_UPLOAD_TMP_DIR, `${uuidv4()}-playback.mp4`);
  try {
    await execFileAsync(FFMPEG_PATH, [
      '-y',
      '-v', 'error',
      '-i', filePath,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      // trunc(.../2)*2：宽度也强制取偶，否则奇数宽源（裁剪导出/录屏）libx264+yuv420p 直接编码失败
      '-vf', `scale=trunc(min(${VIDEO_PLAYBACK_MAX_WIDTH}\\,iw)/2)*2:-2`,
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', String(VIDEO_PLAYBACK_CRF),
      '-maxrate', VIDEO_PLAYBACK_MAXRATE,
      '-bufsize', VIDEO_PLAYBACK_BUFSIZE,
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'high',
      '-level', '4.1',
      '-movflags', '+faststart',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-ac', '2',
      '-ar', '48000',
      outputPath,
    ], {
      timeout: VIDEO_PLAYBACK_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
    });
    const stat = await fs.promises.stat(outputPath);
    if (!stat.size) throw new Error('ffmpeg produced empty playback video');
    return { filePath: outputPath, size: stat.size };
  } catch (err) {
    fs.promises.unlink(outputPath).catch(() => null);
    console.warn('[upload.video] playback skipped:', err && err.message ? err.message : err);
    return null;
  }
}

function unlinkFileQuiet(filePath) {
  if (!filePath) return;
  fs.promises.unlink(filePath).catch(() => null);
}

// 转码并发控制：ffmpeg x264 单路即可吃满数核，Mac Mini 同时还跑其他服务，
// 默认串行排队；队列纯内存，进程重启丢任务由 npm run video:playback:backfill 兜底。
const VIDEO_PLAYBACK_CONCURRENCY = Math.max(1, envNumber(process.env.VIDEO_PLAYBACK_CONCURRENCY, 1));
let playbackJobsActive = 0;
const playbackJobsWaiting = [];

function drainPlaybackQueue() {
  while (playbackJobsActive < VIDEO_PLAYBACK_CONCURRENCY && playbackJobsWaiting.length) {
    const job = playbackJobsWaiting.shift();
    playbackJobsActive += 1;
    Promise.resolve()
      .then(job)
      .catch((err) => console.error('[upload.video] playback job crashed:', err && err.stack ? err.stack : err))
      .finally(() => {
        playbackJobsActive -= 1;
        drainPlaybackQueue();
      });
  }
}

async function tmpDirFreeBytes() {
  try {
    const st = await fs.promises.statfs(VIDEO_UPLOAD_TMP_DIR);
    return Number(st.bsize) * Number(st.bavail);
  } catch (err) {
    return null; // statfs 不可用时放行，不因探测失败拒绝上传
  }
}

function enqueueVideoPlaybackTranscode({ sourceFilePath, cleanupPaths, playbackKey, playbackRel, insertedId }) {
  if (!VIDEO_PLAYBACK_ENABLED || !sourceFilePath || !playbackKey || !playbackRel || !insertedId) return false;
  const cleanupSet = Array.from(new Set((cleanupPaths || []).filter(Boolean)));

  playbackJobsWaiting.push(async () => {
    let playbackVideo = null;
    try {
      playbackVideo = await createVideoPlaybackForWeb(sourceFilePath);
      if (!playbackVideo) {
        console.warn('[upload.video] playback job produced no file:', insertedId);
        return;
      }
      await cosStorage.uploadFile(playbackKey, playbackVideo.filePath, {
        contentType: 'video/mp4',
        contentLength: playbackVideo.size,
        cacheControl: UPLOAD_CACHE_CONTROL,
      });
      let updateResult;
      try {
        [updateResult] = await pool.query(
          'UPDATE photos SET playback_url = ? WHERE id = ? AND (playback_url IS NULL OR playback_url = \'\')',
          [playbackRel, insertedId]
        );
      } catch (dbErr) {
        // 列不存在/DB 瞬时故障：回收刚上传的对象再抛出（key 确定性，之后 backfill 会重建）
        await cosStorage.deleteObjects([playbackKey]).catch(() => null);
        throw dbErr;
      }
      if (!updateResult || !updateResult.affectedRows) {
        // 转码期间照片已被删除：回收刚上传的对象，避免 COS 孤儿
        console.warn('[upload.video] playback update matched no row, deleting object:', insertedId, playbackKey);
        await cosStorage.deleteObjects([playbackKey]).catch(() => null);
        return;
      }
      console.log('[upload.video] playback ready', {
        mediaId: insertedId,
        playbackBytes: playbackVideo.size,
        playbackRel,
      });
    } catch (err) {
      console.error('[upload.video] playback job failed:', insertedId, err && err.stack ? err.stack : err);
    } finally {
      if (playbackVideo && playbackVideo.filePath) unlinkFileQuiet(playbackVideo.filePath);
      cleanupSet.forEach(unlinkFileQuiet);
    }
  });
  drainPlaybackQueue();

  return true;
}

// 直传视频先落对象存储，随后才由 Mac Mini 从内网对象存储取回做 faststart、封面和播放转码。
// 这样用户上传不再经过本机临时盘；本机磁盘只承担受并发队列限制的后处理工作区。
function enqueueDirectVideoPostProcess({ sourceKey, mimeType, thumbKey, thumbRel, playbackKey, playbackRel, insertedId }) {
  if (!insertedId || !sourceKey || (!VIDEO_PREVIEW_ENABLED && !VIDEO_PLAYBACK_ENABLED)) return false;
  playbackJobsWaiting.push(async () => {
    const ext = path.extname(String(sourceKey || '')).toLowerCase() || '.mp4';
    const sourcePath = path.join(VIDEO_UPLOAD_TMP_DIR, `${uuidv4()}-direct-source${ext}`);
    let preparedVideo = null;
    let posterImage = null;
    let playbackVideo = null;
    let posterReadyForAnalysis = false;
    try {
      const head = await cosStorage.headObject(sourceKey);
      const sourceBytes = Number(head && head.ContentLength) || 0;
      const freeBytes = await tmpDirFreeBytes();
      const requiredBytes = Math.max(sourceBytes * 2, VIDEO_TMP_MIN_FREE_BYTES);
      if (freeBytes !== null && freeBytes < requiredBytes) throw new Error('INSUFFICIENT_STORAGE_FOR_VIDEO_PROCESSING');

      const source = await cosStorage.getObject(sourceKey);
      if (!source || !source.Body) throw new Error('DIRECT_VIDEO_SOURCE_UNAVAILABLE');
      await pipeline(source.Body, fs.createWriteStream(sourcePath));

      preparedVideo = await prepareVideoForStreaming(sourcePath, mimeType);
      const workPath = preparedVideo.filePath || sourcePath;
      if (preparedVideo.fastStarted && workPath !== sourcePath) {
        await cosStorage.uploadFile(sourceKey, workPath, {
          contentType: mimeType,
          contentLength: preparedVideo.size,
          cacheControl: UPLOAD_CACHE_CONTROL,
        });
      }

      if (VIDEO_PREVIEW_ENABLED && thumbKey && thumbRel) {
        posterImage = await createVideoPosterForPreview(workPath);
        if (posterImage) {
          await cosStorage.uploadFile(thumbKey, posterImage.filePath, {
            contentType: 'image/jpeg', contentLength: posterImage.size, cacheControl: UPLOAD_CACHE_CONTROL,
          });
          const [posterUpdate] = await pool.query(
            'UPDATE photos SET thumb_url = ? WHERE id = ? AND (thumb_url IS NULL OR thumb_url = \'\')',
            [thumbRel, insertedId]
          );
          if (!posterUpdate || !posterUpdate.affectedRows) {
            await cosStorage.deleteObjects([thumbKey]).catch(() => null);
          } else {
            posterReadyForAnalysis = true;
          }
        }
      }
      // 封面就绪即可进行低优先级语义分析，不必等更耗时的播放转码完成。
      if (posterReadyForAnalysis) {
        await enableVideoSemanticAnalysis({ insertedId, thumbRel });
      }

      if (VIDEO_PLAYBACK_ENABLED && playbackKey && playbackRel) {
        playbackVideo = await createVideoPlaybackForWeb(workPath);
        if (playbackVideo) {
          await cosStorage.uploadFile(playbackKey, playbackVideo.filePath, {
            contentType: 'video/mp4', contentLength: playbackVideo.size, cacheControl: UPLOAD_CACHE_CONTROL,
          });
          const [playbackUpdate] = await pool.query(
            'UPDATE photos SET playback_url = ? WHERE id = ? AND (playback_url IS NULL OR playback_url = \'\')',
            [playbackRel, insertedId]
          );
          if (!playbackUpdate || !playbackUpdate.affectedRows) await cosStorage.deleteObjects([playbackKey]).catch(() => null);
        }
      }
      console.log('[upload.video] direct post-process ready', { mediaId: insertedId });
    } catch (err) {
      console.error('[upload.video] direct post-process failed:', insertedId, err && err.stack ? err.stack : err);
    } finally {
      if (playbackVideo && playbackVideo.filePath) unlinkFileQuiet(playbackVideo.filePath);
      if (posterImage && posterImage.filePath) unlinkFileQuiet(posterImage.filePath);
      if (preparedVideo && preparedVideo.cleanupPath) unlinkFileQuiet(preparedVideo.cleanupPath);
      unlinkFileQuiet(sourcePath);
    }
  });
  drainPlaybackQueue();
  return true;
}

function parseProjectId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const projectId = parseInt(raw, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) return null;
  return projectId;
}

function parseTimelineSectionId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const sectionId = parseInt(raw, 10);
  if (!Number.isFinite(sectionId) || sectionId <= 0) return null;
  return sectionId;
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
    timelineSectionId: parseTimelineSectionId(body && (body.timelineSectionId || body.timeline_section_id || body.sectionId)),
  };
}

function buildObjectKeys(projectId, originalName, mimeType, mediaType = 'image') {
  let keyPrefix;
  if (Number(projectId) === 1) {
    keyPrefix = mediaType === 'video' ? 'uploads/scenery/videos' : 'uploads/scenery';
  } else {
    const now = new Date();
    const year = now.getFullYear().toString();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    keyPrefix = mediaType === 'video' ? `uploads/videos/${year}/${month}/${day}` : `uploads/${year}/${month}/${day}`;
  }
  const ext = cosStorage.extFromFilenameOrMime(originalName, mimeType, mediaType === 'video' ? '.mp4' : '.jpg');
  const filename = `${uuidv4()}${ext}`;
  const originalKey = `${keyPrefix}/${filename}`;
  const thumbKey = mediaType === 'video'
    ? `${keyPrefix}/previews/poster_${path.basename(filename, ext)}.jpg`
    : `${keyPrefix}/thumbs/thumb_${path.basename(filename, ext)}.jpg`;
  const playbackKey = mediaType === 'video'
    ? `${keyPrefix}/playback/playback_${path.basename(filename, ext)}.mp4`
    : null;
  return {
    originalKey,
    thumbKey,
    playbackKey,
    relPath: `/${originalKey}`,
    thumbRel: thumbKey ? `/${thumbKey}` : null,
    playbackRel: playbackKey ? `/${playbackKey}` : null,
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

async function ensureTimelineSectionInProject(db, projectId, orgId, timelineSectionId) {
  if (!timelineSectionId) return null;
  if (!projectId) {
    const err = new Error('TIMELINE_SECTION_REQUIRES_PROJECT');
    err.status = 400;
    throw err;
  }
  let sql = `
    SELECT pts.id, pts.name, pts.section_time AS sectionTime
    FROM project_timeline_sections pts
    INNER JOIN projects p ON pts.project_id = p.id
    WHERE pts.id = ? AND pts.project_id = ?
  `;
  const params = [timelineSectionId, projectId];
  if (orgId === null) {
    sql += ' AND p.organization_id IS NULL';
  } else {
    sql += ' AND p.organization_id = ?';
    params.push(orgId);
  }
  const [rows] = await db.query(sql, params);
  if (!rows || rows.length === 0) {
    const err = new Error('INVALID_TIMELINE_SECTION');
    err.status = 400;
    throw err;
  }
  return rows[0];
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
    await ensureTimelineSectionInProject(conn, payload.projectId, payload.orgId, payload.timelineSectionId);

    let result;
    try {
      [result] = await conn.query(
        `INSERT INTO photos
          (uuid, project_id, timeline_section_id, url, thumb_url, playback_url, title, description, tags, ai_status, ai_error, type, photographer_id, organization_id)
         VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
        [
          payload.projectId || null,
          payload.timelineSectionId || null,
          payload.relPath,
          payload.thumbRel,
          payload.playbackRel || null,
          payload.title,
          payload.description,
          payload.tags ? JSON.stringify(payload.tags) : null,
          payload.aiStatus || 'pending',
          payload.type,
          payload.photographerId || null,
          payload.orgId,
        ]
      );
    } catch (err) {
      if (err && (err.code === 'ER_BAD_FIELD_ERROR' || String(err.message || '').includes('Unknown column'))) {
        if (String(err.message || '').includes('playback_url')) {
          [result] = await conn.query(
            `INSERT INTO photos
              (uuid, project_id, timeline_section_id, url, thumb_url, title, description, tags, ai_status, ai_error, type, photographer_id, organization_id)
             VALUES (UUID(), ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
            [
              payload.projectId || null,
              payload.timelineSectionId || null,
              payload.relPath,
              payload.thumbRel,
              payload.title,
              payload.description,
              payload.tags ? JSON.stringify(payload.tags) : null,
              payload.aiStatus || 'pending',
              payload.type,
              payload.photographerId || null,
              payload.orgId,
            ]
          );
        } else {
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
        }
      } else if (err && (err.code === 'ER_NO_DEFAULT_FOR_FIELD' || String(err.message || '').includes("doesn't have a default value"))) {
        err.status = 400;
        err.publicMessage = 'Database requires photos.organization_id. Assign organization to the uploading user.';
        throw err;
      } else {
        throw err;
      }
    }

    const insertedId = result.insertId;
    await conn.commit();
    return insertedId;
  } catch (err) {
    try { await conn.rollback(); } catch (e) { }
    throw err;
  } finally {
    conn.release();
  }
}

function isRetryableDbWriteError(err) {
  const code = String(err && err.code || '');
  const errno = Number(err && err.errno);
  const message = String(err && err.message || '').toLowerCase();
  return code === 'ER_LOCK_DEADLOCK'
    || code === 'ER_LOCK_WAIT_TIMEOUT'
    || errno === 1213
    || errno === 1205
    || message.includes('deadlock found')
    || message.includes('lock wait timeout');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createPhotoRecordWithRetry(payload) {
  const maxAttempts = Math.max(1, Number(process.env.UPLOAD_DB_INSERT_ATTEMPTS || 3));
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await createPhotoRecord(payload);
    } catch (err) {
      lastErr = err;
      if (!isRetryableDbWriteError(err) || attempt >= maxAttempts) break;
      await sleep(40 * attempt + Math.floor(Math.random() * 40));
    }
  }
  throw lastErr;
}

async function appendPhotoIdToProjectBestEffort(projectId, insertedId) {
  if (!projectId || !insertedId) return;
  const maxAttempts = Math.max(1, Number(process.env.UPLOAD_PROJECT_PHOTO_IDS_ATTEMPTS || 2));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await appendPhotoIdToProject(conn, projectId, insertedId);
      await conn.commit();
      return;
    } catch (err) {
      try { await conn.rollback(); } catch (e) { }
      if (!isRetryableDbWriteError(err) || attempt >= maxAttempts) {
        console.warn('[upload] skip project photo_ids sync:', err && err.message ? err.message : err);
        return;
      }
      await sleep(80 * attempt + Math.floor(Math.random() * 80));
    } finally {
      conn.release();
    }
  }
}

function nowMs() {
  if (typeof process.hrtime === 'function' && process.hrtime.bigint) {
    return Number(process.hrtime.bigint() / BigInt(1000000));
  }
  return Date.now();
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

// HEIC/HEIF：浏览器不能直接显示，且预置 sharp/libvips 缺 HEVC 解码器（format.heif 只认 .avif）。
// 用 heic-convert（内置 libheif WASM，自带 HEVC 解码）先转成高质量 JPEG，再走后续 sharp 管线。
const HEIC_JPEG_QUALITY = Math.min(1, Math.max(0.5, envNumber(process.env.HEIC_JPEG_QUALITY, 0.95)));

function looksLikeHeic(buffer, mime, originalname) {
  if (/^image\/(heic|heif|heic-sequence|heif-sequence)$/i.test(String(mime || ''))) return true;
  if (/\.(heic|heif)$/i.test(String(originalname || ''))) return true;
  // ISO-BMFF 魔数：字节 4..8 为 'ftyp'，8..12 为品牌（heic/heix/hevc/mif1/msf1…）
  if (buffer && buffer.length > 12 && buffer.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buffer.toString('ascii', 8, 12).toLowerCase();
    if (/^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(brand)) return true;
  }
  return false;
}

// TIFF：浏览器 <img> 显示不了，但 sharp/libvips 能读——与 HEIC 一样先转成 JPEG 再走后续管线。
function looksLikeTiff(buffer, mime, originalname) {
  if (/^image\/tiff$/i.test(String(mime || ''))) return true;
  if (/\.(tif|tiff)$/i.test(String(originalname || ''))) return true;
  // TIFF 魔数：'II' + 0x2A00（小端）或 'MM' + 0x002A（大端）
  if (buffer && buffer.length > 4) {
    const b = buffer;
    if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return true;
    if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return true;
  }
  return false;
}

// 各厂 RAW（dng/cr2/nef/arw/raf/orf/rw2/…）：sharp/libvips 解不了传感器原始数据，但绝大多数 RAW 文件都内嵌
// 一张相机现拍的 JPEG 预览（常为全尺寸）。零依赖做法：扫描文件里所有 JPEG 段（FF D8 FF <marker>），交给 sharp
// 验证尺寸、取面积最大的那张干净重编码。覆盖 DNG/CR2/CR3/NEF/ARW/RAF/ORF/RW2/PEF/… 常见机型。
const RAW_EXTS = new Set(['.dng', '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.sr2', '.srf', '.raf',
  '.orf', '.rw2', '.raw', '.pef', '.srw', '.x3f', '.rwl', '.3fr', '.fff', '.iiq', '.mrw', '.dcr', '.kdc', '.mos', '.erf']);
function looksLikeRaw(mime, originalname) {
  const ext = path.extname(String(originalname || '')).toLowerCase();
  if (RAW_EXTS.has(ext)) return true;
  return /^image\/x-(adobe-dng|canon|nikon|sony|fuji|olympus|panasonic|pentax|samsung|sigma|leica|hasselblad|phaseone|minolta|kodak|leaf|epson)/i.test(String(mime || ''));
}
async function extractLargestEmbeddedJpeg(buffer) {
  if (!buffer || buffer.length < 8) return null;
  // 收集 JPEG 起点：FF D8 FF <合法段标记>（DB 量化表 / E0-EF 应用段），过滤传感器数据里的随机 FFD8FF
  const sois = [];
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === 0xff && buffer[i + 1] === 0xd8 && buffer[i + 2] === 0xff) {
      const m = buffer[i + 3];
      if (m === 0xdb || (m >= 0xe0 && m <= 0xef) || m === 0xc0 || m === 0xc4) sois.push(i);
      if (sois.length >= 64) break; // 兜底封顶，别在超大文件上试太多次
    }
  }
  let best = null; let bestArea = 0;
  for (const soi of sois) {
    const slice = buffer.subarray(soi);
    try {
      const meta = await sharp(slice, { failOn: 'none' }).metadata();
      const area = (meta.width || 0) * (meta.height || 0);
      if (meta.format === 'jpeg' && area > bestArea) { bestArea = area; best = slice; }
    } catch (e) { /* 该起点不是有效 JPEG，跳过 */ }
  }
  if (!best) return null;
  // 干净重编码（去掉 EOI 之后的 RAW 尾料，统一走 rotate 摆正）
  return sharp(best, { failOn: 'none' }).rotate().jpeg({ quality: 92, mozjpeg: true }).toBuffer();
}

// 把浏览器显示不了的图片格式就地转成 JPEG（buffer/mime/扩展名一并改）。HEIC 走 heic-convert（自带 HEVC
// 解码，sharp 缺）；RAW 抽内嵌 JPEG 预览；TIFF 走 sharp。返回是否转码过。命中不了（jpg/png/webp/gif/avif
// 等可直显/可直存）返回 false。RAW 必须在 TIFF 之前判——DNG 也是 TIFF 魔数打头，会被 looksLikeTiff 误命中。
async function maybeTranscodeToJpeg(file) {
  if (!file || !file.buffer) return false;
  if (looksLikeHeic(file.buffer, file.mimetype, file.originalname)) {
    const convert = require('heic-convert');
    const jpeg = await convert({ buffer: file.buffer, format: 'JPEG', quality: HEIC_JPEG_QUALITY });
    file.buffer = Buffer.isBuffer(jpeg) ? jpeg : Buffer.from(jpeg);
    file.mimetype = 'image/jpeg';
    file.originalname = `${String(file.originalname || 'photo').replace(/\.(heic|heif)$/i, '')}.jpg`;
    return true;
  }
  if (looksLikeRaw(file.mimetype, file.originalname)) {
    const jpeg = await extractLargestEmbeddedJpeg(file.buffer);
    if (!jpeg) { const err = new Error('RAW_NO_EMBEDDED_JPEG'); err.rawNoPreview = true; throw err; }
    file.buffer = jpeg;
    file.mimetype = 'image/jpeg';
    file.originalname = `${String(file.originalname || 'photo').replace(/\.[a-z0-9]+$/i, '')}.jpg`;
    return true;
  }
  if (looksLikeTiff(file.buffer, file.mimetype, file.originalname)) {
    const jpeg = await sharp(file.buffer, { failOn: 'none' }).rotate().jpeg({ quality: 95, mozjpeg: true }).toBuffer();
    file.buffer = jpeg;
    file.mimetype = 'image/jpeg';
    file.originalname = `${String(file.originalname || 'photo').replace(/\.(tif|tiff)$/i, '')}.jpg`;
    return true;
  }
  return false;
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

function enqueueVideoSemanticAnalysis({ insertedId, thumbRel }) {
  if (!insertedId || !thumbRel) return false;
  try {
    const aiWorker = require('../lib/ai_tags_worker');
    // 视频语义只看转码生成的封面帧，并放到低优先级队列；照片、人脸等常规任务优先。
    aiWorker.enqueue({ id: insertedId, relPath: thumbRel, isVideo: true, priority: 'low' });
    return true;
  } catch (err) {
    console.error('[upload.video] enqueue semantic analysis failed:', err && err.message ? err.message : err);
    return false;
  }
}

async function enableVideoSemanticAnalysis({ insertedId, thumbRel }) {
  if (!insertedId || !thumbRel) return false;
  try {
    const [result] = await pool.query(
      `UPDATE photos
       SET ai_status = 'pending', ai_error = NULL, ai_started_at = NULL, ai_finished_at = NULL
       WHERE id = ? AND type = 'video'`,
      [insertedId]
    );
    if (!result || !result.affectedRows) return false;
    return enqueueVideoSemanticAnalysis({ insertedId, thumbRel });
  } catch (err) {
    console.error('[upload.video] enable semantic analysis failed:', insertedId, err && err.message ? err.message : err);
    return false;
  }
}

function makeResponsePayload({ insertedId, projectId, timelineSectionId, relPath, thumbRel, playbackRel, playbackQueued, title, type, mediaType, aiStatus, photographerId, photographerName }) {
  const isVideo = type === 'video' || mediaType === 'video';
  const resolvedAiStatus = aiStatus || (isVideo ? 'skipped' : 'pending');
  // 只有真正排了转码任务才报 transcoding，否则（如 VIDEO_PLAYBACK_ENABLED=0）前端会白等占位
  const processingStatus = isVideo && !playbackRel && playbackQueued ? 'transcoding' : null;
  return {
    id: insertedId,
    projectId: projectId || null,
    timelineSectionId: timelineSectionId || null,
    url: buildUploadUrl(relPath),
    thumbUrl: thumbRel ? buildUploadUrl(thumbRel) : null,
    playbackUrl: playbackRel ? buildUploadUrl(playbackRel) : null,
    playback_url: playbackRel ? buildUploadUrl(playbackRel) : null,
    fullUrl: buildUploadUrl(relPath),
    fullThumbUrl: thumbRel ? buildUploadUrl(thumbRel) : null,
    title,
    type,
    mediaType: mediaType || (isVideo ? 'video' : 'image'),
    media_type: mediaType || (isVideo ? 'video' : 'image'),
    processingStatus,
    processing_status: processingStatus,
    aiStatus: resolvedAiStatus,
    ai_status: resolvedAiStatus,
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

function handleVideoUploadMiddleware(req, res, next) {
  videoUpload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'VIDEO_FILE_TOO_LARGE', maxFileBytes: MAX_VIDEO_UPLOAD_BYTES });
      }
      return res.status(400).json({ error: err.code || 'VIDEO_UPLOAD_REJECTED' });
    }
    return res.status(err.status || 400).json({ error: err.message || 'VIDEO_UPLOAD_REJECTED' });
  });
}

async function processUpload(req, res) {
  let uploadedKeys = [];
  const timings = {};
  const startMs = nowMs();
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

    // 浏览器显示不了的图片格式(HEIC/HEIF/TIFF) → 高质量 JPEG。失败给明确错误，不让后续 sharp 撞墙。
    try {
      const heicStartMs = nowMs();
      if (await maybeTranscodeToJpeg(req.file)) timings.heicMs = nowMs() - heicStartMs;
    } catch (err) {
      console.error('[upload] 图片转码失败:', err && err.message ? err.message : err);
      if (err && err.rawNoPreview) {
        return res.status(422).json({ error: 'RAW_NO_PREVIEW', message: '这张 RAW 里没有可提取的内嵌预览图，请用相机导出的 JPG 版本' });
      }
      return res.status(422).json({ error: 'IMAGE_DECODE_FAILED', message: '图片解码失败，请换 JPG/PNG 重试' });
    }

    const metadata = readPhotoMetadata(req.body || {});
    const photographerId = req.user && req.user.id ? req.user.id : null;
    const orgId = getOrgId(req);
    await ensureProjectInScope(pool, metadata.projectId, orgId);
    await ensureTimelineSectionInProject(pool, metadata.projectId, orgId, metadata.timelineSectionId);
    timings.scopeMs = nowMs() - startMs;

    const mimeType = inferImageMime(req.file.mimetype, req.file.originalname);
    const { originalKey, thumbKey, relPath, thumbRel } = buildObjectKeys(metadata.projectId, req.file.originalname, mimeType);

    let thumbBuffer = null;
    try {
      const storageStartMs = nowMs();
      const originalUploadPromise = cosStorage.uploadBuffer(originalKey, req.file.buffer, {
        contentType: mimeType,
        cacheControl: UPLOAD_CACHE_CONTROL,
      }).then((result) => {
        uploadedKeys.push(originalKey);
        return result;
      });

      const thumbUploadPromise = createThumbBuffer(req.file.buffer)
        .then((buffer) => {
          thumbBuffer = buffer;
          timings.thumbBytes = buffer.length;
          return cosStorage.uploadBuffer(thumbKey, buffer, {
            contentType: 'image/jpeg',
            cacheControl: UPLOAD_CACHE_CONTROL,
          });
        })
        .then((result) => {
          uploadedKeys.push(thumbKey);
          return result;
        });

      await Promise.all([originalUploadPromise, thumbUploadPromise]);
      timings.storageMs = nowMs() - storageStartMs;
    } catch (err) {
      await cosStorage.deleteObjects(uploadedKeys).catch(() => null);
      console.error('[upload] upload to COS failed:', err && err.message ? err.message : err);
      return res.status(502).json({ error: 'COS_UPLOAD_FAILED', message: String(err && err.message ? err.message : err) });
    }

    let insertedId;
    try {
      const dbStartMs = nowMs();
      insertedId = await createPhotoRecordWithRetry({
        ...metadata,
        relPath,
        thumbRel,
        photographerId,
        orgId,
      });
      timings.dbMs = nowMs() - dbStartMs;
    } catch (err) {
      await cosStorage.deleteObjects([originalKey, thumbKey]).catch(() => null);
      const status = err.status || 500;
      const message = err.publicMessage || err.message || 'DB_INSERT_FAILED';
      console.error('[upload] DB insert failed, cleaned COS objects:', message);
      return res.status(status).json({ error: status === 404 ? 'PROJECT_NOT_FOUND' : 'DB_INSERT_FAILED', message });
    }

    const photographerName = await getPhotographerName(photographerId);
    enqueuePostUploadJobs({ insertedId, thumbRel, thumbBuffer, photographerId });
    setImmediate(() => {
      appendPhotoIdToProjectBestEffort(metadata.projectId, insertedId).catch((err) => {
        console.warn('[upload] project photo_ids async sync failed:', err && err.message ? err.message : err);
      });
    });

    if (UPLOAD_TIMING_LOGS) {
      console.log('[upload] timing', {
        photoId: insertedId,
        projectId: metadata.projectId || null,
        originalBytes: req.file.size,
        thumbBytes: timings.thumbBytes || 0,
        scopeMs: timings.scopeMs,
        storageMs: timings.storageMs,
        dbMs: timings.dbMs,
        totalMs: nowMs() - startMs,
      });
    }

    return res.json(makeResponsePayload({
      insertedId,
      projectId: metadata.projectId,
      timelineSectionId: metadata.timelineSectionId,
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

async function processVideoUpload(req, res) {
  let uploadedKeys = [];
  const startMs = nowMs();
  const filePath = req.file && req.file.path ? req.file.path : null;
  let processedVideo = null;
  let posterImage = null;
  let playbackJobScheduled = false;
  try {
    if (!req.file || !filePath) {
      return res.status(400).json({ error: 'No video uploaded' });
    }
    if (!cosStorage.isConfigured()) {
      return res.status(503).json({
        error: 'COS_NOT_CONFIGURED',
        message: 'Server is not configured to upload to object storage. Configure COS_SECRET_ID/COS_SECRET_KEY/COS_BUCKET/COS_REGION.',
      });
    }

    const metadata = readPhotoMetadata(req.body || {});
    metadata.type = 'video';
    const photographerId = req.user && req.user.id ? req.user.id : null;
    const orgId = getOrgId(req);
    await ensureProjectInScope(pool, metadata.projectId, orgId);
    await ensureTimelineSectionInProject(pool, metadata.projectId, orgId, metadata.timelineSectionId);

    const mimeType = inferVideoMime(req.file.mimetype, req.file.originalname);
    if (!mimeType) return res.status(415).json({ error: 'UNSUPPORTED_VIDEO_TYPE' });
    // 磁盘防线：faststart 产物 + playback 转码产物最多再占约 2 倍原件大小
    const freeBytes = await tmpDirFreeBytes();
    const requiredBytes = Math.max(req.file.size * 2, VIDEO_TMP_MIN_FREE_BYTES);
    if (freeBytes !== null && freeBytes < requiredBytes) {
      console.error('[upload.video] insufficient disk space:', { freeBytes, requiredBytes });
      return res.status(507).json({ error: 'INSUFFICIENT_STORAGE', message: 'Server disk space low, try later' });
    }

    const { originalKey, thumbKey, playbackKey, relPath, thumbRel, playbackRel } = buildObjectKeys(metadata.projectId, req.file.originalname, mimeType, 'video');
    processedVideo = await prepareVideoForStreaming(filePath, mimeType);
    const uploadFilePath = processedVideo.filePath || filePath;
    const uploadSize = processedVideo.size || req.file.size;
    posterImage = await createVideoPosterForPreview(uploadFilePath);
    const playbackThumbRel = posterImage && thumbKey ? thumbRel : null;
    const webPlaybackRel = null;

    try {
      await cosStorage.uploadFile(originalKey, uploadFilePath, {
        contentType: mimeType,
        contentLength: uploadSize,
        cacheControl: UPLOAD_CACHE_CONTROL,
      });
      uploadedKeys.push(originalKey);
      if (posterImage && thumbKey) {
        await cosStorage.uploadFile(thumbKey, posterImage.filePath, {
          contentType: 'image/jpeg',
          contentLength: posterImage.size,
          cacheControl: UPLOAD_CACHE_CONTROL,
        });
        uploadedKeys.push(thumbKey);
      }
    } catch (err) {
      await cosStorage.deleteObjects(uploadedKeys).catch(() => null);
      console.error('[upload.video] upload to COS failed:', err && err.message ? err.message : err);
      return res.status(502).json({ error: 'COS_UPLOAD_FAILED', message: String(err && err.message ? err.message : err) });
    }

    let insertedId;
    try {
      insertedId = await createPhotoRecordWithRetry({
        ...metadata,
        relPath,
        thumbRel: playbackThumbRel,
        playbackRel: webPlaybackRel,
        aiStatus: playbackThumbRel ? 'pending' : 'skipped',
        photographerId,
        orgId,
      });
    } catch (err) {
      await cosStorage.deleteObjects(uploadedKeys).catch(() => null);
      const status = err.status || 500;
      const message = err.publicMessage || err.message || 'DB_INSERT_FAILED';
      console.error('[upload.video] DB insert failed, cleaned COS object:', message);
      return res.status(status).json({ error: status === 404 ? 'PROJECT_NOT_FOUND' : 'DB_INSERT_FAILED', message });
    }

    setImmediate(() => {
      appendPhotoIdToProjectBestEffort(metadata.projectId, insertedId).catch((err) => {
        console.warn('[upload.video] project photo_ids async sync failed:', err && err.message ? err.message : err);
      });
    });

    const photographerName = await getPhotographerName(photographerId);
    if (playbackThumbRel) {
      enqueueVideoSemanticAnalysis({ insertedId, thumbRel: playbackThumbRel });
    }
    playbackJobScheduled = enqueueVideoPlaybackTranscode({
      sourceFilePath: uploadFilePath,
      cleanupPaths: [filePath, processedVideo && processedVideo.cleanupPath],
      playbackKey,
      playbackRel,
      insertedId,
    });

    if (UPLOAD_TIMING_LOGS) {
      console.log('[upload.video] timing', {
        mediaId: insertedId,
        projectId: metadata.projectId || null,
        bytes: uploadSize,
        fastStarted: !!(processedVideo && processedVideo.fastStarted),
        posterBytes: posterImage ? posterImage.size : 0,
        playbackQueued: playbackJobScheduled,
        totalMs: nowMs() - startMs,
      });
    }

    return res.json(makeResponsePayload({
      insertedId,
      projectId: metadata.projectId,
      timelineSectionId: metadata.timelineSectionId,
      relPath,
      thumbRel: playbackThumbRel,
      playbackRel: webPlaybackRel,
      playbackQueued: playbackJobScheduled,
      title: metadata.title,
      type: 'video',
      mediaType: 'video',
      aiStatus: playbackThumbRel ? 'pending' : 'skipped',
      photographerId,
      photographerName,
    }));
  } catch (err) {
    await cosStorage.deleteObjects(uploadedKeys).catch(() => null);
    console.error('POST /api/upload/video error:', err && err.stack ? err.stack : err);
    return res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
  } finally {
    if (posterImage && posterImage.filePath) {
      unlinkFileQuiet(posterImage.filePath);
    }
    if (!playbackJobScheduled) {
      if (processedVideo && processedVideo.cleanupPath && processedVideo.cleanupPath !== filePath) {
        unlinkFileQuiet(processedVideo.cleanupPath);
      }
      if (filePath) {
        unlinkFileQuiet(filePath);
      }
    }
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
    await ensureTimelineSectionInProject(pool, metadata.projectId, orgId, metadata.timelineSectionId);

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
    const [original, thumb] = await Promise.all([
      cosStorage.signedPost(originalKey, { expires: SIGNED_UPLOAD_EXPIRES_SECONDS, contentType: mimeType, cacheControl: UPLOAD_CACHE_CONTROL, maxBytes: fileSize }),
      cosStorage.signedPost(thumbKey, { expires: SIGNED_UPLOAD_EXPIRES_SECONDS, contentType: 'image/jpeg', cacheControl: UPLOAD_CACHE_CONTROL, maxBytes: Math.max(1024 * 1024, Math.min(fileSize, 16 * 1024 * 1024)) }),
    ]);

    res.json({
      uploadMode: 'direct-cos',
      maxFileBytes: MAX_UPLOAD_BYTES,
      expiresIn: SIGNED_UPLOAD_EXPIRES_SECONDS,
      original: {
        key: original.key,
        uploadUrl: original.postUrl,
        url: original.publicUrl,
        relPath,
        formFields: original.fields,
      },
      thumb: {
        key: thumb.key,
        uploadUrl: thumb.postUrl,
        url: thumb.publicUrl,
        relPath: thumbRel,
        formFields: thumb.fields,
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
      insertedId = await createPhotoRecordWithRetry({
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
    setImmediate(() => {
      appendPhotoIdToProjectBestEffort(metadata.projectId, insertedId).catch((err) => {
        console.warn('[upload] project photo_ids async sync failed:', err && err.message ? err.message : err);
      });
    });

    res.json(makeResponsePayload({
      insertedId,
      projectId: metadata.projectId,
      timelineSectionId: metadata.timelineSectionId,
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

// 视频直传：浏览器只持有短时分片 PUT URL，访问密钥始终留在 Mac Mini。
router.post('/video/direct/init', requirePermission('upload.photo'), async (req, res) => {
  try {
    if (!cosStorage.isConfigured()) return res.status(503).json({ error: 'COS_NOT_CONFIGURED' });
    const unavailable = getDirectUploadUnavailableReason();
    if (unavailable) return res.status(409).json({ error: 'DIRECT_UPLOAD_UNAVAILABLE', reason: unavailable, fallback: 'api-upload' });

    const metadata = readPhotoMetadata(req.body || {});
    metadata.type = 'video';
    const orgId = getOrgId(req);
    await ensureProjectInScope(pool, metadata.projectId, orgId);
    await ensureTimelineSectionInProject(pool, metadata.projectId, orgId, metadata.timelineSectionId);
    const fileName = trimText(req.body && req.body.fileName, 255) || 'video.mp4';
    const fileSize = Number(req.body && req.body.fileSize);
    const mimeType = inferVideoMime(req.body && req.body.mimeType, fileName);
    if (!mimeType) return res.status(415).json({ error: 'UNSUPPORTED_VIDEO_TYPE' });
    if (!Number.isFinite(fileSize) || fileSize <= 0) return res.status(400).json({ error: 'INVALID_FILE_SIZE' });
    if (fileSize > MAX_VIDEO_UPLOAD_BYTES) return res.status(413).json({ error: 'VIDEO_FILE_TOO_LARGE', maxFileBytes: MAX_VIDEO_UPLOAD_BYTES });

    const { originalKey, thumbKey, playbackKey, relPath, thumbRel, playbackRel } = buildObjectKeys(metadata.projectId, fileName, mimeType, 'video');
    // 该对象存储网关会错误拒绝跨域 PUT 的 OPTIONS 预检；采用标准 S3 presigned POST，
    // 浏览器可直接提交 FormData 到存储，不经过 Mac Mini，也不会触发 PUT 预检。
    const post = await cosStorage.signedPost(originalKey, {
      expires: SIGNED_UPLOAD_EXPIRES_SECONDS, contentType: mimeType, cacheControl: UPLOAD_CACHE_CONTROL, maxBytes: fileSize,
    });
    const sessionId = uuidv4();
    directVideoUploads.set(sessionId, {
      id: sessionId, userId: req.user.id, orgId, metadata, fileName, fileSize, mimeType,
      originalKey, thumbKey, playbackKey, relPath, thumbRel, playbackRel,
      storageUploadId: null, partCount: 1, createdAt: Date.now(), expiresAt: Date.now() + DIRECT_VIDEO_SESSION_TTL_MS,
      status: 'uploading',
    });
    scheduleDirectVideoCleanup();
    return res.json({ uploadMode: 'direct-video-post', sessionId, expiresIn: SIGNED_UPLOAD_EXPIRES_SECONDS, upload: { uploadUrl: post.postUrl, formFields: post.fields } });
  } catch (err) {
    console.error('POST /api/upload/video/direct/init error:', err && err.stack ? err.stack : err);
    return res.status(err.status || 500).json({ error: err.message || 'DIRECT_VIDEO_INIT_FAILED' });
  }
});

router.post('/video/direct/parts', requirePermission('upload.photo'), async (req, res) => {
  try {
    const session = getDirectVideoSession(req, req.body && req.body.sessionId);
    if (!session || session.status !== 'uploading') return res.status(404).json({ error: 'DIRECT_VIDEO_SESSION_NOT_FOUND' });
    const requested = Array.from(new Set(Array.isArray(req.body && req.body.partNumbers) ? req.body.partNumbers.map(Number) : []))
      .filter((partNumber) => Number.isInteger(partNumber) && partNumber >= 1 && partNumber <= session.partCount)
      .slice(0, DIRECT_VIDEO_PART_URL_BATCH);
    if (!requested.length) return res.status(400).json({ error: 'INVALID_PART_NUMBERS' });
    const parts = await Promise.all(requested.map(async (partNumber) => {
      const signed = await cosStorage.signedUploadPartUrl(session.originalKey, session.storageUploadId, partNumber, { expires: SIGNED_UPLOAD_EXPIRES_SECONDS });
      return { partNumber, uploadUrl: signed.signedUrl, expiresIn: signed.expiresIn };
    }));
    return res.json({ sessionId: session.id, parts });
  } catch (err) {
    console.error('POST /api/upload/video/direct/parts error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ error: 'DIRECT_VIDEO_PART_URL_FAILED' });
  }
});

router.post('/video/direct/complete', requirePermission('upload.photo'), async (req, res) => {
  let session = null;
  try {
    session = getDirectVideoSession(req, req.body && req.body.sessionId);
    if (!session || session.status !== 'uploading') return res.status(404).json({ error: 'DIRECT_VIDEO_SESSION_NOT_FOUND' });
    session.status = 'completing';
    const head = await cosStorage.headObject(session.originalKey);
    if (!head || Number(head.ContentLength) !== Number(session.fileSize)) throw new Error('DIRECT_VIDEO_SIZE_MISMATCH');

    const photographerId = req.user && req.user.id ? req.user.id : null;
    let insertedId;
    try {
      insertedId = await createPhotoRecordWithRetry({
        ...session.metadata, relPath: session.relPath, thumbRel: null, playbackRel: null, aiStatus: 'skipped', photographerId, orgId: session.orgId,
      });
    } catch (dbErr) {
      await cosStorage.deleteObjects([session.originalKey]).catch(() => null);
      throw dbErr;
    }
    directVideoUploads.delete(session.id);
    setImmediate(() => appendPhotoIdToProjectBestEffort(session.metadata.projectId, insertedId).catch((err) => console.warn('[upload.video] project photo_ids async sync failed:', err && err.message ? err.message : err)));
    const photographerName = await getPhotographerName(photographerId);
    const playbackQueued = enqueueDirectVideoPostProcess({
      sourceKey: session.originalKey, mimeType: session.mimeType, thumbKey: session.thumbKey, thumbRel: session.thumbRel,
      playbackKey: session.playbackKey, playbackRel: session.playbackRel, insertedId,
    });
    return res.json(makeResponsePayload({
      insertedId, projectId: session.metadata.projectId, timelineSectionId: session.metadata.timelineSectionId,
      relPath: session.relPath, thumbRel: null, playbackRel: null, playbackQueued,
      title: session.metadata.title, type: 'video', mediaType: 'video', aiStatus: 'skipped', photographerId, photographerName,
    }));
  } catch (err) {
    if (session) {
      directVideoUploads.delete(session.id);
      if (session.storageUploadId) await cosStorage.abortMultipartUpload(session.originalKey, session.storageUploadId).catch(() => null);
      else await cosStorage.deleteObjects([session.originalKey]).catch(() => null);
    }
    console.error('POST /api/upload/video/direct/complete error:', err && err.stack ? err.stack : err);
    return res.status(err.status || 500).json({ error: err.message || 'DIRECT_VIDEO_COMPLETE_FAILED' });
  }
});

router.post('/video/direct/abort', requirePermission('upload.photo'), async (req, res) => {
  const session = getDirectVideoSession(req, req.body && req.body.sessionId);
  if (!session) return res.json({ ok: true });
  directVideoUploads.delete(session.id);
  if (session.storageUploadId) await cosStorage.abortMultipartUpload(session.originalKey, session.storageUploadId).catch(() => null);
  else await cosStorage.deleteObjects([session.originalKey]).catch(() => null);
  return res.json({ ok: true });
});

router.post('/photo', requirePermission('upload.photo'), handleUploadMiddleware, processUpload);
router.post('/video', requirePermission('upload.photo'), handleVideoUploadMiddleware, processVideoUpload);

router.upload = upload;
router.processUpload = processUpload;
router.processVideoUpload = processVideoUpload;
router.createPhotoRecordWithRetry = createPhotoRecordWithRetry;
router.appendPhotoIdToProjectBestEffort = appendPhotoIdToProjectBestEffort;

module.exports = router;
