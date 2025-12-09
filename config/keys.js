// config/keys.js
// Centralized loader for secrets and config values.
// - Loads from process.env by default.
// - If you use a local .env file during development, add `require('dotenv').config()` before importing this module (app.js should load dotenv).

const get = (name, fallback = null) => {
  return process.env[name] !== undefined ? process.env[name] : fallback;
};

module.exports = {
  // JWT
  JWT_SECRET: get('JWT_SECRET', 'please-change-this-secret'),

  // Upload paths
  UPLOAD_ABS_DIR: get('UPLOAD_ABS_DIR', null),
  UPLOAD_BASE_URL: get('UPLOAD_BASE_URL', null),

  // Tencent COS
  COS_SECRET_ID: get('COS_SECRET_ID', null),
  COS_SECRET_KEY: get('COS_SECRET_KEY', null),
  COS_BUCKET: get('COS_BUCKET', null),
  COS_REGION: get('COS_REGION', null),
  COS_BASE_URL: get('COS_BASE_URL', null)
  ,
  // Database (MySQL)
  DB_HOST: get('DB_HOST', '127.0.0.1'),
  DB_PORT: get('DB_PORT', '3306'),
  DB_USER: get('DB_USER', 'root'),
  DB_PASSWORD: get('DB_PASSWORD', ''),
  DB_NAME: get('DB_NAME', 'mamage')
};
