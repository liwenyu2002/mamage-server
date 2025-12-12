const { pool } = require('../db');
const { generateFromPrompt } = require('../ai_function/ai_for_news/ai_for_news');

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

    const result = await generateFromPrompt({ prompt: job.prompt_text, options });

    // store result
    await pool.query(`INSERT INTO ai_results (job_id, title, subtitle, markdown, html, placeholders, created_at) VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [jobId, result.title, result.subtitle, result.markdown, result.html, JSON.stringify(result.placeholders || [])]
    );

    await pool.query('UPDATE ai_jobs SET status = ?, finished_at = NOW(), tokens_used = ?, cost_estimate = ? WHERE id = ?', ['succeeded', result.tokens || 0, result.cost || 0, jobId]);

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

module.exports = { enqueueJob, runJobNow, processJob };
