// scripts/run_create_share_tables.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function run() {
    // If the tables already exist, exit early to make this script safe to run multiple times.
    try {
        const [existing] = await pool.query("SHOW TABLES LIKE 'share_links'");
        if (existing && existing.length > 0) {
            console.log('[run_create_share_tables] share_links already exists, skipping creation.');
            await pool.end();
            process.exit(0);
        }
    } catch (e) {
        // If the check fails, continue and let the normal flow report errors.
        console.warn('[run_create_share_tables] table existence check failed, continuing:', e && e.message ? e.message : e);
    }
    const sqlPath = path.join(__dirname, 'create_share_tables.sql');
    if (!fs.existsSync(sqlPath)) {
        console.error('SQL file not found:', sqlPath);
        process.exit(2);
    }

    const raw = fs.readFileSync(sqlPath, 'utf8');
    // Split on semicolons that are statement terminators.
    const parts = raw
        .split(/;\s*\n/) // split on semicolon + newline
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    console.log('[run_create_share_tables] found', parts.length, 'statements');

    try {
        for (let i = 0; i < parts.length; i++) {
            const stmt = parts[i];
            console.log('[run_create_share_tables] executing statement', i + 1);
            await pool.query(stmt);
        }

        const [rows] = await pool.query("SHOW TABLES LIKE 'share_%'");
        console.log('[run_create_share_tables] verification result:');
        console.table(rows);

        await pool.end();
        console.log('[run_create_share_tables] done');
        process.exit(0);
    } catch (err) {
        console.error('[run_create_share_tables] error:', err && err.stack ? err.stack : err);
        try {
            await pool.end();
        } catch (e) { }
        process.exit(1);
    }
}

run();
