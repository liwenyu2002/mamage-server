// scripts/test_ai_flow.js
require('dotenv').config();
const { pool } = require('../db');
const { runJobNow } = require('../lib/ai_job_worker');

async function main() {
  try {
    console.log('[test_ai_flow] inserting test job');
    const prompt = '测试新闻稿：这是一个自动化测试 prompt，用于验证 AI 路由与 worker 的写入与读取。';
    const [ins] = await pool.query(`INSERT INTO ai_jobs (user_id, project_id, status, model, prompt_text, options, client_request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [null, null, 'pending', 'mock', prompt, JSON.stringify({ test: true }), 'test-client-123']
    );

    const jobId = ins.insertId;
    console.log('[test_ai_flow] inserted jobId =', jobId);

    console.log('[test_ai_flow] running job synchronously');
    await runJobNow(jobId);

    console.log('[test_ai_flow] fetching job and result');
    const [jobRows] = await pool.query('SELECT * FROM ai_jobs WHERE id = ?', [jobId]);
    const [resRows] = await pool.query('SELECT * FROM ai_results WHERE job_id = ? ORDER BY id DESC LIMIT 1', [jobId]);

    console.log('--- job ---');
    console.dir(jobRows[0]);
    console.log('--- result ---');
    console.dir(resRows[0]);

    await pool.end();
    console.log('[test_ai_flow] done');
    process.exit(0);
  } catch (e) {
    console.error('[test_ai_flow] error', e && e.stack ? e.stack : e);
    try { await pool.end(); } catch (ee) {}
    process.exit(1);
  }
}

main();
