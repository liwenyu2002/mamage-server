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

// 简单 RBAC 中间件构建器：需在使用前保证 authMiddleware 已把 req.user 填充
// NOTE: Role checks are replaced with table-driven permissions using `role_permissions`.
// Use `requirePermission(permission)` from `lib/permissions.js` for route protection.

const { getPermissionsForRole } = require('../lib/permissions');

async function authMiddleware(req, res, next) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.*)$/i);
  if (!m) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  const token = m[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname FROM users WHERE id = ?', [payload.id]);
    if (!rows || rows.length === 0) return res.status(401).json({ error: 'Invalid token (user not found)' });
    const user = rows[0];
    // convert avatar_url to full URL if present
    try {
      user.avatar_url = user.avatar_url ? buildUploadUrl(user.avatar_url) : null;
    } catch (e) {
      user.avatar_url = user.avatar_url || null;
    }
    // attach permissions fetched from role_permissions table
    try {
      user.permissions = await getPermissionsForRole(user.role);
    } catch (e) {
      console.error('[authMiddleware] failed to load permissions for role', user.role, e && e.message ? e.message : e);
      user.permissions = [];
    }
    req.user = user;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// 注册
// 注册（支持 invite_code）
router.post('/register', async (req, res) => {
  try {
    if (!await hasPasswordColumn()) {
      return res.status(400).json({
        error: 'Database missing column `password_hash`. Run the following SQL to add it before using password registration.',
        sql: "ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL;"
      });
    }

    const { student_no, name, department, role: roleInput, email, password, invite_code } = req.body;
    // 我们在系统中使用三类角色：visitor, photographer, admin
    const allowedRoles = new Set(['visitor','photographer','admin']);
    // 默认自助注册为 visitor，除非消费 invite_code 后设为其他
    let role = 'visitor';
    if (!name || !password) return res.status(400).json({ error: 'MISSING_FIELDS', message: 'name 和 password 为必填项' });

    // validate password
    if (!pwdRegex.test(password)) {
      return res.status(400).json({ error: 'INVALID_PASSWORD', message: '密码须为8-16位，且为字母和数字的组合' });
    }

    // validate email if provided
    if (email && !emailRegex.test(email)) {
      return res.status(400).json({ error: 'INVALID_EMAIL', message: '邮箱格式不正确' });
    }

    // 可选的唯一性检查（按 student_no 或 email）
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

    // 如果有 invite_code，尝试在事务中校验并消费（原子化）
    let conn = null;
    try {
      if (invite_code) {
        conn = await pool.getConnection();
        await conn.beginTransaction();
        const [rows] = await conn.query('SELECT * FROM invitations WHERE code = ? FOR UPDATE', [invite_code]);
        if (!rows || rows.length === 0) {
          await conn.rollback();
          conn.release();
          return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码无效' });
        }
        const inv = rows[0];
        if (inv.revoked) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码已被撤销' }); }
        if (inv.expires_at && new Date(inv.expires_at) <= new Date()) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码已过期' }); }
        if (inv.max_uses !== null && inv.uses >= inv.max_uses) { await conn.rollback(); conn.release(); return res.status(400).json({ error: 'INVALID_INVITE', message: '邀请码已使用完' }); }
        // invite 有效，采纳其 role
        if (allowedRoles.has(inv.role)) role = inv.role;
        // 准备插入用户
        const finalStudentNo = (student_no !== undefined && student_no !== null && String(student_no).trim() !== '')
          ? String(student_no)
          : ('auto' + Date.now().toString(36) + uuidv4().replace(/-/g, '').slice(0,8));
        const cols = ['student_no','name','role','password_hash','created_at','updated_at'];
        const placeholders = ['?','?','?','?','?','?'];
        const params = [finalStudentNo, name, role, password_hash, now, now];
        if (department !== undefined) { cols.push('department'); placeholders.push('?'); params.push(department); }
        if (email !== undefined) { cols.push('email'); placeholders.push('?'); params.push(email); }
        const sql = `INSERT INTO users (${cols.join(',')}) VALUES (${placeholders.join(',')})`;
        const [result] = await conn.query(sql, params);
        const userId = result.insertId;
        // consume invite
        await conn.query('UPDATE invitations SET uses = uses + 1 WHERE id = ?', [inv.id]);
        await conn.commit();
        conn.release();
        const token = signToken({ id: userId, role });
        return res.json({ id: userId, token });
      } else {
        // 普通注册（无需事务）
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
        const sql = `INSERT INTO users (${cols.join(', ')}) VALUES (${placeholders.join(', ')})`;
        const [result] = await pool.query(sql, params);
        const userId = result.insertId;
        const token = signToken({ id: userId, role });
        return res.json({ id: userId, token });
      }
    } catch (e) {
      if (conn) { try { await conn.rollback(); conn.release(); } catch(_){} }
      console.error('[users.register] transaction error', e && e.stack ? e.stack : e);
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
    const [rows] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname FROM users WHERE id = ?', [req.user.id]);
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
    const [rows2] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname FROM users WHERE id = ?', [req.user.id]);
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
