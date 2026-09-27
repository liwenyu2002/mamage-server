const crypto = require('crypto');
const { pool, buildUploadUrl, UPLOAD_BASE_URL } = require('../db');
const cosStorage = require('./cos_storage');
const { requirePhotoAccess } = require('./workspace_access');

const SECRET = process.env.MEDIA_URL_SECRET || process.env.JWT_SECRET || '';
const TTL_SECONDS = Math.max(60, Math.min(24 * 3600,
  Number(process.env.WORKSPACE_MEDIA_URL_TTL_SECONDS) || 4 * 3600));

function unitIdFromKey(key) {
  const match = /^uploads\/units\/(\d+)\//.exec(String(key || ''));
  return match ? Number(match[1]) : null;
}

function signPayload(payload) {
  if (!SECRET) throw new Error('MEDIA_URL_SECRET is required for private media');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', SECRET).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyPayload(token) {
  if (!SECRET || typeof token !== 'string' || token.length > 1024) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(parts[0]).digest('base64url');
  const left = Buffer.from(parts[1]);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  let payload;
  try { payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
  catch (_) { return null; }
  if (payload.v !== 1 || !Number.isSafeInteger(payload.e) || payload.e < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

function buildMediaUrl(path, context = null) {
  const url = buildUploadUrl(path);
  if (!url) return url;
  if (process.env.ORGANIZATION_UNITS_ACTIVE !== '1') return url;
  if (!context || !Number(context.photoId)) return url;
  const key = cosStorage.keyFromUrlOrPath(path);
  const unitId = unitIdFromKey(key);
  if (!unitId) return url;
  const proxyBase = String(UPLOAD_BASE_URL || '').replace(/\/+$/, '');
  if (!/\/api\/image$/i.test(proxyBase)) {
    throw new Error('UPLOAD_BASE_URL must use /api/image for private media');
  }
  const proxyUrl = buildUploadUrl(`/${key}`);
  const payload = {
    v: 1, k: key, w: unitId, p: Number(context.photoId),
    e: Math.floor(Date.now() / 1000) + TTL_SECONDS,
  };
  if (context.shareId) {
    payload.t = 'share';
    payload.sh = Number(context.shareId);
  } else if (context.userId) {
    payload.t = 'user';
    payload.u = Number(context.userId);
  } else {
    return url;
  }
  const separator = proxyUrl.includes('?') ? '&' : '?';
  return `${proxyUrl}${separator}ma=${signPayload(payload)}`;
}

async function authorizeMediaKey(key, token, db = pool) {
  const unitId = unitIdFromKey(key);
  if (!unitId) return true;
  if (process.env.ORGANIZATION_UNITS_ACTIVE !== '1') return false;
  const payload = verifyPayload(token);
  if (!payload || payload.k !== key || payload.w !== unitId) return false;
  if (payload.t === 'service') return true;
  if (!Number.isSafeInteger(payload.p)) return false;
  const [rows] = await db.query(
    `SELECT id, organization_id, unit_id, project_id, type,
            url, thumb_url, public_download_url, playback_url
     FROM photos WHERE id = ? LIMIT 1`, [payload.p]
  );
  const photo = rows[0];
  if (!photo || Number(photo.unit_id) !== unitId) return false;
  const matchingField = ['url', 'thumb_url', 'public_download_url', 'playback_url']
    .find((field) => photo[field] && cosStorage.keyFromUrlOrPath(photo[field]) === key);
  if (!matchingField) return false;

  if (payload.t === 'user' && Number.isSafeInteger(payload.u)) {
    const [users] = await db.query('SELECT id, role, organization_id FROM users WHERE id = ? LIMIT 1', [payload.u]);
    const user = users[0];
    if (!user || Number(user.organization_id) !== Number(photo.organization_id)) return false;
    const req = { user, get() { return undefined; } };
    try { await requirePhotoAccess(req, payload.p, 'read', db); return true; }
    catch (_) { return false; }
  }

  if (payload.t === 'share' && Number.isSafeInteger(payload.sh)) {
    if (matchingField === 'url') return false;
    if (photo.type === 'video' && matchingField === 'public_download_url') return false;
    const [shares] = await db.query(
      `SELECT id, share_type, project_id, sync_mode FROM share_links
       WHERE id = ? AND organization_id = ? AND unit_id = ?
         AND revoked_at IS NULL AND expires_at > NOW() LIMIT 1`,
      [payload.sh, photo.organization_id, unitId]
    );
    const share = shares[0];
    if (!share) return false;
    if (share.share_type === 'project' && Number(share.project_id) !== Number(photo.project_id)) return false;
    if (share.share_type === 'project' && share.sync_mode === 'automatic') return true;
    const [items] = await db.query(
      'SELECT 1 FROM share_link_items WHERE share_id = ? AND photo_id = ? LIMIT 1',
      [share.id, photo.id]
    );
    return items.length > 0;
  }
  return false;
}

module.exports = { unitIdFromKey, buildMediaUrl, authorizeMediaKey, verifyPayload };
