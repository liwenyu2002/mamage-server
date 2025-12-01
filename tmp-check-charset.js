const db = require('./db');

(async () => {
  try {
    const [rows] = await db.pool.query(
      "SHOW VARIABLES WHERE Variable_name LIKE 'character_set_%' OR Variable_name LIKE 'collation_%'"
    );
    console.log(rows);
  } catch (e) {
    console.error(e && e.stack ? e.stack : e);
  } finally {
    // give node a moment then exit
    setTimeout(() => process.exit(), 200);
  }
})();