// scripts/process_pending_ai_jobs.js
require('dotenv').config();
const { pool } = require('../db');
const { runJobNow } = require('../lib/ai_job_worker');

async function main() {
  try {
    console.log('[process_pending_ai_jobs] scanning for pending ai_jobs');
    const [rows] = await pool.query("SELECT id, status, created_at FROM ai_jobs WHERE status IN ('pending','running') ORDER BY created_at LIMIT 50");
    if (!rows || rows.length === 0) {
      console.log('[process_pending_ai_jobs] no pending or running jobs found');
      await pool.end();
      return process.exit(0);
    }

    console.log('[process_pending_ai_jobs] found', rows.length, 'jobs');
    for (const r of rows) {
      try {
        console.log('[process_pending_ai_jobs] processing job', r.id, 'status=', r.status);
        await runJobNow(r.id);
        console.log('[process_pending_ai_jobs] done job', r.id);
      } catch (e) {
        console.error('[process_pending_ai_jobs] job failed', r.id, e && e.stack ? e.stack : e);
      }
    }

    // print recent jobs statuses
    const [after] = await pool.query('SELECT id, status, finished_at, error FROM ai_jobs WHERE id IN (' + rows.map(r=>r.id).join(',') + ')');
    console.table(after);

    await pool.end();
    console.log('[process_pending_ai_jobs] finished');
    process.exit(0);
  } catch (e) {
    console.error('[process_pending_ai_jobs] error', e && e.stack ? e.stack : e);
    try { await pool.end(); } catch (er) {}
    process.exit(1);
  }
}

main();
