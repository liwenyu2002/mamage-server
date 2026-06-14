const path = require('path');
const keys = require('../config/keys');

let COS = null;
let client = null;

function getBucket() {
  return keys.COS_BUCKET || null;
}

function getRegion() {
  return keys.COS_REGION || null;
}

function getBaseUrl() {
  const bucket = getBucket();
  const region = getRegion();
  const configured = keys.COS_BASE_URL || keys.UPLOAD_BASE_URL || null;
  if (configured) return String(configured).replace(/\/+$/, '');
  if (bucket && region) return `https://${bucket}.cos.${region}.myqcloud.com`;
  return null;
}

function isConfigured() {
  return Boolean(keys.COS_SECRET_ID && keys.COS_SECRET_KEY && getBucket() && getRegion());
}

function ensureClient() {
  if (client) return client;
  if (!isConfigured()) return null;
  if (!COS) {
    try {
      COS = require('cos-nodejs-sdk-v5');
    } catch (err) {
      console.warn('[cos_storage] cos-nodejs-sdk-v5 not available:', err && err.message ? err.message : err);
      return null;
    }
  }
  client = new COS({
    SecretId: keys.COS_SECRET_ID,
    SecretKey: keys.COS_SECRET_KEY,
  });
  return client;
}

function normalizeKey(key) {
  return String(key || '').trim().replace(/^\/+/, '');
}

function objectUrlForKey(key) {
  const base = getBaseUrl();
  const normalized = normalizeKey(key);
  if (!base || !normalized) return null;
  return `${base}/${normalized.split('/').map(encodeURIComponent).join('/')}`;
}

function knownStorageHosts() {
  const hosts = new Set();
  const bucket = getBucket();
  const region = getRegion();
  [keys.COS_BASE_URL, keys.UPLOAD_BASE_URL, getBaseUrl()].forEach((raw) => {
    if (!raw) return;
    try {
      hosts.add(new URL(raw).host.toLowerCase());
    } catch (e) {
      // ignore
    }
  });
  if (bucket && region) {
    hosts.add(`${bucket}.cos.${region}.myqcloud.com`.toLowerCase());
    hosts.add(`${bucket}.cos.${region}.tencentcos.cn`.toLowerCase());
  }
  return hosts;
}

function keyFromUrlOrPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      if (!knownStorageHosts().has(u.host.toLowerCase())) return null;
      return normalizeKey(decodeURIComponent(u.pathname || ''));
    } catch (e) {
      return null;
    }
  }
  return normalizeKey(raw);
}

function uploadBuffer(key, buffer, options = {}) {
  const cos = ensureClient();
  if (!cos) return Promise.reject(new Error('COS client not configured'));
  const normalized = normalizeKey(key);
  return new Promise((resolve, reject) => {
    cos.putObject({
      Bucket: getBucket(),
      Region: getRegion(),
      Key: normalized,
      Body: buffer,
      ContentLength: buffer.length,
      ContentType: options.contentType || undefined,
      CacheControl: options.cacheControl || process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable',
    }, (err, data) => {
      if (err) return reject(err);
      resolve({ key: normalized, url: objectUrlForKey(normalized), data });
    });
  });
}

function signedPutUrl(key, options = {}) {
  const cos = ensureClient();
  if (!cos) return Promise.reject(new Error('COS client not configured'));
  const normalized = normalizeKey(key);
  return new Promise((resolve, reject) => {
    cos.getObjectUrl({
      Bucket: getBucket(),
      Region: getRegion(),
      Key: normalized,
      Method: 'PUT',
      Sign: true,
      Expires: Number(options.expires || process.env.COS_SIGNED_UPLOAD_EXPIRES_SECONDS || 900),
      Headers: options.headers || undefined,
    }, (err, data) => {
      if (err) return reject(err);
      resolve({
        key: normalized,
        signedUrl: data && data.Url,
        publicUrl: objectUrlForKey(normalized),
        expiresIn: Number(options.expires || process.env.COS_SIGNED_UPLOAD_EXPIRES_SECONDS || 900),
      });
    });
  });
}

function deleteObjects(keysToDelete) {
  const cos = ensureClient();
  if (!cos) return Promise.resolve({ deleted: [], errors: [], skipped: keysToDelete || [] });
  const keys = Array.from(new Set((keysToDelete || []).map(normalizeKey).filter(Boolean)));
  if (!keys.length) return Promise.resolve({ deleted: [], errors: [], skipped: [] });

  const chunks = [];
  for (let i = 0; i < keys.length; i += 1000) chunks.push(keys.slice(i, i + 1000));

  return chunks.reduce(async (prev, chunk) => {
    const acc = await prev;
    try {
      const result = await new Promise((resolve, reject) => {
        cos.deleteMultipleObject({
          Bucket: getBucket(),
          Region: getRegion(),
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: false,
          Headers: {},
        }, (err, data) => {
          if (err) return reject(err);
          resolve(data || {});
        });
      });
      const deleted = (result.Deleted || []).map((x) => x && x.Key).filter(Boolean);
      const errors = (result.Error || []).filter(Boolean);
      acc.deleted.push(...(deleted.length ? deleted : chunk));
      acc.errors.push(...errors);
    } catch (err) {
      acc.errors.push({ keys: chunk, message: err && err.message ? err.message : String(err) });
    }
    return acc;
  }, Promise.resolve({ deleted: [], errors: [], skipped: [] }));
}

function deleteObjectsForPhotoRows(rows) {
  const keys = [];
  for (const row of rows || []) {
    const urlKey = keyFromUrlOrPath(row.url);
    const thumbKey = keyFromUrlOrPath(row.thumbUrl || row.thumb_url);
    if (urlKey) keys.push(urlKey);
    if (thumbKey) keys.push(thumbKey);
  }
  return deleteObjects(keys);
}

function extFromFilenameOrMime(filename, mimeType, fallback = '.jpg') {
  const fromName = path.extname(String(filename || '')).toLowerCase();
  if (fromName && /^[.][a-z0-9]{2,8}$/.test(fromName)) return fromName;
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') return '.jpg';
  if (mime === 'image/png') return '.png';
  if (mime === 'image/webp') return '.webp';
  if (mime === 'image/gif') return '.gif';
  if (mime === 'image/heic') return '.heic';
  if (mime === 'image/heif') return '.heif';
  return fallback;
}

module.exports = {
  deleteObjects,
  deleteObjectsForPhotoRows,
  ensureClient,
  extFromFilenameOrMime,
  getBaseUrl,
  getBucket,
  getRegion,
  isConfigured,
  keyFromUrlOrPath,
  normalizeKey,
  objectUrlForKey,
  signedPutUrl,
  uploadBuffer,
};
