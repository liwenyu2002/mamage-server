require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

async function run() {
    const sqlPath = path.join(__dirname, 'create_image_embeddings_table.sql');
    if (!fs.existsSync(sqlPath)) {
        console.error('SQL file not found:', sqlPath);
        process.exit(2);
    }

    const raw = fs.readFileSync(sqlPath, 'utf8');
    const parts = raw
        .split(/;\s*\n/) // split on semicolon + newline
        .map((s) => s.trim())
        .filter((s) => s.length > 0);

    console.log('[run_create_image_embeddings_table] found', parts.length, 'statements');

    try {
        for (let i = 0; i < parts.length; i++) {
            const stmt = parts[i];
            console.log('[run_create_image_embeddings_table] executing statement', i + 1);
            await pool.query(stmt);
        }

        const [rows] = await pool.query("SHOW TABLES LIKE 'ai_%'");
        console.log('[run_create_image_embeddings_table] verification result:');
        console.table(rows);

        await pool.end();
        console.log('[run_create_image_embeddings_table] done');
        process.exit(0);
    } catch (err) {
        console.error('[run_create_image_embeddings_table] error:', err && err.stack ? err.stack : err);
        try { await pool.end(); } catch (e) { }
        process.exit(1);
    }
}

run();
