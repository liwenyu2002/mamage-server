const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const keys = require('../config/keys');
const JWT_SECRET = keys.JWT_SECRET || 'please-change-this-secret';

async function getRoleByUserId(userId) {
  const [rows] = await pool.query('SELECT role FROM users WHERE id = ? LIMIT 1', [userId]);
  if (!rows || rows.length === 0) return null;
  return rows[0].role;
}

async function hasPermissionForRole(role, permission) {
  const [rows] = await pool.query('SELECT 1 FROM role_permissions WHERE role = ? AND permission = ? LIMIT 1', [role, permission]);
  return rows && rows.length > 0;
}

async function hasPermissionForUserId(userId, permission) {
  const role = await getRoleByUserId(userId);
  if (!role) return false;
  return hasPermissionForRole(role, permission);
}

async function getPermissionsForRole(role) {
  if (!role) return [];
  const [rows] = await pool.query('SELECT permission FROM role_permissions WHERE role = ? ORDER BY permission', [role]);
  if (!rows) return [];
  return rows.map(r => r.permission);
}

async function getPermissionsForUserId(userId) {
  const role = await getRoleByUserId(userId);
  if (!role) return [];
  return getPermissionsForRole(role);
}

// Middleware factory: requirePermission('photos.delete')
function requirePermission(permission) {
  return async function (req, res, next) {
    try {
      let userId = null;
      // 如果请求已由 auth middleware 填充 req.user，则优先使用
      if (req.user && req.user.id) {
        userId = req.user.id;
      } else {
        const auth = req.get('authorization') || '';
        const m = auth.match(/^Bearer\s+(.*)$/i);
        if (!m) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
        const token = m[1];
        let payload;
        try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
        userId = payload.id;
      }

      const role = await getRoleByUserId(userId);
      if (!role) return res.status(401).json({ error: 'Invalid token (user not found)' });

      const ok = await hasPermissionForRole(role, permission);
      if (!ok) return res.status(403).json({ error: 'forbidden' });

      if (!req.user) req.user = { id: userId, role };
      return next();
    } catch (err) {
      console.error('[permissions]', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'server error' });
    }
  };
}

module.exports = { getRoleByUserId, hasPermissionForUserId, requirePermission, getPermissionsForRole, getPermissionsForUserId };
// Middleware: 只允许 admin 角色访问
function requireAdmin() {
  return async function (req, res, next) {
    try {
      let userId = null;
      if (req.user && req.user.id) {
        userId = req.user.id;
      } else {
        const auth = req.get('authorization') || '';
        const m = auth.match(/^Bearer\s+(.*)$/i);
        if (!m) return res.status(401).json({ error: 'Missing Authorization Bearer token' });
        const token = m[1];
        let payload;
        try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return res.status(401).json({ error: 'Invalid token' }); }
        userId = payload.id;
      }

      const role = await getRoleByUserId(userId);
      if (!role) return res.status(401).json({ error: 'Invalid token (user not found)' });
      if (role !== 'admin') return res.status(403).json({ error: 'forbidden' });

      if (!req.user) req.user = { id: userId, role };
      return next();
    } catch (err) {
      console.error('[permissions] requireAdmin error', err && err.stack ? err.stack : err);
      return res.status(500).json({ error: 'server error' });
    }
  };
}

module.exports.requireAdmin = requireAdmin;
