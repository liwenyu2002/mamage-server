const { pool } = require('../db');
const { generateFromPrompt } = require('../ai_function/ai_for_news/ai_for_news');
const { getTemplateByKey } = require('./channel_templates');
const { acquire, release, recordTokens } = require('./ai_quota');

// job.user_id 不带组织信息；配额记账按组织维度，这里按需查一次 users 表。
// 查不到（用户已删除/无 organization_id 列）时按 null 处理，recordTokens 会归到 org_id=0。
async function getOrgIdForUser(userId) {
  if (!userId) return null;
  try {
    const [rows] = await pool.query('SELECT organization_id FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!rows || !rows[0] || rows[0].organization_id === null || rows[0].organization_id === undefined) return null;
    const org = Number(rows[0].organization_id);
    return Number.isFinite(org) ? org : null;
  } catch (e) {
    return null;
  }
}

async function processJob(jobId) {
  try {
    const [rows] = await pool.query('SELECT * FROM ai_jobs WHERE id = ?', [jobId]);
    if (!rows || rows.length === 0) return;
    const job = rows[0];

    await pool.query('UPDATE ai_jobs SET status = ?, started_at = NOW() WHERE id = ?', ['running', jobId]);

    // call AI — accept options stored as JSON string or already-parsed object
    let options = {};
    try {
      if (!job.options) options = {};
      else if (typeof job.options === 'string') options = JSON.parse(job.options);
      else options = job.options; // already parsed object
    } catch (e) {
      // fallback to empty options
      options = {};
    }

    // 按渠道矩阵生成的 job 会带 channel_key；旧的单渠道路径（POST /generate 默认路径）没有这一列，
    // options 里也就不带 channelTemplate，generateFromPrompt 内部自动回退到 LEGACY_SYSTEM_PROMPT。
    if (job.channel_key) {
      const template = await getTemplateByKey(job.channel_key);
      if (template) options = { ...options, channelTemplate: template };
    }

    // 全局并发池只包裹真正打第三方模型 API 的这一段：DB 读写不占外部速率限制，没必要占着槽位排队。
    await acquire();
    let result;
    try {
      result = await generateFromPrompt({ prompt: job.prompt_text, options });
    } finally {
      release();
    }

    // store result
    await pool.query(
      `INSERT INTO ai_results (job_id, title, subtitle, markdown, html, placeholders, extra, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        jobId,
        result.title,
        result.subtitle,
        result.markdown,
        result.html,
        JSON.stringify(result.placeholders || []),
        result.extra ? JSON.stringify(result.extra) : null,
      ]
    );

    await pool.query('UPDATE ai_jobs SET status = ?, finished_at = NOW(), tokens_used = ?, cost_estimate = ? WHERE id = ?', ['succeeded', result.tokens || 0, result.cost || 0, jobId]);

    if (result.tokens) {
      const orgId = await getOrgIdForUser(job.user_id);
      recordTokens(orgId, result.tokens).catch((e) => {
        // 配额记账失败不影响已经成功的 job，只记日志
        console.error('[ai_job_worker] recordTokens failed', jobId, e && e.stack ? e.stack : e);
      });
    }

    console.log('[ai_job_worker] job succeeded', jobId);
  } catch (e) {
    console.error('[ai_job_worker] job failed', jobId, e && e.stack ? e.stack : e);
    try {
      await pool.query('UPDATE ai_jobs SET status = ?, error = ?, finished_at = NOW() WHERE id = ?', ['failed', String(e && e.message || e), jobId]);
    } catch (ee) {}
  }
}

// enqueue: for now just run in background (setImmediate)
async function enqueueJob(jobId) {
  setImmediate(() => {
    processJob(jobId).catch(e => console.error('enqueue processJob error', e));
  });
}

// run job synchronously (for sync=true)
async function runJobNow(jobId) {
  return processJob(jobId);
}

// getOrgIdForUser 同时供 routes/ai_news.js 复用（GET /batches/:batchId 按 batch 创建者的组织取企业预设做禁用词校验），
// 避免在两个文件里各写一份同样的 users 表查询。
module.exports = { enqueueJob, runJobNow, processJob, getOrgIdForUser };
