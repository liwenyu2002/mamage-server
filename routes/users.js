const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const JWT_SECRET = process.env.JWT_SECRET || 'please-change-this-secret';

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

async function authMiddleware(req, res, next) {
  const auth = req.get('authorization') || '';
  const m = auth.match(/^Bearer\s+(.*)$/i);
  if (!m) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
  const token = m[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const [rows] = await pool.query('SELECT id, student_no, name, department, role, email, avatar_url, nickname FROM users WHERE id = ?', [payload.id]);
    if (!rows || rows.length === 0) return res.status(401).json({ error: 'Invalid token (user not found)' });
    req.user = rows[0];
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// 注册
router.post('/register', async (req, res) => {
  try {
    if (!await hasPasswordColumn()) {
      return res.status(400).json({
        error: 'Database missing column `password_hash`. Run the following SQL to add it before using password registration.',
        sql: "ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NULL;"
      });
    }

    const { student_no, name, department, role: roleInput, email, password } = req.body;
    // DB enum: ('admin','photographer','bc') — 如果传入不合法的 role，则使用默认 'photographer'
    const allowedRoles = new Set(['admin','photographer','bc']);
    const role = allowedRoles.has(roleInput) ? roleInput : 'photographer';
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

    // student_no 在当前 schema 是 NOT NULL 且无默认值 — 若未提供，生成一个唯一占位值（<=32 字符）
    const cols = [];
    const placeholders = [];
    const params = [];

    const finalStudentNo = (student_no !== undefined && student_no !== null && String(student_no).trim() !== '')
      ? String(student_no)
      : ('auto' + Date.now().toString(36) + uuidv4().replace(/-/g, '').slice(0,8));
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
    const token = signToken({ id: userId });
    res.json({ id: userId, token });
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
    const [rows] = await pool.query('SELECT id, password_hash FROM users WHERE ' + where + ' LIMIT 1', [val]);
    if (!rows || rows.length === 0) return res.status(401).json({ error: 'invalid credentials' });
    const user = rows[0];
    const ok = await bcrypt.compare(password, user.password_hash || '');
    if (!ok) return res.status(401).json({ error: 'invalid credentials' });
    const token = signToken({ id: user.id });
    res.json({ id: user.id, token });
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
    res.json(rows[0]);
  } catch (err) {
    console.error('[users.update]', err);
    res.status(500).json({ error: 'server error' });
  }
});

module.exports = router;
