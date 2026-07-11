const { analyze, analyzePhoto, headRequest } = require('../ai_function/ai_for_tags/ai_for_tags');
const { pool, buildInternalMediaUrl } = require('../db');

const CONCURRENCY = 1; // 串行处理，避免并发调用耗尽配额
let queue = [];
let running = 0;
const queuedIds = new Set(); // 队列中 + 处理中的 photo id，防重复入队（上传路径与启动恢复可能同时命中）

async function updatePhotoAiStatus(photoId, status, options = {}) {
  if (!photoId || !status) return;
  const errorMessage = options.error ? String(options.error).slice(0, 255) : null;
  try {
    if (status === 'running') {
      await pool.query(
        `UPDATE photos
         SET ai_status = 'running',
             ai_error = NULL,
             ai_started_at = COALESCE(ai_started_at, NOW()),
             ai_finished_at = NULL
         WHERE id = ?`,
        [photoId]
      );
      return;
    }
    if (status === 'done') {
      await pool.query(
        `UPDATE photos
         SET ai_status = 'done',
             ai_error = NULL,
             ai_finished_at = NOW()
         WHERE id = ?`,
        [photoId]
      );
      return;
    }
    await pool.query(
      `UPDATE photos
       SET ai_status = ?,
           ai_error = ?,
           ai_finished_at = NOW()
       WHERE id = ?`,
      [status, errorMessage, photoId]
    );
  } catch (err) {
    if (err && (err.code === 'ER_BAD_FIELD_ERROR' || String(err.message || '').includes('Unknown column'))) {
      return;
    }
    console.warn('[ai_tags_worker] update ai status failed:', photoId, status, err && err.message ? err.message : err);
  }
}

async function _processOne(item) {
  if (!item || !item.id) return;

  try {
    await updatePhotoAiStatus(item.id, 'running');

    // AI 选片 2.0：优先用原图做分析（缩略图上测锐度不可靠）。
    // 不依赖调用方传原图路径——自己查库，调用方只需给 id。
    let originalRel = item.originalRel || null;
    let thumbRel = item.relPath || null;
    if (!originalRel || !thumbRel) {
      try {
        const [rows] = await pool.query('SELECT url, thumb_url FROM photos WHERE id = ?', [item.id]);
        if (rows && rows[0]) {
          if (!originalRel) originalRel = rows[0].url || rows[0].thumb_url;
          if (!thumbRel) thumbRel = rows[0].thumb_url || rows[0].url;
        }
      } catch (e) {
        console.warn('[ai_tags_worker] lookup photo row failed:', item.id, e && e.message ? e.message : e);
      }
    }

    const imageUrl = originalRel ? buildInternalMediaUrl(originalRel) : (thumbRel ? buildInternalMediaUrl(thumbRel) : null);
    const thumbUrl = thumbRel ? buildInternalMediaUrl(thumbRel) : null;

    if (!imageUrl) {
      console.warn('[ai_tags_worker] no imageUrl for', item.id);
      await updatePhotoAiStatus(item.id, 'failed', { error: 'image url missing' });
      return;
    }

    // 先做 HEAD 检查
    let head = null;
    try {
      head = await headRequest(imageUrl);
    } catch (he) {
      console.warn('[ai_tags_worker] headRequest failed for', imageUrl, he && he.message ? he.message : he);
    }

    const contentType = head && head.headers ? (head.headers['content-type'] || head.headers['Content-Type']) : null;
    if (!head || !contentType || !String(contentType).toLowerCase().startsWith('image')) {
      console.warn('[ai_tags_worker] skipping analyze: not an image or inaccessible', imageUrl, head && head.statusCode, contentType);
      await updatePhotoAiStatus(item.id, 'failed', { error: `image inaccessible ${head && head.statusCode ? head.statusCode : ''}`.trim() });
      return;
    }

    // 调用分析函数：评分管线失败时回退旧打标管线（缩略图），标签能力不随评分挂掉
    let result = null;
    try {
      result = await analyzePhoto(imageUrl);
    } catch (scoreErr) {
      console.warn('[ai_tags_worker] analyzePhoto failed, fallback to legacy analyze:', item.id, scoreErr && scoreErr.message ? scoreErr.message : scoreErr);
      try {
        result = await analyze(thumbUrl || imageUrl);
      } catch (aiErr) {
      // 不再假定有数据库表：直接在终端打印尽可能详细的 AI 错误信息，便于即时调试
      try {
        console.error('[ai_tags_worker] ai analyze threw for photoId=', item.id);
        console.error('  imageUrl=', imageUrl);
        if (aiErr && aiErr.message) console.error('  message=', aiErr.message);
        if (aiErr && aiErr.code) console.error('  code=', aiErr.code);
        if (aiErr && (aiErr.requestID || aiErr.requestId)) console.error('  requestId=', aiErr.requestID || aiErr.requestId);
        // 某些 SDK 会在 error.response 返回更多上下文
        if (aiErr && aiErr.response) {
          try {
            console.error('  response.status=', aiErr.response.status);
            console.error('  response.data=', JSON.stringify(aiErr.response.data).slice(0, 2000));
          } catch (e) {
            console.error('  response=', String(aiErr.response).slice(0, 2000));
          }
        }
        console.error('  stack=', aiErr && aiErr.stack ? aiErr.stack : 'no stack');
      } catch (logErr) {
        console.error('[ai_tags_worker] failed to print ai error for', item.id, logErr && logErr.message ? logErr.message : logErr);
      }
      await updatePhotoAiStatus(item.id, 'failed', { error: aiErr && aiErr.message ? aiErr.message : aiErr });
      return; // 不继续处理
      }
    }

    if (result) {
      const description = result.description || null;
      const tags = (result.tags && result.tags.length) ? JSON.stringify(result.tags) : null;
      const aiScore = Number.isFinite(result.score) ? Math.max(0, Math.min(100, Math.round(result.score))) : null;
      const aiQuality = result.quality ? JSON.stringify(result.quality) : null;
      const ocrText = typeof result.ocrText === 'string' && result.ocrText ? result.ocrText : null;

      // 如果模型返回了空结果（没有 description 且没有 tags），在终端打印详细信息以便排查
      if (!description && !tags) {
        try {
          console.warn('[ai_tags_worker] empty result from AI for photoId=', item.id, 'imageUrl=', imageUrl);
          console.warn('  raw response (truncated)=', result.raw ? String(result.raw).slice(0, 2000) : '<empty>');
        } catch (logErr) {
          console.error('[ai_tags_worker] failed to print empty result for', item.id, logErr && logErr.message ? logErr.message : logErr);
        }
      }

      try {
        await pool.query(
          `UPDATE photos
           SET description = COALESCE(?, description),
               tags = COALESCE(?, tags),
               ai_score = COALESCE(?, ai_score),
               ai_quality = COALESCE(?, ai_quality),
               ocr_text = COALESCE(?, ocr_text),
               ai_status = 'done',
               ai_error = NULL,
               ai_finished_at = NOW()
           WHERE id = ?`,
          [description, tags, aiScore, aiQuality, ocrText, item.id]
        );
        console.log('[ai_tags_worker] updated photo', item.id, aiScore !== null ? `score=${aiScore}` : '(no score)');
      } catch (dbErr) {
        if (dbErr && (dbErr.code === 'ER_BAD_FIELD_ERROR' || String(dbErr.message || '').includes('Unknown column'))) {
          try {
            await pool.query(
              `UPDATE photos SET description = COALESCE(?, description), tags = COALESCE(?, tags) WHERE id = ?`,
              [description, tags, item.id]
            );
            // 缺列降级也必须收尾 ai_status，否则照片停在 running 被 requeueStuckPhotos 永久循环重分析
            await updatePhotoAiStatus(item.id, 'done');
            console.warn('[ai_tags_worker] updated photo', item.id, 'WITHOUT ai_score/ai_quality — run migration 20260711_001_ai_quality.sql');
          } catch (fallbackErr) {
            console.error('[ai_tags_worker] DB update failed for', item.id, fallbackErr && fallbackErr.message ? fallbackErr.message : fallbackErr);
          }
        } else {
          await updatePhotoAiStatus(item.id, 'failed', { error: dbErr && dbErr.message ? dbErr.message : dbErr });
          console.error('[ai_tags_worker] DB update failed for', item.id, dbErr && dbErr.message ? dbErr.message : dbErr);
        }
      }
    } else {
      await updatePhotoAiStatus(item.id, 'done');
    }
  } catch (err) {
    await updatePhotoAiStatus(item.id, 'failed', { error: err && err.message ? err.message : err });
    console.error('[ai_tags_worker] analyze failed for', item.id, err && err.stack ? err.stack : err);
  }
}

function _drain() {
  if (running >= CONCURRENCY) return;
  const item = queue.shift();
  if (!item) return;
  running++;
  _processOne(item)
    .catch((e) => console.error('[ai_tags_worker] worker error', e && e.stack ? e.stack : e))
    .finally(() => {
      running--;
      queuedIds.delete(String(item.id));
      // 下一个
      setImmediate(_drain);
    });
}

function enqueue(item) {
  if (!item || !item.id) return;
  const key = String(item.id);
  if (queuedIds.has(key)) return; // 已在队列/处理中，跳过
  queuedIds.add(key);
  queue.push(item);
  setImmediate(_drain);
}

function queueLength() {
  return queue.length + running;
}

// 启动恢复：队列纯内存，进程重启会把 ai_status 留在 pending/running 且永不重试。
// 服务启动后扫描这类孤儿重新入队（串行消费，不会挤爆本地 Ollama）。
async function requeueStuckPhotos({ limit = 200 } = {}) {
  try {
    // 只捞"陈旧"孤儿：10 分钟内新建/开始的记录可能正被上传路径或
    // backfill 脚本（独立进程）处理，抢走会导致同一张照片双份分析
    const [rows] = await pool.query(
      `SELECT id, thumb_url AS thumbRel, url
       FROM photos
       WHERE type <> 'video'
         AND (
           (ai_status = 'running' AND (ai_started_at IS NULL OR ai_started_at < NOW() - INTERVAL 10 MINUTE))
           OR (ai_status = 'pending' AND created_at < NOW() - INTERVAL 10 MINUTE)
         )
       ORDER BY id DESC
       LIMIT ?`,
      [Math.max(1, Math.min(2000, Number(limit) || 200))]
    );
    for (const row of rows || []) {
      enqueue({ id: row.id, relPath: row.thumbRel || row.url });
    }
    if (rows && rows.length) {
      console.log(`[ai_tags_worker] requeued ${rows.length} stuck photo(s) after restart`);
    }
    return rows ? rows.length : 0;
  } catch (err) {
    console.warn('[ai_tags_worker] requeueStuckPhotos failed:', err && err.message ? err.message : err);
    return 0;
  }
}

module.exports = { enqueue, queueLength, requeueStuckPhotos };

// 确保用于记录 AI 错误的表存在（若不存在则创建）
async function ensureAiErrorTable() {
  // 表结构：id, photo_id, error_message, error_code, request_id, raw_response, created_at
  const createSql = `
    CREATE TABLE IF NOT EXISTS photo_ai_errors (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      photo_id BIGINT NOT NULL,
      error_message TEXT,
      error_code VARCHAR(255),
      request_id VARCHAR(255),
      raw_response LONGTEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX (photo_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `;

  try {
    await pool.query(createSql);
  } catch (e) {
    console.error('[ai_tags_worker] ensureAiErrorTable failed', e && e.message ? e.message : e);
  }
}
