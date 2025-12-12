// scripts/check_permissions.js
require('dotenv').config();
const { pool } = require('../db');

async function main() {
  const userId = process.argv[2] ? parseInt(process.argv[2], 10) : 8;
  try {
    console.log('[check_permissions] checking user id =', userId);
    const [urows] = await pool.query('SELECT id, role FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!urows || urows.length === 0) {
      console.log('User not found');
    } else {
      console.log('User:', urows[0]);
      const role = urows[0].role;
      const [prows] = await pool.query('SELECT permission FROM role_permissions WHERE role = ? ORDER BY permission', [role]);
      console.log('Permissions for role =', JSON.stringify(role));
      console.table(prows);
    }
    await pool.end();
    process.exit(0);
  } catch (e) {
    console.error('[check_permissions] error', e && e.stack ? e.stack : e);
    try { await pool.end(); } catch (er) {}
    process.exit(1);
  }
}

main();
