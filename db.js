// db.js
// Ensure environment variables are loaded even when this module is imported
// directly by standalone scripts.
try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '.env') });
} catch (e) {}

const mysql = require('mysql2/promise');
const keys = require('./config/keys');

const DB_HOST = keys.DB_HOST || '127.0.0.1';
const DB_PORT = parseInt(keys.DB_PORT || '3306', 10) || 3306;
const DB_USER = keys.DB_USER || 'root';
const DB_PASSWORD = keys.DB_PASSWORD || '';
const DB_NAME = keys.DB_NAME || 'mamage';

if (process.env.LOG_DB_CONFIG === '1' || process.env.NODE_ENV !== 'production') {
  console.log('[db] runtime mysql config =', {
    host: DB_HOST,
    port: DB_PORT,
    user: DB_USER,
    password: DB_PASSWORD ? '********' : '(empty)',
    database: DB_NAME
  });
}

const DB_CONNECTION_LIMIT = Math.max(1, Number(process.env.DB_CONNECTION_LIMIT || 20));
const DB_QUEUE_LIMIT = Math.max(0, Number(process.env.DB_QUEUE_LIMIT || 200));

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  charset: 'utf8mb4',
  waitForConnections: true,
  connectionLimit: DB_CONNECTION_LIMIT,
  queueLimit: DB_QUEUE_LIMIT,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
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
const UPLOAD_BASE_URL = keys.UPLOAD_BASE_URL || keys.COS_BASE_URL || `http://localhost:${process.env.PORT || 8000}`;

// 媒体 URL 签名（/api/image 代理鉴权）。
// MEDIA_URL_SIGNING=1 时 buildUploadUrl 附加 ?e=<过期秒>&s=<HMAC>，image_proxy 校验后放行。
// 过期时间按"天索引 + TTL"取整，同一天内生成的签名相同，保住浏览器缓存。
const crypto = require('crypto');
const MEDIA_URL_SIGNING = String(process.env.MEDIA_URL_SIGNING || '') === '1';
const MEDIA_URL_SECRET = process.env.MEDIA_URL_SECRET || process.env.JWT_SECRET || '';
const MEDIA_URL_TTL_DAYS = (() => {
  const n = Number(process.env.MEDIA_URL_TTL_DAYS);
  return Number.isFinite(n) && n >= 2 ? n : 8; // 非数字/过小回退 8，NaN 会让 exp 失效导致全站媒体 403
})();

function mediaSignatureFor(key, exp) {
  return crypto
    .createHmac('sha256', MEDIA_URL_SECRET)
    .update(`${key}:${exp}`)
    .digest('hex')
    .slice(0, 32);
}

// rel 形如 '/uploads/...'；返回 '?e=..&s=..' 或 ''（未开启/无 secret 时）
// exp 按 TTL/2 天的桶取整：URL 在半个 TTL 内保持稳定（浏览器缓存可复用），
// 实际有效期在 TTL/2 与 TTL 之间滚动。
function signMediaQuery(rel) {
  if (!MEDIA_URL_SIGNING || !MEDIA_URL_SECRET || !rel) return '';
  const key = String(rel).replace(/^\/+/, '');
  if (!key.startsWith('uploads/')) return '';
  const bucketDays = Math.max(1, Math.floor(MEDIA_URL_TTL_DAYS / 2));
  const bucket = Math.floor(Math.floor(Date.now() / 86400000) / bucketDays);
  const exp = (bucket * bucketDays + MEDIA_URL_TTL_DAYS) * 86400;
  return `?e=${exp}&s=${mediaSignatureFor(key, exp)}`;
}

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

  return UPLOAD_BASE_URL.replace(/\/$/, '') + rel + signMediaQuery(rel);
}

// 服务端内部取媒体（AI 打标/人脸/调色/zip）用：把公网基址换成
// INTERNAL_UPLOAD_BASE_URL（如 http://127.0.0.1:8080/api/image），
// 避免经 cloudflared 公网回环导致超时；签名 query 原样保留仍可通过代理校验。
const INTERNAL_UPLOAD_BASE_URL = (process.env.INTERNAL_UPLOAD_BASE_URL || '').replace(/\/$/, '');

function buildInternalMediaUrl(p) {
  const url = buildUploadUrl(p);
  if (!INTERNAL_UPLOAD_BASE_URL || !url) return url;
  const publicBase = UPLOAD_BASE_URL.replace(/\/$/, '');
  if (String(url).startsWith(publicBase + '/')) {
    return INTERNAL_UPLOAD_BASE_URL + String(url).slice(publicBase.length);
  }
  return url;
}

module.exports = { pool, buildUploadUrl, buildInternalMediaUrl, signMediaQuery, UPLOAD_BASE_URL };
