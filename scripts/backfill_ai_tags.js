// Re-run AI tagging for existing photos through the local vision model.
//
// Default selection: photos whose AI analysis never完成 (ai_status NULL /
// pending / running / failed). Use --force to re-tag everything (e.g. after
// switching vision models). Videos (ai_status='skipped') are always excluded.
//
// Usage:
//   node scripts/backfill_ai_tags.js                     # fix orphans only
//   node scripts/backfill_ai_tags.js --missing           # also re-tag 'done' rows that have no tags
//   node scripts/backfill_ai_tags.js --limit=50
//   node scripts/backfill_ai_tags.js --projectId=12
//   node scripts/backfill_ai_tags.js --force             # full historical re-tag
//   node scripts/backfill_ai_tags.js --ids=1758,1759
//   node scripts/backfill_ai_tags.js --rescore           # AI 选片 2.0：给已打标但无评分的照片补评分

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const { pool } = require('../db');
const worker = require('../lib/ai_tags_worker');

function argValue(name, fallback = null) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  if (!found) return fallback;
  return found.slice(prefix.length);
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function selectRows() {
  const force = hasFlag('force');
  const limitRaw = Number(argValue('limit', 0));
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 0;
  const projectId = argValue('projectId', null);
  const ids = String(argValue('ids', '') || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);

  const where = ["type <> 'video'", "(ai_status IS NULL OR ai_status <> 'skipped')"];
  const params = [];

  // 显式给出 --ids 即精确意图，不再叠加孤儿状态过滤
  if (!force && !ids.length) {
    if (hasFlag('rescore')) {
      // AI 选片 2.0 重评分：已完成打标但还没有综合分的历史照片
      where.push("(ai_score IS NULL AND ai_status = 'done')");
    } else {
      where.push(hasFlag('missing')
        // 孤儿 + 打过标但没产出标签的历史照片（旧模型/空结果）
        ? "(ai_status IS NULL OR ai_status IN ('pending', 'running', 'failed') OR tags IS NULL OR tags = '' OR tags = '[]')"
        : "(ai_status IS NULL OR ai_status IN ('pending', 'running', 'failed'))");
    }
  }
  if (projectId !== null) {
    const pid = Number(projectId);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error(`invalid --projectId: ${projectId}`);
    where.push('project_id = ?');
    params.push(pid);
  }
  if (ids.length) {
    where.push('id IN (?)');
    params.push(ids);
  }

  let sql = `SELECT id, thumb_url AS thumbRel, url, ai_status AS aiStatus
             FROM photos
             WHERE ${where.join(' AND ')}
             ORDER BY id DESC`;
  if (limit) {
    sql += ' LIMIT ?';
    params.push(limit);
  }
  const [rows] = await pool.query(sql, params);
  return rows || [];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 预检：媒体源走 /api/image 内网代理，服务进程没跑时 HEAD 全挂，
// 若不中止会把整批照片逐张刷成 failed 并冲掉原有 ai_error
async function preflightMediaSource(row) {
  const { buildInternalMediaUrl } = require('../db');
  const fetch = require('node-fetch');
  const url = buildInternalMediaUrl(row.thumbRel || row.url);
  try {
    const resp = await fetch(url, { method: 'HEAD', timeout: 10000 });
    if (resp.status >= 500) throw new Error(`HTTP ${resp.status}`);
  } catch (err) {
    throw new Error(`media source unreachable (${url}): ${err.message}. Is mamage-server running?`);
  }
}

async function main() {
  const rows = await selectRows();
  console.log(`[ai_tags_backfill] selected ${rows.length} photo(s)` + (hasFlag('force') ? ' (force mode)' : ''));
  if (!rows.length) return;

  await preflightMediaSource(rows[0]);

  rows.forEach((row) => worker.enqueue({ id: row.id, relPath: row.thumbRel || row.url }));

  const total = rows.length;
  const startedAt = Date.now();
  let lastLogged = -1;
  // worker 内部串行消费（CONCURRENCY=1），这里只等队列排空并打进度
  while (worker.queueLength() > 0) {
    const done = total - worker.queueLength();
    if (done !== lastLogged && (done % 10 === 0 || Date.now() - startedAt > 30000)) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      const rate = done > 0 ? (done / elapsed) : 0;
      const etaMin = rate > 0 ? Math.round((total - done) / rate / 60) : '?';
      console.log(`[ai_tags_backfill] progress ${done}/${total}, elapsed ${elapsed}s, eta ~${etaMin}min`);
      lastLogged = done;
    }
    await sleep(3000);
  }
  console.log(`[ai_tags_backfill] done ${total}/${total} in ${Math.round((Date.now() - startedAt) / 1000)}s`);
}

main()
  .catch((err) => {
    console.error('[ai_tags_backfill] fatal:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try { await pool.end(); } catch (e) {}
  });
