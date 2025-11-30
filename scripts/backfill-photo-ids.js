// scripts/backfill-photo-ids.js
// Usage: node scripts/backfill-photo-ids.js [--apply]
// Without --apply it will only print summary and examples.

const mysql = require('mysql2/promise');

(async () => {
  const apply = process.argv.includes('--apply');

  const pool = mysql.createPool({
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '320911',
    database: 'MaMage',
    waitForConnections: true,
    connectionLimit: 5
  });

  try {
    const [projects] = await pool.query('SELECT id FROM projects');
    console.log('Found projects:', projects.length);

    for (const p of projects) {
      const pid = p.id;
      const [photos] = await pool.query('SELECT id FROM photos WHERE project_id = ? ORDER BY id ASC', [pid]);
      const ids = photos.map(r => r.id);
      // 写入时使用 JSON 数组，这样兼容 projects.photo_ids 为 JSON 类型或 TEXT
      const jsonVal = ids.length ? JSON.stringify(ids) : null;

      if (apply) {
        await pool.query('UPDATE projects SET photo_ids = ? WHERE id = ?', [jsonVal, pid]);
        console.log(`Updated project ${pid}: ${jsonVal}`);
      } else {
        console.log(`Project ${pid}: would set photo_ids = ${jsonVal}`);
      }
    }

    console.log('\nDone.');
  } catch (e) {
    console.error('Error:', e.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
