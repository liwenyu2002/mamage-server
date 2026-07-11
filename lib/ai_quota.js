// AI 生成限流与配额。
// 约束：这是应用层限流（进程内内存态），不是分布式锁——当前部署是单进程 Node，够用；
// 若未来多实例部署，并发池需要换成基于 Redis 的实现，配额校验已经用 DB 事务兜底不受此限制。

const { pool } = require('../db');

// ---------------------------------------------------------------------------
// 全局并发池：文本模型调用是唯一需要限流的段落（避免同时打满第三方 API 速率限制）。
// 实现是最简单的计数信号量 + FIFO 等待队列；release() 时如果有等待者，直接把槽位"移交"
// 给下一个等待者而不是先减计数再重新抢，避免出现槽位瞬间被抢跑到限制外的竞态。
// ---------------------------------------------------------------------------
let activeCount = 0;
const waiters = [];

function getConcurrencyLimit() {
  const n = Number(process.env.AI_TEXT_CONCURRENCY);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 2;
}

function acquire() {
  return new Promise((resolve) => {
    if (activeCount < getConcurrencyLimit()) {
      activeCount += 1;
      resolve();
    } else {
      waiters.push(resolve);
    }
  });
}

function release() {
  const next = waiters.shift();
  if (next) {
    // 槽位直接移交给下一个等待者，activeCount 不变
    next();
  } else {
    activeCount = Math.max(0, activeCount - 1);
  }
}

// ---------------------------------------------------------------------------
// 配额：按 org_id + 'YYYY-MM' 累计。orgId 为 null/undefined（用户无所属组织）统一记到 org_id=0，
// 避免 NULL 参与 SQL 唯一键比较时的各种边界问题。
// ---------------------------------------------------------------------------
function normalizeOrgId(orgId) {
  const n = Number(orgId);
  return orgId === null || orgId === undefined || !Number.isFinite(n) ? 0 : n;
}

function currentPeriod() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// 校验 + 预占：单事务内 SELECT ... FOR UPDATE 行锁读当月已用量，超限则回滚并 throw（statusCode=429），
// 否则原子加上 jobsCount，防止同一 org 并发提交多个 batch 时都在校验通过后才写入导致超发。
async function checkAndReserveQuota(orgId, jobsCount) {
  const org = normalizeOrgId(orgId);
  const period = currentPeriod();
  const limitRaw = Number(process.env.AI_MONTHLY_JOB_LIMIT);
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? Math.floor(limitRaw) : 500;
  const count = Math.max(1, Math.floor(Number(jobsCount) || 1));

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      'INSERT INTO ai_usage_quota (org_id, period, tokens_used, jobs_used) VALUES (?, ?, 0, 0) ON DUPLICATE KEY UPDATE org_id = org_id',
      [org, period]
    );
    const [rows] = await conn.query(
      'SELECT jobs_used FROM ai_usage_quota WHERE org_id = ? AND period = ? FOR UPDATE',
      [org, period]
    );
    const used = rows && rows[0] ? Number(rows[0].jobs_used) : 0;
    if (used + count > limit) {
      const err = new Error(`本月 AI 生成任务已达上限（${limit}），请下月再试或联系管理员`);
      err.statusCode = 429;
      throw err;
    }
    await conn.query(
      'UPDATE ai_usage_quota SET jobs_used = jobs_used + ? WHERE org_id = ? AND period = ?',
      [count, org, period]
    );
    await conn.commit();
  } catch (e) {
    try { await conn.rollback(); } catch (_) {}
    throw e;
  } finally {
    conn.release();
  }
}

// job 完成后累计 tokens；tokens 缺失（如 mock 模式无 usage 字段）时不记账，避免污染统计。
async function recordTokens(orgId, tokens) {
  const t = Number(tokens);
  if (!Number.isFinite(t) || t <= 0) return;
  const org = normalizeOrgId(orgId);
  const period = currentPeriod();
  await pool.query(
    `INSERT INTO ai_usage_quota (org_id, period, tokens_used, jobs_used)
     VALUES (?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE tokens_used = tokens_used + VALUES(tokens_used)`,
    [org, period, Math.floor(t)]
  );
}

module.exports = { acquire, release, checkAndReserveQuota, recordTokens };
