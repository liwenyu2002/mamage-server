// scripts/run_migrations.js
// Safe, idempotent SQL migration runner for deployment.
//
// Behavior:
// - Loads .env and DB config via ../db
// - Ensures `schema_migrations` table exists
// - Runs SQL files under scripts/migrations in lexical order
// - Records applied file names, so each file runs once
//
// Usage:
//   node scripts/run_migrations.js

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const fs = require('fs');
const path = require('path');
const { pool } = require('../db');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function splitStatements(sqlText) {
  // Remove block comments first.
  let s = String(sqlText || '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Remove line comments that start a line.
  s = s
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*--.*$/, '').replace(/^\s*#.*$/, ''))
    .join('\n');

  // Split by statement terminator.
  return s
    .split(/;\s*(?:\r?\n|$)/)
    .map((x) => x.trim())
    .filter(Boolean);
}

async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      filename VARCHAR(255) NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      UNIQUE KEY uk_schema_migrations_filename (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);
}

async function listApplied() {
  const [rows] = await pool.query('SELECT filename FROM schema_migrations');
  return new Set((rows || []).map((r) => r.filename));
}

function listMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

async function applyOne(filename) {
  const fullPath = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(fullPath, 'utf8');
  const statements = splitStatements(sql);
  if (statements.length === 0) {
    console.log(`[migrate] skip empty migration: ${filename}`);
    await pool.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
    return;
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const stmt of statements) {
      await conn.query(stmt);
    }
    await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [filename]);
    await conn.commit();
    console.log(`[migrate] applied: ${filename} (${statements.length} statements)`);
  } catch (err) {
    await conn.rollback();
    throw new Error(`migration failed (${filename}): ${err && err.message ? err.message : err}`);
  } finally {
    conn.release();
  }
}

async function main() {
  try {
    await ensureMigrationsTable();
    const files = listMigrationFiles();
    const applied = await listApplied();

    if (files.length === 0) {
      console.log('[migrate] no migration files found');
      return;
    }

    let appliedCount = 0;
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`[migrate] already applied: ${file}`);
        continue;
      }
      await applyOne(file);
      appliedCount += 1;
    }

    console.log(`[migrate] done. newly applied: ${appliedCount}, total files: ${files.length}`);
  } finally {
    try {
      await pool.end();
    } catch (e) {}
  }
}

main().catch((err) => {
  console.error('[migrate] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});

