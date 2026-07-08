const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const keys = require('../config/keys');

const SUPPORTED_PURPOSES = new Set(['register']);

function toPositiveInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

const CODE_TTL_SECONDS = toPositiveInt(process.env.EMAIL_CODE_TTL_SECONDS, 10 * 60, 60, 60 * 60);
const SEND_COOLDOWN_SECONDS = toPositiveInt(process.env.EMAIL_CODE_COOLDOWN_SECONDS, 60, 15, 10 * 60);
const MAX_SENDS_PER_HOUR = toPositiveInt(process.env.EMAIL_CODE_MAX_PER_HOUR, 5, 1, 60);
const MAX_VERIFY_ATTEMPTS = toPositiveInt(process.env.EMAIL_CODE_MAX_ATTEMPTS, 5, 1, 20);

let transporter = null;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizePurpose(purpose) {
  const normalized = String(purpose || 'register').trim().toLowerCase();
  if (!SUPPORTED_PURPOSES.has(normalized)) {
    const err = new Error('Unsupported email verification purpose');
    err.code = 'UNSUPPORTED_EMAIL_PURPOSE';
    throw err;
  }
  return normalized;
}

function getHashSecret() {
  const secret = process.env.EMAIL_CODE_SECRET || keys.JWT_SECRET;
  if (!secret) {
    const err = new Error('EMAIL_CODE_SECRET or JWT_SECRET is required');
    err.code = 'EMAIL_CODE_SECRET_MISSING';
    throw err;
  }
  return secret;
}

function hashCode(email, purpose, code) {
  return crypto
    .createHmac('sha256', getHashSecret())
    .update(`${purpose}:${email}:${String(code).trim()}`)
    .digest('hex');
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

function parseBoolean(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return undefined;
}

function getTransporter() {
  if (transporter) return transporter;

  const host = String(process.env.SMTP_HOST || '').trim();
  const user = String(process.env.SMTP_USER || '').trim();
  const pass = String(process.env.SMTP_PASS || '');
  const port = Number(process.env.SMTP_PORT || 465);
  const secureEnv = parseBoolean(process.env.SMTP_SECURE);
  const secure = secureEnv === undefined ? port === 465 : secureEnv;

  if (!host || !user || !pass) {
    const err = new Error('SMTP_HOST/SMTP_USER/SMTP_PASS is required');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });

  return transporter;
}

function formatFromAddress() {
  return String(process.env.SMTP_FROM || process.env.SMTP_USER || '').trim();
}

function buildMail({ email, code, purpose }) {
  const ttlMinutes = Math.ceil(CODE_TTL_SECONDS / 60);
  const title = purpose === 'register' ? 'MaMage 注册验证码' : 'MaMage 邮箱验证码';
  const text = [
    `你的 MaMage 验证码是：${code}`,
    `验证码 ${ttlMinutes} 分钟内有效。`,
    '如果不是你本人操作，可以忽略这封邮件。',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;line-height:1.7;color:#111827;">
      <h2 style="margin:0 0 12px;">${title}</h2>
      <p style="margin:0 0 12px;">你的验证码：</p>
      <div style="font-size:30px;font-weight:800;letter-spacing:8px;margin:12px 0 18px;">${code}</div>
      <p style="margin:0;color:#4b5563;">验证码 ${ttlMinutes} 分钟内有效。若不是你本人操作，可以忽略这封邮件。</p>
    </div>
  `;

  return {
    from: formatFromAddress(),
    to: email,
    subject: title,
    text,
    html,
  };
}

function getRequestIp(req) {
  const forwarded = String(req.get?.('x-forwarded-for') || '').split(',')[0].trim();
  return forwarded || req.ip || req.socket?.remoteAddress || null;
}

async function cleanupExpiredCodes() {
  try {
    await pool.query(
      'DELETE FROM email_verification_codes WHERE expires_at < DATE_SUB(NOW(), INTERVAL 2 DAY) OR (consumed_at IS NOT NULL AND consumed_at < DATE_SUB(NOW(), INTERVAL 2 DAY))'
    );
  } catch (err) {
    console.warn('[email_verification.cleanup]', err && err.message ? err.message : err);
  }
}

async function sendVerificationCode({ email, purpose = 'register', requestIp = null }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPurpose = normalizePurpose(purpose);
  await cleanupExpiredCodes();

  const [recentRows] = await pool.query(
    'SELECT id, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS age_seconds FROM email_verification_codes WHERE email = ? AND purpose = ? ORDER BY id DESC LIMIT 1',
    [normalizedEmail, normalizedPurpose]
  );
  const latest = recentRows && recentRows[0];
  if (latest && Number(latest.age_seconds) >= 0 && Number(latest.age_seconds) < SEND_COOLDOWN_SECONDS) {
    const err = new Error('Please wait before requesting another verification code');
    err.code = 'EMAIL_CODE_COOLDOWN';
    err.cooldownSeconds = SEND_COOLDOWN_SECONDS - Number(latest.age_seconds);
    throw err;
  }

  const [countRows] = await pool.query(
    'SELECT COUNT(*) AS cnt FROM email_verification_codes WHERE email = ? AND purpose = ? AND created_at > DATE_SUB(NOW(), INTERVAL 1 HOUR)',
    [normalizedEmail, normalizedPurpose]
  );
  const sentLastHour = Number(countRows?.[0]?.cnt || 0);
  if (sentLastHour >= MAX_SENDS_PER_HOUR) {
    const err = new Error('Too many verification codes requested');
    err.code = 'EMAIL_CODE_RATE_LIMITED';
    throw err;
  }

  const code = generateCode();
  const codeHash = hashCode(normalizedEmail, normalizedPurpose, code);
  const expiresAt = new Date(Date.now() + CODE_TTL_SECONDS * 1000);

  const [result] = await pool.query(
    'INSERT INTO email_verification_codes (email, purpose, code_hash, request_ip, expires_at, created_at) VALUES (?, ?, ?, ?, ?, NOW())',
    [normalizedEmail, normalizedPurpose, codeHash, requestIp, expiresAt]
  );

  try {
    await getTransporter().sendMail(buildMail({ email: normalizedEmail, code, purpose: normalizedPurpose }));
  } catch (err) {
    try {
      await pool.query('DELETE FROM email_verification_codes WHERE id = ?', [result.insertId]);
    } catch (_) {}
    err.code = err.code || 'SMTP_SEND_FAILED';
    throw err;
  }

  return {
    email: normalizedEmail,
    expiresInSeconds: CODE_TTL_SECONDS,
    cooldownSeconds: SEND_COOLDOWN_SECONDS,
  };
}

function timingSafeHexEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch (_) {
    return false;
  }
}

async function verifyAndConsumeVerificationCode({ email, purpose = 'register', code }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedPurpose = normalizePurpose(purpose);
  const normalizedCode = String(code || '').trim();

  if (!/^\d{6}$/.test(normalizedCode)) {
    const err = new Error('Invalid verification code format');
    err.code = 'INVALID_EMAIL_CODE';
    throw err;
  }

  const [rows] = await pool.query(
    'SELECT id, code_hash, attempts FROM email_verification_codes WHERE email = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [normalizedEmail, normalizedPurpose]
  );

  if (!rows || rows.length === 0) {
    const err = new Error('Verification code expired or not found');
    err.code = 'EMAIL_CODE_EXPIRED';
    throw err;
  }

  const row = rows[0];
  if (Number(row.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    const err = new Error('Too many verification attempts');
    err.code = 'EMAIL_CODE_ATTEMPTS_EXCEEDED';
    throw err;
  }

  const expectedHash = hashCode(normalizedEmail, normalizedPurpose, normalizedCode);
  if (!timingSafeHexEqual(expectedHash, row.code_hash)) {
    const nextAttempts = Number(row.attempts || 0) + 1;
    const consumeSql = nextAttempts >= MAX_VERIFY_ATTEMPTS ? ', consumed_at = NOW()' : '';
    await pool.query(
      `UPDATE email_verification_codes SET attempts = ?${consumeSql} WHERE id = ?`,
      [nextAttempts, row.id]
    );
    const err = new Error('Invalid verification code');
    err.code = 'INVALID_EMAIL_CODE';
    throw err;
  }

  await pool.query('UPDATE email_verification_codes SET consumed_at = NOW(), attempts = attempts + 1 WHERE id = ?', [row.id]);
  return true;
}

async function verifySmtpTransport() {
  await getTransporter().verify();
  return true;
}

module.exports = {
  normalizeEmail,
  getRequestIp,
  sendVerificationCode,
  verifyAndConsumeVerificationCode,
  verifySmtpTransport,
};
