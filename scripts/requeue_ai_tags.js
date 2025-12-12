// scripts/requeue_ai_tags.js
require('dotenv').config();
const { pool, buildUploadUrl } = require('../db');
const aiWorker = require('../lib/ai_tags_worker');

async function main() {
  try {
    console.log('[requeue_ai_tags] listing up to 20 photos lacking description/tags');
    const [rows] = await pool.query("SELECT id, thumb_url FROM photos WHERE (description IS NULL OR tags IS NULL) LIMIT 20");
    if (!rows || rows.length === 0) {
      console.log('[requeue_ai_tags] nothing to requeue');
      await pool.end();
      return process.exit(0);
    }

    console.log('[requeue_ai_tags] found', rows.length, 'rows');
    const ids = [];
    for (const r of rows) {
      const rel = r.thumb_url;
      if (!rel) {
        console.log('[requeue_ai_tags] skip id no thumb_url', r.id);
        continue;
      }
      // enqueue item: id + relPath
      aiWorker.enqueue({ id: r.id, relPath: rel });
      ids.push(r.id);
      console.log('[requeue_ai_tags] enqueued', r.id, rel);
    }

    console.log('[requeue_ai_tags] queue length (approx):', aiWorker.queueLength());

    // wait until queue drained or timeout
    const start = Date.now();
    const timeoutMs = 2 * 60 * 1000; // 2 minutes
    while (true) {
      const qlen = aiWorker.queueLength();
      console.log('[requeue_ai_tags] waiting, queueLength=', qlen);
      if (qlen === 0) break;
      if (Date.now() - start > timeoutMs) {
        console.warn('[requeue_ai_tags] timeout waiting for worker to finish');
        break;
      }
      // sleep 3s
      await new Promise((r) => setTimeout(r, 3000));
    }

    console.log('[requeue_ai_tags] fetching updated rows for enqueued ids');
    if (ids.length) {
      const [updated] = await pool.query('SELECT id, description, tags FROM photos WHERE id IN (' + ids.join(',') + ')');
      console.table(updated.map(u => ({ id: u.id, description: (u.description || '').slice(0,80), tags: u.tags })));
    }

    await pool.end();
    console.log('[requeue_ai_tags] done');
    process.exit(0);
  } catch (e) {
    console.error('[requeue_ai_tags] error', e && e.stack ? e.stack : e);
    try { await pool.end(); } catch (ee) {}
    process.exit(1);
  }
}

main();
