// scripts/run_seed_minimal.js
// Minimal idempotent seed for developer environments:
// 1) role_permissions baseline
// 2) default organization
// 3) default admin user
//
// Usage:
//   node scripts/run_seed_minimal.js
//
// Optional envs:
//   DEV_SEED_ORG_NAME=Default Organization
//   DEV_SEED_ORG_SLUG=default-org
//   DEV_SEED_ADMIN_NAME=Dev Admin
//   DEV_SEED_ADMIN_STUDENT_NO=devadmin
//   DEV_SEED_ADMIN_EMAIL=dev-admin@example.com
//   DEV_SEED_ADMIN_PASSWORD=Dev123456
//   DEV_SEED_ADMIN_RESET_PASSWORD=1
//   SEED_ALLOW_IN_PROD=1

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { pool } = require('../db');

const ROLE_PERM_SQL = path.resolve(__dirname, '..', 'db', 'role_permissions_seed.sql');

const DEFAULTS = {
  orgName: process.env.DEV_SEED_ORG_NAME || 'Default Organization',
  orgSlug: process.env.DEV_SEED_ORG_SLUG || 'default-org',
  adminName: process.env.DEV_SEED_ADMIN_NAME || 'Dev Admin',
  adminStudentNo: process.env.DEV_SEED_ADMIN_STUDENT_NO || 'devadmin',
  adminEmail: process.env.DEV_SEED_ADMIN_EMAIL || 'dev-admin@example.com',
  adminPassword: process.env.DEV_SEED_ADMIN_PASSWORD || 'Dev123456',
  resetPassword: process.env.DEV_SEED_ADMIN_RESET_PASSWORD === '1',
};

const EXTRA_ROLE_PERMISSIONS = [
  ['admin', 'faces.view'],
  ['admin', 'faces.detect'],
  ['admin', 'faces.label'],
  ['admin', 'faces.merge'],
  ['admin', 'faces.config'],
  ['photographer', 'faces.view'],
  ['photographer', 'faces.detect'],
];

function assertSafeRuntime() {
  if (String(process.env.NODE_ENV || '').toLowerCase() === 'production' && process.env.SEED_ALLOW_IN_PROD !== '1') {
    throw new Error(
      'Refusing to run seed in production. Set SEED_ALLOW_IN_PROD=1 if you really want this.'
    );
  }
}

async function tableExists(tableName) {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS cnt
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  return Number(rows && rows[0] && rows[0].cnt) > 0;
}

async function getTableColumns(tableName) {
  const [rows] = await pool.query(
    `SELECT COLUMN_NAME
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [tableName]
  );
  const out = new Set();
  (rows || []).forEach((r) => out.add(String(r.COLUMN_NAME || '').trim()));
  return out;
}

function parseRolePermissionsFromSql(sqlFilePath) {
  if (!fs.existsSync(sqlFilePath)) return [];
  const text = fs.readFileSync(sqlFilePath, 'utf8');
  const out = [];
  const re = /INSERT\s+INTO\s+`?role_permissions`?\s+VALUES\s*\(\s*\d+\s*,\s*'((?:\\'|[^'])*)'\s*,\s*'((?:\\'|[^'])*)'/gi;
  let m = null;
  while ((m = re.exec(text)) !== null) {
    const role = String(m[1] || '').replace(/\\'/g, "'").trim();
    const perm = String(m[2] || '').replace(/\\'/g, "'").trim();
    if (!role || !perm) continue;
    out.push([role, perm]);
  }
  return out;
}

async function seedRolePermissions() {
  const exists = await tableExists('role_permissions');
  if (!exists) {
    console.warn('[seed] skip role_permissions: table not found');
    return 0;
  }
  const tuples = [
    ...parseRolePermissionsFromSql(ROLE_PERM_SQL),
    ...EXTRA_ROLE_PERMISSIONS,
  ];
  const uniq = new Map();
  tuples.forEach(([role, perm]) => {
    const k = `${role}::${perm}`;
    if (!uniq.has(k)) uniq.set(k, [role, perm]);
  });

  let count = 0;
  for (const [role, perm] of uniq.values()) {
    const [res] = await pool.query(
      'INSERT IGNORE INTO role_permissions (role, permission) VALUES (?, ?)',
      [role, perm]
    );
    count += Number((res && res.affectedRows) || 0);
  }
  return count;
}

async function upsertDefaultOrganization() {
  if (!await tableExists('organizations')) {
    throw new Error('organizations table not found. Run migrations/schema import first.');
  }
  const cols = await getTableColumns('organizations');
  if (!cols.has('name')) {
    throw new Error('organizations.name column is missing');
  }

  const { orgName, orgSlug } = DEFAULTS;
  let row = null;
  if (cols.has('slug') && orgSlug) {
    const [rows] = await pool.query('SELECT id, name, slug FROM organizations WHERE slug = ? LIMIT 1', [orgSlug]);
    row = rows && rows[0] ? rows[0] : null;
  }
  if (!row) {
    const [rows] = await pool.query('SELECT id, name, slug FROM organizations WHERE name = ? LIMIT 1', [orgName]);
    row = rows && rows[0] ? rows[0] : null;
  }

  if (row) {
    if (cols.has('slug') && orgSlug && String(row.slug || '') !== orgSlug) {
      await pool.query('UPDATE organizations SET slug = ? WHERE id = ?', [orgSlug, row.id]);
      row.slug = orgSlug;
    }
    return { id: Number(row.id), created: false, name: row.name, slug: row.slug || null };
  }

  const fields = ['name'];
  const values = [orgName];
  if (cols.has('slug')) {
    fields.push('slug');
    values.push(orgSlug);
  }
  const placeholders = fields.map(() => '?').join(', ');
  const [insertRes] = await pool.query(
    `INSERT INTO organizations (${fields.join(', ')}) VALUES (${placeholders})`,
    values
  );
  return {
    id: Number(insertRes.insertId),
    created: true,
    name: orgName,
    slug: cols.has('slug') ? orgSlug : null,
  };
}

function buildAdminSearchWhere(cols) {
  const where = [];
  const params = [];
  if (cols.has('email') && DEFAULTS.adminEmail) {
    where.push('email = ?');
    params.push(DEFAULTS.adminEmail);
  }
  if (cols.has('student_no') && DEFAULTS.adminStudentNo) {
    where.push('student_no = ?');
    params.push(DEFAULTS.adminStudentNo);
  }
  if (!where.length) throw new Error('users table has neither email nor student_no for lookup');
  return { where: where.join(' OR '), params };
}

async function upsertDefaultAdminUser(orgId) {
  if (!await tableExists('users')) {
    throw new Error('users table not found. Run migrations/schema import first.');
  }
  const cols = await getTableColumns('users');
  const needed = ['student_no', 'role', 'password_hash'];
  needed.forEach((c) => {
    if (!cols.has(c)) throw new Error(`users.${c} column is missing`);
  });

  const { where, params } = buildAdminSearchWhere(cols);
  const selectFields = ['id', 'student_no', 'role'];
  if (cols.has('name')) selectFields.push('name');
  if (cols.has('email')) selectFields.push('email');
  if (cols.has('organization_id')) selectFields.push('organization_id');
  const [rows] = await pool.query(
    `SELECT ${selectFields.join(', ')}
       FROM users
      WHERE ${where}
      ORDER BY id ASC
      LIMIT 1`,
    params
  );
  const existing = rows && rows[0] ? rows[0] : null;

  const passwordHash = await bcrypt.hash(DEFAULTS.adminPassword, 10);

  if (!existing) {
    const fields = [];
    const values = [];
    const push = (k, v) => { fields.push(k); values.push(v); };

    push('student_no', DEFAULTS.adminStudentNo);
    if (cols.has('name')) push('name', DEFAULTS.adminName);
    push('role', 'admin');
    if (cols.has('email')) push('email', DEFAULTS.adminEmail);
    push('password_hash', passwordHash);
    if (cols.has('organization_id')) push('organization_id', orgId);
    if (cols.has('created_at')) push('created_at', new Date());
    if (cols.has('updated_at')) push('updated_at', new Date());

    const placeholders = fields.map(() => '?').join(', ');
    const [insertRes] = await pool.query(
      `INSERT INTO users (${fields.join(', ')}) VALUES (${placeholders})`,
      values
    );
    return {
      id: Number(insertRes.insertId),
      created: true,
      studentNo: DEFAULTS.adminStudentNo,
      email: cols.has('email') ? DEFAULTS.adminEmail : null,
    };
  }

  const updateParts = [];
  const updateVals = [];
  const set = (expr, val) => { updateParts.push(expr); updateVals.push(val); };

  if (String(existing.role || '') !== 'admin') set('role = ?', 'admin');
  if (cols.has('name') && DEFAULTS.adminName && String(existing.name || '') !== DEFAULTS.adminName) {
    set('name = ?', DEFAULTS.adminName);
  }
  if (cols.has('email') && DEFAULTS.adminEmail && String(existing.email || '') !== DEFAULTS.adminEmail) {
    set('email = ?', DEFAULTS.adminEmail);
  }
  if (cols.has('organization_id') && Number(existing.organization_id || 0) !== Number(orgId || 0)) {
    set('organization_id = ?', orgId);
  }
  if (DEFAULTS.resetPassword) {
    set('password_hash = ?', passwordHash);
  }
  if (cols.has('updated_at')) {
    set('updated_at = ?', new Date());
  }

  if (updateParts.length) {
    updateVals.push(existing.id);
    await pool.query(`UPDATE users SET ${updateParts.join(', ')} WHERE id = ?`, updateVals);
  }

  return {
    id: Number(existing.id),
    created: false,
    studentNo: String(existing.student_no || ''),
    email: cols.has('email') ? (DEFAULTS.adminEmail || existing.email || null) : null,
  };
}

async function main() {
  assertSafeRuntime();
  if (!/^[0-9A-Za-z]{8,16}$/.test(DEFAULTS.adminPassword) || /^[0-9]+$/.test(DEFAULTS.adminPassword) || /^[A-Za-z]+$/.test(DEFAULTS.adminPassword)) {
    throw new Error('DEV_SEED_ADMIN_PASSWORD must be 8-16 chars and include both letters and numbers');
  }

  try {
    const permInserted = await seedRolePermissions();
    const org = await upsertDefaultOrganization();
    const admin = await upsertDefaultAdminUser(org.id);

    console.log('[seed] done');
    console.log('[seed] role_permissions inserted:', permInserted);
    console.log('[seed] organization:', org);
    console.log('[seed] admin user:', admin);
    console.log('[seed] login with:', {
      email: DEFAULTS.adminEmail,
      student_no: DEFAULTS.adminStudentNo,
      password: DEFAULTS.adminPassword,
    });
  } finally {
    try { await pool.end(); } catch (e) {}
  }
}

main().catch((err) => {
  console.error('[seed] failed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
