const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const keys = require('../config/keys');
const JWT_SECRET = keys.JWT_SECRET || 'please-change-this-secret';
const crypto = require('crypto');

// validation
const emailRegex = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const pwdRegex = /^(?![0-9]+$)(?![a-zA-Z]+$)[0-9A-Za-z]{8,16}$/; // 8-16 位字母+数字组合

// 检查 users 表中是否存在 password_hash 列（缓存结果）
let _hasPasswordColumn = null;
async function hasPasswordColumn() {
  if (_hasPasswordColumn !== null) return _hasPasswordColumn;
  const [rows] = await pool.query(
    "SELECT COUNT(*) as cnt FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'password_hash'"
  );
  _hasPasswordColumn = rows && rows[0] && rows[0].cnt > 0;
  return _hasPasswordColumn;
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}

// permissions helper
const { getPermissionsForRole } = require('../lib/permissions');

// auth middleware
async function authMiddleware(req, res, next) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.*)$/i);
  if (!m) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  const token = m[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    let user = null;
    try {
      const [rows] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname, organization_id FROM users WHERE id = ?', [payload.id]);
      if (!rows || rows.length === 0) return res.status(401).json({ error: 'Invalid token (user not found)' });
      user = rows[0];
    } catch (e) {
      // If DB doesn't have organization_id column, fallback to selecting without it
      const msg = e && e.message ? e.message : '';
      if (msg.indexOf("Unknown column 'organization_id'") !== -1 || (e && e.code === 'ER_BAD_FIELD_ERROR')) {
        const [rows2] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname FROM users WHERE id = ?', [payload.id]);
        if (!rows2 || rows2.length === 0) return res.status(401).json({ error: 'Invalid token (user not found)' });
        user = rows2[0];
        user.organization_id = null;
      } else {
        throw e;
      }
    }
    // convert avatar_url to full URL if present
    try { user.avatar_url = user.avatar_url ? buildUploadUrl(user.avatar_url) : null; } catch (e) { user.avatar_url = user.avatar_url || null; }
    // normalize organization_id to integer or null
    try {
      if (user.organization_id !== undefined && user.organization_id !== null) {
        user.organization_id = Number(user.organization_id);
        if (Number.isNaN(user.organization_id)) user.organization_id = null;
      } else {
        user.organization_id = null;
      }
    } catch (e) {
      user.organization_id = null;
    }
    // load permissions for this role
    try { user.permissions = await getPermissionsForRole(user.role); } catch (e) { user.permissions = []; }
    req.user = user;
    next();
  } catch (err) {
    console.error('[authMiddleware]', err && err.stack ? err.stack : err);
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// 注册
router.post('/register', async (req, res) => {
  try {
    const { name, password, student_no, email, department, invite_code, organization_id } = req.body || {};

    // basic validation
    if (!name || !password) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'name 和 password 为必填项' });
    if (!pwdRegex.test(password)) return res.status(400).json({ error: 'INVALID_PASSWORD', message: '密码须为8-16位，且为字母和数字的组合' });
    if (email && !emailRegex.test(email)) return res.status(400).json({ error: 'INVALID_EMAIL', message: '邮箱格式不正确' });

    // uniqueness checks
    if (student_no) {
      const [existing] = await pool.query('SELECT id FROM users WHERE student_no = ?', [student_no]);
      if (existing.length) return res.status(409).json({ error: 'student_no already exists' });
    }
    if (email) {
      const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
      if (existing.length) return res.status(409).json({ error: 'email already exists' });
    }

    const password_hash = await bcrypt.hash(password, 10);
    const now = new Date();

    // allowed roles
    const allowedRoles = new Set(['visitor','photographer','admin']);
    let role = 'visitor';

    // If invite_code provided, use transactional flow to consume it
    let conn = null;
    try {
      if (invite_code) {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT * FROM invitations WHERE code = ? FOR UPDATE', [invite_code]);
        if (!rows || rows.length === 0) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码无效' }); }
        const inv = rows[0];
        if (inv.revoked) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码已被撤销' }); }
        if (inv.expires_at && new Date(inv.expires_at) <= new Date()) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码已过期' }); }
        if (inv.max_uses !== null && inv.uses >= inv.max_uses) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码已使用完' }); }
        if (allowedRoles.has(inv.role)) role = inv.role;

        const finalStudentNo = (student_no !== undefined && student_no !== null && String(student_no).trim() !== '')
          ? String(student_no)
          : ('auto' + Date.now().toString(36) + uuidv4().replace(/-/g, '').slice(0,8));

        const cols = ['student_no','name','role','password_hash','created_at','updated_at'];
        const placeholders = ['?','?','?','?','?','?'];
        const params = [finalStudentNo, name, role, password_hash, now, now];

        if (organization_id !== undefined && organization_id !== null) {
          // validate organization exists and is public (with fallback if is_public missing)
          try {
            const [orgRows] = await conn.query('SELECT id, is_public FROM organizations WHERE id = ? LIMIT 1', [organization_id]);
            if (!orgRows || orgRows.length === 0) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_ORGANIZATION', message: 'organization not found' }); }
            if (orgRows[0].is_public === 0) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'ORG_NOT_PUBLIC', message: 'organization is not open for public registration' }); }
          } catch (e) {
            const msg = e && e.message ? e.message : '';
            if (msg.indexOf("Unknown column 'is_public'") !== -1 || (e && e.code === 'ER_BAD_FIELD_ERROR')) {
              // fallback: check existence only
              const [orgRows2] = await conn.query('SELECT id FROM organizations WHERE id = ? LIMIT 1', [organization_id]);
              if (!orgRows2 || orgRows2.length === 0) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_ORGANIZATION', message: 'organization not found' }); }
            } else {
              console.error('[users.register] organization validation error', e && e.stack ? e.stack : e);
              await conn.rollback(); conn.release();
              return res.status(500).json({ error: 'server error' });
            }
          }
          cols.push('organization_id'); placeholders.push('?'); params.push(organization_id);
        }
        if (department !== undefined) { cols.push('department'); placeholders.push('?'); params.push(department); }
        if (email !== undefined) { cols.push('email'); placeholders.push('?'); params.push(email); }

        const sql = `INSERT INTO users (${cols.join(',')}) VALUES (${placeholders.join(',')})`;
        const [result] = await conn.query(sql, params);
        const userId = result.insertId;
        await conn.query('UPDATE invitations SET uses = uses + 1 WHERE id = ?', [inv.id]);
        await conn.commit(); conn.release();
        const token = signToken({ id: userId, role });
        return res.json({ id: userId, token });
      } else {
        // normal registration
        const finalStudentNo = (student_no !== undefined && student_no !== null && String(student_no).trim() !== '')
          ? String(student_no)
          : ('auto' + Date.now().toString(36) + uuidv4().replace(/-/g, '').slice(0,8));
        const cols = [];
        const placeholders = [];
        const params = [];
        cols.push('student_no'); placeholders.push('?'); params.push(finalStudentNo);
        cols.push('name'); placeholders.push('?'); params.push(name);
        if (department !== undefined) { cols.push('department'); placeholders.push('?'); params.push(department); }
        cols.push('role'); placeholders.push('?'); params.push(role);
        if (email !== undefined) { cols.push('email'); placeholders.push('?'); params.push(email); }
        cols.push('password_hash'); placeholders.push('?'); params.push(password_hash);
        cols.push('created_at'); placeholders.push('?'); params.push(now);
        cols.push('updated_at'); placeholders.push('?'); params.push(now);

        if (organization_id !== undefined && organization_id !== null) {
          try {
            const [orgRows] = await pool.query('SELECT id, is_public FROM organizations WHERE id = ? LIMIT 1', [organization_id]);
            if (!orgRows || orgRows.length === 0) return res.status(400).json({ error: 'INVALID_ORGANIZATION', message: 'organization not found' });
            if (orgRows[0].is_public === 0) return res.status(400).json({ error: 'ORG_NOT_PUBLIC', message: 'organization is not open for public registration' });
          } catch (e) {
            const msg = e && e.message ? e.message : '';
            if (msg.indexOf("Unknown column 'is_public'") !== -1 || (e && e.code === 'ER_BAD_FIELD_ERROR')) {
              const [orgRows2] = await pool.query('SELECT id FROM organizations WHERE id = ? LIMIT 1', [organization_id]);
              if (!orgRows2 || orgRows2.length === 0) return res.status(400).json({ error: 'INVALID_ORGANIZATION', message: 'organization not found' });
            } else {
              console.error('[users.register] organization validation error', e && e.stack ? e.stack : e);
              return res.status(500).json({ error: 'server error' });
            }
          }
          cols.push('organization_id'); placeholders.push('?'); params.push(organization_id);
        }

        const sql = `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
        const [result] = await pool.query(sql, params);
        const userId = result.insertId;
        const token = signToken({ id: userId, role });
        return res.json({ id: userId, token });
      }
    } catch (e) {
      if (conn) { try { await conn.rollback(); conn.release(); } catch(_){} }
      console.error('[users.register] transaction error', e && e.stack ? e.stack : e);
      if (e && (e.code === 'ER_NO_DEFAULT_FOR_FIELD' || (e.message && e.message.indexOf("organization_id") !== -1))) {
        return res.status(500).json({
          error: 'DB_SCHEMA_ORG_FIELD',
          message: "Database users.organization_id column requires a value or default. Run: ALTER TABLE users MODIFY COLUMN organization_id INT UNSIGNED NULL;",
          sql: "ALTER TABLE users MODIFY COLUMN organization_id INT UNSIGNED NULL;"
        });
      }
      return res.status(500).json({ error: 'server error' });
    }
  } catch (err) {
    console.error('[users.register]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'server error' });
  }
});

// 登录
router.post('/login', async (req, res) => {
  try {
    if (!await hasPasswordColumn()) {
      return res.status(400).json({
        error: 'Database missing column `password_hash`. Cannot perform password login.',
        sql: "ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL;"
      });
    }

    const { email, password, student_no } = req.body;
    if ((!email && !student_no) || !password) return res.status(400).json({ error: 'email/student_no and password are required' });

    const where = email ? 'email = ?' : 'student_no = ?';
    const val = email || student_no;
    const [rows] = await pool.query('SELECT id, password_hash, role FROM users WHERE ' + where + ' LIMIT 1', [val]);
    if (!rows || rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = signToken({ id: user.id, role: user.role });
    // load permissions for this role
    let perms = [];
    try {
      const { getPermissionsForRole } = require('../lib/permissions');
      perms = await getPermissionsForRole(user.role);
    } catch (e) {
      console.error('[users.login] failed to load permissions for role', user.role, e && e.message ? e.message : e);
      perms = [];
    }
    res.json({ id: user.id, token, username: user.name, role: user.role, permissions: perms });
  } catch (err) {
    console.error('[users.login]', err);
    res.status(500).json({ error: 'server error' });
  }
});

// 获取当前用户信息
router.get('/me', authMiddleware, async (req, res) => {
  res.json(req.user);
});

// 更新当前用户资料（允许更新: name, department, avatar_url, nickname, email）
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const allowed = ['name', 'department', 'avatar_url', 'nickname', 'email'];
    const updates = [];
    const params = [];
    for (const k of allowed) {
      if (req.body[k] !== undefined) {
        updates.push(`${k} = ?`);
        params.push(req.body[k]);
      }
    }
    // validate email if provided
    if (req.body.email !== undefined && req.body.email !== null && req.body.email !== '') {
      if (!emailRegex.test(req.body.email)) {
        return res.status(400).json({ error: 'INVALID_EMAIL', message: '邮箱格式不正确' });
      }
    }
    if (updates.length === 0) return res.status(400).json({ error: 'no updatable fields provided' });
    params.push(new Date()); // updated_at
    params.push(req.user.id);
    const sql = `UPDATE users SET ${updates.join(', ')}, updated_at = ? WHERE id = ?`;
    await pool.query(sql, params);
    const [rows] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname, organization_id FROM users WHERE id = ?', [req.user.id]);
    if (rows && rows[0]) {
      try { rows[0].avatar_url = rows[0].avatar_url ? buildUploadUrl(rows[0].avatar_url) : null; } catch (e) { rows[0].avatar_url = rows[0].avatar_url || null; }
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[users.update]', err);
    res.status(500).json({ error: 'server error' });
  }
});

// 修改当前用户密码：PUT /api/users/me/password
// body: { currentPassword, newPassword }
router.put('/me/password', authMiddleware, async (req, res) => {
  try {
    // ensure DB has password_hash column
    if (!await hasPasswordColumn()) {
      return res.status(400).json({
        error: 'Database missing column `password_hash`. Cannot change password.',
        sql: "ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL;"
      });
    }

    const currentPassword = req.body.currentPassword;
    const newPassword = req.body.newPassword;

    if (!newPassword) return res.status(400).json({ error: 'MISSING_NEW_PASSWORD' });
    if (!pwdRegex.test(newPassword)) return res.status(400).json({ error: 'INVALID_PASSWORD', message: '密码须为8-16位，且为字母和数字的组合' });

    // read existing hash
    const [rows] = await pool.query('SELECT password_hash FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    const storedHash = rows && rows[0] ? rows[0].password_hash : null;

    if (storedHash) {
      // require currentPassword to verify
      if (!currentPassword) return res.status(400).json({ error: 'MISSING_CURRENT_PASSWORD' });
      const ok = await bcrypt.compare(currentPassword, storedHash || '');
      if (!ok) return res.status(401).json({ error: 'INVALID_CURRENT_PASSWORD' });
    }

    const newHash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [newHash, new Date(), req.user.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('[users.changePassword]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'server error' });
  }
});

// POST /api/users/invitations  (admin 创建邀请码)
const { requirePermission } = require('../lib/permissions');

router.post('/invitations', authMiddleware, requirePermission('users.invitations.create'), async (req, res) => {
  try {
    const { role, expires_at, max_uses = 1, note } = req.body;
    const allowed = new Set(['visitor','photographer','admin']);
    if (!allowed.has(role)) return res.status(400).json({ error: 'INVALID_ROLE' });
    const code = crypto.randomBytes(20).toString('hex');
    const [result] = await pool.query('INSERT INTO invitations (code, role, created_by, expires_at, max_uses, note) VALUES (?, ?, ?, ?, ?, ?)', [code, role, req.user.id, expires_at || null, max_uses || 1, note || null]);
    res.json({ id: result.insertId, code, role, max_uses });
  } catch (err) {
    console.error('[invitations.create]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'server error' });
  }
});

// 用户在个人页提交邀请码以申请更高权限
router.post('/me/invite', authMiddleware, async (req, res) => {
  const { invite_code } = req.body;
  if (!invite_code) return res.status(400).json({ error: 'MISSING_FIELDS' });
  let conn = null;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM invitations WHERE code = ? FOR UPDATE', [invite_code]);
    if (!rows || rows.length === 0) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE' }); }
    const inv = rows[0];
    if (inv.revoked) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE' }); }
    if (inv.expires_at && new Date(inv.expires_at) <= new Date()) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE' }); }
    if (inv.max_uses !== null && inv.uses >= inv.max_uses) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE' }); }
    // apply role
    await conn.query('UPDATE users SET role = ?, updated_at = ? WHERE id = ?', [inv.role, new Date(), req.user.id]);
    await conn.query('UPDATE invitations SET uses = uses + 1 WHERE id = ?', [inv.id]);
    await conn.commit();
    conn.release();
    const [rows2] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname, organization_id FROM users WHERE id = ?', [req.user.id]);
    if (rows2 && rows2[0]) {
      try { rows2[0].avatar_url = rows2[0].avatar_url ? buildUploadUrl(rows2[0].avatar_url) : null; } catch (e) { rows2[0].avatar_url = rows2[0].avatar_url || null; }
    }
    res.json(rows2[0]);
  } catch (err) {
    if (conn) { try { await conn.rollback(); conn.release(); } catch(_){} }
    console.error('[users.applyInvite]', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
