// db.js
const mysql = require('mysql2/promise');
const keys = require('./config/keys');

const DB_HOST = keys.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(keys.DB_PORT || '3306', 10) || 3306;
const DB_USER = keys.DB_USER || 'root';
const DB_PASSWORD = keys.DB_PASSWORD || '';
const DB_NAME = keys.DB_NAME || 'mamage';

console.log('[db] runtime mysql config =', {
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD ? '********' : '(empty)',
  database: DB_NAME
});

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Ensure each new connection uses utf8mb4 character set at session level.
// This guarantees correct handling of Chinese characters even if server defaults differ.
if (typeof pool.on === 'function') {
  pool.on('connection', (conn) => {
    try {
      conn.query("SET NAMES utf8mb4 COLLATE utf8mb4_unicode_ci");
    } catch (e) {
      // non-fatal, just log if debugging
      console.error('[db] failed to set connection names utf8mb4', e && e.stack ? e.stack : e);
    }
  });
}

// 你在一个地方手动修改这个常量就行：
// - 开发环境示例： 'http://localhost:3000'
// - 部署时可改成你的域名 'https://cdn.example.com'
// 也可以通过环境变量或 config/keys 覆盖：
const UPLOAD_BASE_URL = keys.UPLOAD_BASE_URL || 'https://mamage-img-1325439253.cos.ap-beijing.myqcloud.com';

// 简化版 buildUploadUrl：
// - 如果传入的是 http(s) 地址则直接返回
// - 如果是磁盘路径或包含反斜杠，会尝试提取从 '/uploads/' 开始的部分
// - 最终总是返回一个以 UPLOAD_BASE_URL + '/uploads/...' 开头的 URL
function buildUploadUrl(p) {
  if (!p) return p;
  const str = String(p).replace(/\\/g, '/');
  if (/^https?:\/\//i.test(str)) return str;

  let rel = str;
  const idx = rel.indexOf('/uploads/');
  if (idx !== -1) rel = rel.substring(idx);
  if (!rel.startsWith('/')) rel = '/' + rel;

  return UPLOAD_BASE_URL.replace(/\/$/, '') + rel;
}

module.exports = { pool, buildUploadUrl, UPLOAD_BASE_URL };
