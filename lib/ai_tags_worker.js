const { analyze, headRequest } = require('../ai_function/ai_for_tags/ai_for_tags');
const { pool, buildUploadUrl } = require('../db');

const CONCURRENCY = 1; // 串行处理，避免并发调用耗尽配额
let queue = [];
let running = 0;

async function _processOne(item) {
  if (!item || !item.id) return;

  try {
    // item.relPath 通常是 '/uploads/...'（缩略图），构建成可访问的 URL
    const imageUrl = item.relPath ? buildUploadUrl(item.relPath) : null;

    if (!imageUrl) {
      console.warn('[ai_tags_worker] no imageUrl for', item.id);
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
      return;
    }

    // 调用分析函数
    let result = null;
    try {
      result = await analyze(imageUrl);
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
      return; // 不继续处理
    }

    if (result) {
      const description = result.description || null;
      const tags = (result.tags && result.tags.length) ? JSON.stringify(result.tags) : null;

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
          `UPDATE photos SET description = COALESCE(?, description), tags = COALESCE(?, tags) WHERE id = ?`,
          [description, tags, item.id]
        );
        console.log('[ai_tags_worker] updated photo', item.id);
      } catch (dbErr) {
        console.error('[ai_tags_worker] DB update failed for', item.id, dbErr && dbErr.message ? dbErr.message : dbErr);
      }
    }
  } catch (err) {
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
      // 下一个
      setImmediate(_drain);
    });
}

function enqueue(item) {
  if (!item || !item.id) return;
  queue.push(item);
  setImmediate(_drain);
}

function queueLength() {
  return queue.length + running;
}

module.exports = { enqueue, queueLength };

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
