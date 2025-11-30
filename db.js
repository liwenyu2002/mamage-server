// db.js
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: '127.0.0.1',
  port: 3306,
  user: 'root',
  password: '320911',
  database: 'MaMage',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// 你在一个地方手动修改这个常量就行：
// - 开发环境示例： 'http://localhost:3000'
// - 部署时可改成你的域名 'https://cdn.example.com'
// 也可以通过环境变量覆盖：process.env.UPLOAD_BASE_URL
const UPLOAD_BASE_URL = process.env.UPLOAD_BASE_URL || 'http://localhost:3000';

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
