// Generate web playback renditions (and optionally JPEG posters) for existing video records.
//
// Usage:
//   node scripts/backfill_video_playback.js --limit=20
//   node scripts/backfill_video_playback.js --photoId=1760 --force
//   node scripts/backfill_video_playback.js --poster            # also fill missing thumb_url posters

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { pipeline } = require('stream/promises');
const { pool } = require('../db');
const cosStorage = require('../lib/cos_storage');

const execFileAsync = promisify(execFile);

const TMP_DIR = process.env.UPLOAD_VIDEO_TMP_DIR || path.join(os.tmpdir(), 'mamage-video-uploads');
const FFMPEG_PATH = process.env.FFMPEG_PATH || (fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : 'ffmpeg');
const PLAYBACK_MAX_WIDTH = Math.max(640, Number(process.env.VIDEO_PLAYBACK_MAX_WIDTH || 1280));
const PLAYBACK_CRF = Math.min(32, Math.max(20, Number(process.env.VIDEO_PLAYBACK_CRF || 27)));
const PLAYBACK_MAXRATE = process.env.VIDEO_PLAYBACK_MAXRATE || '2800k';
const PLAYBACK_BUFSIZE = process.env.VIDEO_PLAYBACK_BUFSIZE || '5600k';
const PLAYBACK_TIMEOUT_MS = Math.max(30000, Number(process.env.VIDEO_PLAYBACK_TIMEOUT_MS || 900000));
const UPLOAD_CACHE_CONTROL = process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable';
const POSTER_MAX_WIDTH = Math.max(360, Number(process.env.VIDEO_PREVIEW_MAX_WIDTH || 1280));
const POSTER_TIMEOUT_MS = Math.max(10000, Number(process.env.VIDEO_PREVIEW_TIMEOUT_MS || 180000));
const POSTER_CAPTURE_SECONDS = Math.max(0, Number(process.env.VIDEO_POSTER_CAPTURE_SECONDS || 1));

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function buildPlaybackPath(originalUrl) {
  const key = cosStorage.keyFromUrlOrPath(originalUrl);
  if (!key) return null;
  const ext = path.extname(key) || '.mp4';
  const dir = path.dirname(key).replace(/\\/g, '/');
  const base = path.basename(key, ext);
  return `/${dir}/playback/playback_${base}.mp4`;
}

// 与 routes/upload.js buildObjectKeys 的视频 thumbKey 规则一致
function buildPosterPath(originalUrl) {
  const key = cosStorage.keyFromUrlOrPath(originalUrl);
  if (!key) return null;
  const ext = path.extname(key) || '.mp4';
  const dir = path.dirname(key).replace(/\\/g, '/');
  const base = path.basename(key, ext);
  return `/${dir}/previews/poster_${base}.jpg`;
}

async function ensureTmpDir() {
  await fs.promises.mkdir(TMP_DIR, { recursive: true });
}

async function downloadObjectToFile(sourceUrl, targetPath) {
  const object = await cosStorage.getObject(sourceUrl);
  if (!object || !object.Body || typeof object.Body.pipe !== 'function') {
    throw new Error('Storage object body is not a readable stream');
  }
  await pipeline(object.Body, fs.createWriteStream(targetPath));
}

async function transcodePlayback(inputPath, outputPath) {
  await execFileAsync(FFMPEG_PATH, [
    '-y',
    '-v', 'error',
    '-i', inputPath,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', `scale=trunc(min(${PLAYBACK_MAX_WIDTH}\\,iw)/2)*2:-2`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', String(PLAYBACK_CRF),
    '-maxrate', PLAYBACK_MAXRATE,
    '-bufsize', PLAYBACK_BUFSIZE,
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
    timeout: PLAYBACK_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
  const stat = await fs.promises.stat(outputPath);
  if (!stat.size) throw new Error('ffmpeg produced empty playback video');
  return stat.size;
}

async function selectRows() {
  const limit = positiveInt(argValue('limit', 20), 20);
  const photoId = argValue('photoId', null);
  const projectId = argValue('projectId', null);
  const force = hasFlag('force');
  const withPoster = hasFlag('poster');

  const where = ["type = 'video'", "url IS NOT NULL", "url <> ''"];
  const params = [];

  if (!force) {
    where.push(withPoster
      ? "((playback_url IS NULL OR playback_url = '') OR (thumb_url IS NULL OR thumb_url = ''))"
      : "(playback_url IS NULL OR playback_url = '')");
  }
  if (photoId) {
    where.push('id = ?');
    params.push(Number(photoId));
  }
  if (projectId) {
    where.push('project_id = ?');
    params.push(Number(projectId));
  }

  params.push(limit);
  const [rows] = await pool.query(
    `SELECT id, url, playback_url AS playbackUrl, thumb_url AS thumbUrl
     FROM photos
     WHERE ${where.join(' AND ')}
     ORDER BY id DESC
     LIMIT ?`,
    params
  );
  return rows || [];
}

async function capturePoster(inputPath, outputPath) {
  const buildArgs = (seekSeconds) => [
    '-y',
    '-v', 'error',
    ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
    '-i', inputPath,
    '-map', '0:v:0',
    '-frames:v', '1',
    '-vf', `scale=min(${POSTER_MAX_WIDTH}\\,iw):-2`,
    '-q:v', '3',
    outputPath,
  ];
  try {
    await execFileAsync(FFMPEG_PATH, buildArgs(POSTER_CAPTURE_SECONDS), { timeout: POSTER_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  } catch (err) {
    if (POSTER_CAPTURE_SECONDS <= 0) throw err;
    await execFileAsync(FFMPEG_PATH, buildArgs(0), { timeout: POSTER_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
  }
  const stat = await fs.promises.stat(outputPath);
  if (!stat.size) throw new Error('ffmpeg produced empty poster');
  return stat.size;
}

async function processRow(row) {
  const force = hasFlag('force');
  const withPoster = hasFlag('poster');
  const needsPlayback = force || !row.playbackUrl;
  const needsPoster = withPoster && (force || !row.thumbUrl);
  if (!needsPlayback && !needsPoster) return;

  const playbackRel = buildPlaybackPath(row.url);
  if (!playbackRel) throw new Error('Unable to build playback key');
  const playbackKey = cosStorage.keyFromUrlOrPath(playbackRel);
  const sourcePath = path.join(TMP_DIR, `backfill-${row.id}-${Date.now()}-source${path.extname(String(row.url || '')) || '.mp4'}`);
  const outputPath = path.join(TMP_DIR, `backfill-${row.id}-${Date.now()}-playback.mp4`);
  const posterPath = path.join(TMP_DIR, `backfill-${row.id}-${Date.now()}-poster.jpg`);

  try {
    console.log(`[video_playback] photo ${row.id}: download original`);
    await downloadObjectToFile(row.url, sourcePath);

    if (needsPoster) {
      // poster 失败不连坐 playback：各自独立成败
      try {
        const posterRel = buildPosterPath(row.url);
        const posterKey = cosStorage.keyFromUrlOrPath(posterRel);
        console.log(`[video_playback] photo ${row.id}: capture poster`);
        const posterBytes = await capturePoster(sourcePath, posterPath);
        await cosStorage.uploadFile(posterKey, posterPath, {
          contentType: 'image/jpeg',
          contentLength: posterBytes,
          cacheControl: UPLOAD_CACHE_CONTROL,
        });
        const [posterUpdate] = await pool.query(
          force
            ? 'UPDATE photos SET thumb_url = ? WHERE id = ?'
            : "UPDATE photos SET thumb_url = ? WHERE id = ? AND (thumb_url IS NULL OR thumb_url = '')",
          [posterRel, row.id]
        );
        if (!posterUpdate || !posterUpdate.affectedRows) {
          console.warn(`[video_playback] photo ${row.id}: poster update matched no row, deleting object`);
          await cosStorage.deleteObjects([posterKey]).catch(() => null);
        } else {
          console.log(`[video_playback] photo ${row.id}: poster ready ${posterRel}`);
        }
      } catch (posterErr) {
        console.error(`[video_playback] photo ${row.id}: poster failed:`, posterErr && posterErr.message ? posterErr.message : posterErr);
      }
    }

    if (needsPlayback) {
      console.log(`[video_playback] photo ${row.id}: transcode`);
      const playbackBytes = await transcodePlayback(sourcePath, outputPath);
      console.log(`[video_playback] photo ${row.id}: upload playback ${playbackBytes} bytes`);
      await cosStorage.uploadFile(playbackKey, outputPath, {
        contentType: 'video/mp4',
        contentLength: playbackBytes,
        cacheControl: UPLOAD_CACHE_CONTROL,
      });
      const [playbackUpdate] = await pool.query('UPDATE photos SET playback_url = ? WHERE id = ?', [playbackRel, row.id]);
      if (!playbackUpdate || !playbackUpdate.affectedRows) {
        console.warn(`[video_playback] photo ${row.id}: playback update matched no row, deleting object`);
        await cosStorage.deleteObjects([playbackKey]).catch(() => null);
      } else {
        console.log(`[video_playback] photo ${row.id}: ready ${playbackRel}`);
      }
    }
  } finally {
    await fs.promises.unlink(sourcePath).catch(() => null);
    await fs.promises.unlink(outputPath).catch(() => null);
    await fs.promises.unlink(posterPath).catch(() => null);
  }
}

async function main() {
  if (!cosStorage.isConfigured()) throw new Error('S3 client not configured');
  await ensureTmpDir();
  const rows = await selectRows();
  console.log(`[video_playback] found ${rows.length} video(s)`);

  let ok = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await processRow(row);
      ok += 1;
    } catch (err) {
      failed += 1;
      console.error(`[video_playback] photo ${row.id} failed:`, err && err.stack ? err.stack : err);
    }
  }

  console.log(`[video_playback] done ok=${ok} failed=${failed}`);
}

main()
  .catch((err) => {
    console.error('[video_playback] fatal:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch (e) {}
  });
