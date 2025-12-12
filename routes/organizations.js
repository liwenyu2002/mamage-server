const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// GET /api/organizations
// Optional query: q (search by name), limit
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    let limit = parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0 || limit > 200) limit = 50;

    // check if organizations table exists to avoid crash on older DB
    const [tbl] = await pool.query("SELECT COUNT(*) AS cnt FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'organizations'");
    if (!tbl || tbl.length === 0 || tbl[0].cnt === 0) {
      // table not present, return empty list
      return res.json([]);
    }

    // Detect which columns exist and build a safe SELECT accordingly
    const [colRows] = await pool.query(
      "SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'organizations'"
    );
    const cols = new Set((colRows || []).map(r => String(r.COLUMN_NAME).toLowerCase()));

    const selectParts = ['id', 'name'];
    if (cols.has('slug')) selectParts.push('slug');
    if (cols.has('is_public')) selectParts.push('IFNULL(is_public,1) AS is_public');
    if (cols.has('description')) selectParts.push('description');

    const params = [];
    let sql = 'SELECT ' + selectParts.join(', ') + ' FROM organizations';
    if (q) {
      if (cols.has('slug')) {
        sql += ' WHERE name LIKE ? OR slug LIKE ?';
        params.push('%' + q + '%', '%' + q + '%');
      } else {
        sql += ' WHERE name LIKE ?';
        params.push('%' + q + '%');
      }
    }
    sql += ' ORDER BY name ASC LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(sql, params);
    const out = (rows || []).map(r => ({
      id: r.id,
      name: r.name,
      slug: ('slug' in r) ? (r.slug || null) : null,
      is_public: ('is_public' in r) ? !!r.is_public : true,
      description: ('description' in r) ? (r.description || null) : null
    }));
    res.json(out);
  } catch (err) {
    console.error('GET /api/organizations error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
