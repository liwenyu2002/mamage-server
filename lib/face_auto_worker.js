const { detectAndClusterPhoto } = require('./face_auto_pipeline');

const queue = [];
const pendingPhotoIds = new Set();
let running = 0;
let bullQueue = null;
let bullWorker = null;

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const s = String(raw).trim().toLowerCase();
  return s === '1' || s === 'true' || s === 'yes' || s === 'y';
}

function getConcurrency() {
  const raw = Number(process.env.FACE_AUTO_WORKER_CONCURRENCY || 1);
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return Math.min(8, Math.floor(raw));
}

function initBullQueue() {
  if (bullQueue || bullWorker) return true;
  const redisUrl = String(process.env.REDIS_URL || '').trim();
  const shouldUseBull = envBool('FACE_AUTO_USE_BULLMQ', false) || !!redisUrl;
  if (!shouldUseBull || !redisUrl) return false;
  try {
    // Lazy-load so non-redis deployments keep working without extra deps.
    const { Queue, Worker } = require('bullmq');
    const IORedis = require('ioredis');
    const connection = new IORedis(redisUrl, {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    const queueName = process.env.FACE_AUTO_QUEUE_NAME || 'face-auto-jobs';

    bullQueue = new Queue(queueName, { connection });
    if (envBool('FACE_AUTO_WORKER_ENABLE', true)) {
      bullWorker = new Worker(
        queueName,
        async (job) => {
          const photoId = Number(job && job.data ? job.data.photoId : null);
          if (!Number.isFinite(photoId) || photoId <= 0) return;
          const res = await detectAndClusterPhoto({
            photoId,
            uploaderId: job && job.data ? (job.data.uploaderId || null) : null,
            force: true,
          });
          console.log('[face_auto_worker][bullmq] done', photoId, res);
          return res;
        },
        { connection, concurrency: getConcurrency() }
      );
      bullWorker.on('failed', (job, err) => {
        console.error('[face_auto_worker][bullmq] failed', job && job.id, err && err.stack ? err.stack : err);
      });
    }
    console.log('[face_auto_worker] bullmq mode enabled');
    return true;
  } catch (err) {
    console.warn('[face_auto_worker] bullmq init failed, fallback to memory queue:', err && err.message ? err.message : err);
    bullQueue = null;
    bullWorker = null;
    return false;
  }
}

function processNext() {
  const concurrency = getConcurrency();
  while (running < concurrency && queue.length > 0) {
    const job = queue.shift();
    running += 1;
    Promise.resolve()
      .then(async () => {
        const photoId = Number(job.photoId);
        if (!Number.isFinite(photoId) || photoId <= 0) return;
        const res = await detectAndClusterPhoto({
          photoId,
          uploaderId: job.uploaderId || null,
          force: true,
        });
        console.log('[face_auto_worker] done', photoId, res);
      })
      .catch((err) => {
        console.error('[face_auto_worker] failed', job && job.photoId, err && err.stack ? err.stack : err);
      })
      .finally(() => {
        running -= 1;
        pendingPhotoIds.delete(String(job.photoId));
        processNext();
      });
  }
}

function enqueueFaceAutoJob(job) {
  const photoId = Number(job && job.photoId);
  if (!Number.isFinite(photoId) || photoId <= 0) return false;

  if (initBullQueue() && bullQueue) {
    const payload = {
      photoId,
      uploaderId: job && job.uploaderId ? Number(job.uploaderId) : null,
    };
    bullQueue.add('detect-cluster', payload, {
      jobId: `photo-${photoId}`,
      removeOnComplete: { count: 1000 },
      removeOnFail: { count: 1000 },
    }).catch((err) => {
      // Dedupe conflict or transient redis errors should not crash upload flow.
      console.warn('[face_auto_worker][bullmq] enqueue failed:', err && err.message ? err.message : err);
    });
    return true;
  }

  const key = String(photoId);
  if (pendingPhotoIds.has(key)) return false;
  pendingPhotoIds.add(key);
  queue.push({
    photoId,
    uploaderId: job && job.uploaderId ? Number(job.uploaderId) : null,
  });
  processNext();
  return true;
}

function queueLength() {
  if (bullQueue) return -1;
  return queue.length + running;
}

module.exports = {
  enqueueFaceAutoJob,
  queueLength,
};
