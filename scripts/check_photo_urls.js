const { pool } = require('../db');

(async () => {
  try {
    const [counts] = await pool.query(`SELECT 
      COUNT(*) AS total,
      SUM(CASE WHEN url LIKE 'http%' THEN 1 ELSE 0 END) AS httpCount,
      SUM(CASE WHEN url LIKE '/uploads/%' OR url LIKE 'uploads/%' THEN 1 ELSE 0 END) AS relCount
    FROM photos`);

    console.log('counts=', counts[0] || counts);

    const [samples] = await pool.query("SELECT id, url, thumb_url FROM photos WHERE NOT (url LIKE 'http%') LIMIT 20");
    console.log('samples (non-http):', samples);
    process.exit(0);
  } catch (e) {
    console.error('error querying DB:', e && e.message ? e.message : e);
    process.exit(2);
  }
})();
