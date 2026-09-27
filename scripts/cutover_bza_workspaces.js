const fs = require('fs');
const { pool } = require('../db');
const keys = require('../config/keys');

const APPLY = process.argv.includes('--apply');
const DELETE_EMAILS = ['lwy@zgca.com', 'bza-admin-test@mamage.test'];
const PUBLIC_RELATIONS = [
  'zhaoyuwei@bza.edu.cn', 'yinpengfei@bza.edu.cn', 'v-zyy@bza.edu.cn',
  'rongshang@bza.edu.cn', 'v-wn@zgci.ac.cn',
];
const BUSINESS_SCHOOL = 'v-lzhi@zgci.ac.cn';
const OWNER_EMAIL = 's-lwy24@bza.edu.cn';
const BACKUP = '/Users/liwenyu/mamage-backups/mamage-20260927-before-account-cutover.sql.gz';
const EXPECTED_VISITOR_IDS = [26, 39, 40];
const TRANSFER_REFERENCES = [
  ['photos', 'photographer_id'],
  ['projects', 'admin_id'],
  ['ai_jobs', 'user_id'],
  ['ai_job_batches', 'user_id'],
  ['face_persons', 'created_by'],
  ['video_projects', 'user_id'],
  ['wechat_previews', 'created_by'],
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function prepare(conn) {
  const [[org]] = await conn.query('SELECT id FROM organizations WHERE code = ? LIMIT 1', ['BZA2024']);
  assert(org, 'BZA2024 organization not found');
  const [units] = await conn.query(
    'SELECT id, slug, name FROM organization_units WHERE organization_id = ? AND archived_at IS NULL ORDER BY id',
    [org.id]
  );
  const bySlug = new Map(units.map((unit) => [unit.slug, unit]));
  assert(units.length === 3 && ['student-media', 'business-school', 'public-relations'].every((slug) => bySlug.has(slug)),
    'Unexpected organization units');
  const [users] = await conn.query(
    `SELECT id, name, email, role, active_unit_id AS activeUnitId
     FROM users WHERE organization_id = ? ORDER BY id${APPLY ? ' FOR UPDATE' : ''}`, [org.id]
  );
  assert(users.length === 27, `Expected 27 BZA accounts, found ${users.length}`);
  const byEmail = new Map(users.map((user) => [String(user.email || '').toLowerCase(), user]));
  const owner = byEmail.get(OWNER_EMAIL);
  assert(owner && owner.id === 47, 'College administrator identity changed');
  const visitors = users.filter((user) => user.role === 'visitor');
  assert(JSON.stringify(visitors.map((user) => user.id)) === JSON.stringify(EXPECTED_VISITOR_IDS),
    'Visitor list changed; review before deleting');
  for (const email of [...DELETE_EMAILS, ...PUBLIC_RELATIONS, BUSINESS_SCHOOL]) {
    assert(byEmail.has(email), `Account not found: ${email}`);
  }
  const deleteIds = [...visitors.map((user) => user.id), ...DELETE_EMAILS.map((email) => byEmail.get(email).id)]
    .sort((a, b) => a - b);
  assert(JSON.stringify(deleteIds) === JSON.stringify([23, 26, 39, 40, 65]),
    'Deletion targets changed; review before applying');
  const deleteSet = new Set(deleteIds);
  const assignments = users.filter((user) => !deleteSet.has(user.id)).map((user) => {
    const email = String(user.email || '').toLowerCase();
    const slug = PUBLIC_RELATIONS.includes(email) ? 'public-relations'
      : email === BUSINESS_SCHOOL ? 'business-school' : 'student-media';
    return { id: user.id, email, unitId: bySlug.get(slug).id,
      unitName: bySlug.get(slug).name, role: user.id === owner.id ? 'manager' : 'editor' };
  });
  assert(deleteIds.length === 5 && assignments.length === 22, 'Unexpected cutover counts');
  assert(assignments.filter((row) => row.unitName === bySlug.get('public-relations').name).length === 5,
    'Public-relations count mismatch');
  assert(assignments.filter((row) => row.unitName === bySlug.get('business-school').name).length === 1,
    'Business-school count mismatch');

  const [[existingMemberships]] = await conn.query(
    `SELECT COUNT(*) AS count FROM organization_unit_memberships m
     JOIN organization_units ou ON ou.id = m.unit_id WHERE ou.organization_id = ? AND m.removed_at IS NULL`,
    [org.id]
  );
  assert(Number(existingMemberships.count) === 0, 'Some accounts already belong to units');
  const [[links]] = await conn.query('SELECT COUNT(*) AS count FROM share_links WHERE organization_id = ?', [org.id]);
  const [references] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND COLUMN_NAME IN
       ('user_id', 'created_by', 'photographer_id', 'admin_id', 'requested_by', 'target_user_id', 'granted_by')`
  );
  const [foreignKeys] = await conn.query(
    `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_SCHEMA = DATABASE()
       AND REFERENCED_TABLE_NAME = 'users' AND REFERENCED_COLUMN_NAME = 'id'`
  );
  const allowed = new Set([
    ...TRANSFER_REFERENCES.map(([table, column]) => `${table}.${column}`),
    'share_links.created_by', 'organization_unit_memberships.user_id',
    'organization_admin_grants.user_id', 'face_search_grants.user_id',
    'organization_access_audit.user_id',
  ]);
  const quote = (name) => `\`${name}\``;
  const checked = new Set();
  for (const { TABLE_NAME: table, COLUMN_NAME: column } of [...references, ...foreignKeys]) {
    if (checked.has(`${table}.${column}`)) continue;
    checked.add(`${table}.${column}`);
    const [[row]] = await conn.query(
      `SELECT COUNT(*) AS count FROM ${quote(table)} WHERE ${quote(column)} IN (?)`, [deleteIds]
    );
    if (Number(row.count) && !allowed.has(`${table}.${column}`)) {
      throw new Error(`Unplanned user references: ${table}.${column} (${row.count})`);
    }
  }
  const [[outsideLinks]] = await conn.query(
    'SELECT COUNT(*) AS count FROM share_links WHERE created_by IN (?) AND organization_id <> ?',
    [deleteIds, org.id]
  );
  assert(Number(outsideLinks.count) === 0, 'Accounts own links outside BZA');
  return { orgId: org.id, ownerId: owner.id, deleteIds,
    deleted: users.filter((user) => deleteSet.has(user.id)), assignments,
    legacyPublicLinks: Number(links.count) };
}

async function apply(conn, plan) {
  for (const [table, column] of TRANSFER_REFERENCES) {
    await conn.query(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` IN (?)`,
      [plan.ownerId, plan.deleteIds]);
  }
  await conn.query(
    'DELETE FROM share_link_items WHERE share_id IN (SELECT id FROM share_links WHERE organization_id = ?)',
    [plan.orgId]
  );
  await conn.query('DELETE FROM share_links WHERE organization_id = ?', [plan.orgId]);
  await conn.query('DELETE FROM organization_unit_memberships WHERE user_id IN (?)', [plan.deleteIds]);
  await conn.query('DELETE FROM face_search_grants WHERE user_id IN (?)', [plan.deleteIds]);
  await conn.query('DELETE FROM organization_admin_grants WHERE user_id IN (?)', [plan.deleteIds]);
  const [deleted] = await conn.query('DELETE FROM users WHERE organization_id = ? AND id IN (?)',
    [plan.orgId, plan.deleteIds]);
  assert(deleted.affectedRows === 5, 'Account deletion count changed');
  await conn.query('INSERT INTO organization_unit_memberships (unit_id, user_id, role) VALUES ?',
    [plan.assignments.map((row) => [row.unitId, row.id, row.role])]);
  for (const row of plan.assignments) {
    await conn.query('UPDATE users SET active_unit_id = ? WHERE id = ? AND organization_id = ?',
      [row.unitId, row.id, plan.orgId]);
  }
  await conn.query(
    `INSERT INTO organization_access_audit
      (organization_id, unit_id, user_id, action, resource_type, details)
     VALUES (?, NULL, ?, 'workspace.cutover', 'organization', ?)`,
    [plan.orgId, plan.ownerId, JSON.stringify({ deletedUserIds: plan.deleteIds,
      assignedCount: plan.assignments.length, removedLegacyPublicLinks: plan.legacyPublicLinks })]
  );
}

async function main() {
  if (APPLY) {
    assert((keys.DB_NAME || 'mamage') === 'mamage', 'Production database required');
    assert(process.env.BZA_CUTOVER_CONFIRM === 'DELETE_5_ASSIGN_22', 'Missing cutover confirmation');
    assert(fs.statSync(BACKUP).size > 1024 * 1024, 'Verified database backup is missing');
  }
  const conn = await pool.getConnection();
  try {
    if (APPLY) await conn.beginTransaction();
    const plan = await prepare(conn);
    console.log(JSON.stringify({ apply: APPLY, deleted: plan.deleted,
      assignments: plan.assignments, legacyPublicLinksToDelete: plan.legacyPublicLinks }));
    if (!APPLY) return;
    await apply(conn, plan);
    await conn.commit();
    console.log('BZA workspace cutover committed');
  } catch (error) {
    if (APPLY) await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
