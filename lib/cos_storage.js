const fs = require('fs');
const path = require('path');
const {
  DeleteObjectsCommand,
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { Upload } = require('@aws-sdk/lib-storage');
const keys = require('../config/keys');

let client = null;

function trimBaseUrl(value) {
  const raw = String(value || '').trim();
  return raw ? raw.replace(/\/+$/, '') : null;
}

function parseUrl(value) {
  try {
    return value ? new URL(value) : null;
  } catch (e) {
    return null;
  }
}

function parseBoolean(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (['1', 'true', 'yes', 'y', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(raw)) return false;
  return null;
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch (e) {
    return value;
  }
}

function getBucket() {
  return keys.COS_BUCKET || null;
}

function getRegion() {
  return keys.COS_REGION || 'us-east-1';
}

function getEndpointUrl() {
  const configured = trimBaseUrl(keys.COS_BASE_URL);
  if (configured) return configured;

  const bucket = getBucket();
  const region = getRegion();
  if (bucket && region) return `https://${bucket}.cos.${region}.myqcloud.com`;
  return null;
}

function getPublicBaseUrl() {
  const configured = trimBaseUrl(keys.UPLOAD_BASE_URL);
  if (configured) return configured;
  return getEndpointUrl();
}

function getBaseUrl() {
  return getPublicBaseUrl();
}

function shouldForcePathStyle() {
  const explicit = parseBoolean(process.env.COS_FORCE_PATH_STYLE);
  if (explicit !== null) return explicit;

  const endpoint = parseUrl(getEndpointUrl());
  const bucket = String(getBucket() || '').toLowerCase();
  if (!endpoint || !bucket) return true;

  const host = endpoint.hostname.toLowerCase();
  return !host.includes(bucket);
}

function shouldPublicUrlIncludeBucket(baseUrl) {
  const explicit = parseBoolean(process.env.UPLOAD_BASE_URL_INCLUDE_BUCKET);
  if (explicit !== null) return explicit;

  const bucket = String(getBucket() || '').toLowerCase();
  const parsed = parseUrl(baseUrl);
  if (!bucket || !parsed) return false;

  const uploadBase = trimBaseUrl(keys.UPLOAD_BASE_URL);
  if (uploadBase && trimBaseUrl(baseUrl) === uploadBase) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (host.includes(bucket)) return false;

  const pathParts = normalizeKey(safeDecode(parsed.pathname || '')).toLowerCase().split('/').filter(Boolean);
  if (pathParts.includes(bucket)) return false;

  return shouldForcePathStyle();
}

function isConfigured() {
  return Boolean(keys.COS_SECRET_ID && keys.COS_SECRET_KEY && getBucket() && getEndpointUrl());
}

function ensureClient() {
  if (client) return client;
  if (!isConfigured()) return null;

  client = new S3Client({
    endpoint: getEndpointUrl(),
    region: getRegion(),
    credentials: {
      accessKeyId: keys.COS_SECRET_ID,
      secretAccessKey: keys.COS_SECRET_KEY,
    },
    forcePathStyle: shouldForcePathStyle(),
  });
  return client;
}

function normalizeKey(key) {
  return String(key || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/');
}

function isSafeKey(key) {
  const normalized = normalizeKey(key);
  if (!normalized) return false;
  if (/[\0-\x1F\x7F]/.test(normalized)) return false;
  return !normalized.split('/').some((part) => part === '..');
}

function encodeKeyPath(key) {
  return normalizeKey(key)
    .split('/')
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function objectUrlForKey(key) {
  const base = getPublicBaseUrl();
  const normalized = normalizeKey(key);
  if (!base || !normalized) return null;

  const encoded = encodeKeyPath(normalized);
  if (!encoded) return null;

  const bucketPrefix = shouldPublicUrlIncludeBucket(base) ? `/${encodeURIComponent(getBucket())}` : '';
  // 惰性引用 db 的签名助手，避免只用 cos_storage 的脚本提前初始化 MySQL pool
  const { signMediaQuery } = require('../db');
  return `${base}${bucketPrefix}/${encoded}${signMediaQuery(`/${normalized}`)}`;
}

function knownStorageHosts() {
  const hosts = new Set();
  const bucket = getBucket();
  const region = getRegion();

  [
    keys.COS_BASE_URL,
    keys.UPLOAD_BASE_URL,
    getEndpointUrl(),
    getPublicBaseUrl(),
  ].forEach((raw) => {
    const parsed = parseUrl(raw);
    if (parsed) hosts.add(parsed.host.toLowerCase());
  });

  if (bucket && region) {
    hosts.add(`${bucket}.cos.${region}.myqcloud.com`.toLowerCase());
    hosts.add(`${bucket}.cos.${region}.tencentcos.cn`.toLowerCase());
  }

  return hosts;
}

function stripKnownBasePath(key, baseUrl) {
  const parsed = parseUrl(baseUrl);
  if (!parsed) return key;

  const basePath = normalizeKey(safeDecode(parsed.pathname || ''));
  if (!basePath) return key;

  const normalized = normalizeKey(key);
  if (normalized === basePath) return '';
  if (normalized.startsWith(`${basePath}/`)) return normalizeKey(normalized.slice(basePath.length + 1));
  return normalized;
}

function stripBucketPrefix(key) {
  const bucket = normalizeKey(getBucket() || '');
  const normalized = normalizeKey(key);
  if (!bucket) return normalized;
  if (normalized === bucket) return '';
  if (normalized.startsWith(`${bucket}/`)) return normalizeKey(normalized.slice(bucket.length + 1));
  return normalized;
}

function uploadsKeyFromPath(pathname) {
  const normalized = normalizeKey(safeDecode(pathname || ''));
  const marker = 'uploads/';
  const markerIndex = normalized.indexOf(marker);
  if (markerIndex === -1) return null;
  return normalizeKey(normalized.slice(markerIndex));
}

function keyFromUrlOrPath(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^https?:\/\//i.test(raw)) {
    const parsed = parseUrl(raw);
    if (!parsed) return null;
    if (!knownStorageHosts().has(parsed.host.toLowerCase())) return uploadsKeyFromPath(parsed.pathname);

    let key = normalizeKey(safeDecode(parsed.pathname || ''));
    [keys.UPLOAD_BASE_URL, keys.COS_BASE_URL, getPublicBaseUrl(), getEndpointUrl()].forEach((baseUrl) => {
      key = stripKnownBasePath(key, baseUrl);
    });
    return stripBucketPrefix(key);
  }

  return stripBucketPrefix(normalizeKey(safeDecode(raw)));
}

function headerValue(headers, name) {
  const target = String(name || '').toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) return value;
  }
  return undefined;
}

async function uploadBuffer(key, buffer, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');

  const normalized = normalizeKey(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');

  const result = await s3.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: normalized,
    Body: buffer,
    ContentLength: buffer.length,
    ContentType: options.contentType || undefined,
    CacheControl: options.cacheControl || process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable',
  }));

  return { key: normalized, url: objectUrlForKey(normalized), data: result };
}

async function uploadFile(key, filePath, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');

  const normalized = normalizeKey(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');

  const stat = await fs.promises.stat(filePath);
  const result = await s3.send(new PutObjectCommand({
    Bucket: getBucket(),
    Key: normalized,
    Body: fs.createReadStream(filePath),
    ContentLength: Number(options.contentLength) || stat.size,
    ContentType: options.contentType || undefined,
    CacheControl: options.cacheControl || process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable',
  }));

  return { key: normalized, url: objectUrlForKey(normalized), data: result };
}

async function signedPutUrl(key, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');

  const normalized = normalizeKey(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');

  const headers = options.headers || {};
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: normalized,
    ContentType: headerValue(headers, 'content-type') || undefined,
    CacheControl: headerValue(headers, 'cache-control') || process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable',
  });
  const expiresIn = Number(options.expires || process.env.COS_SIGNED_UPLOAD_EXPIRES_SECONDS || 900);

  return {
    key: normalized,
    signedUrl: await getSignedUrl(s3, command, { expiresIn }),
    publicUrl: objectUrlForKey(normalized),
    expiresIn,
  };
}

async function createMultipartUpload(key, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');
  const normalized = normalizeKey(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');
  const result = await s3.send(new CreateMultipartUploadCommand({
    Bucket: getBucket(),
    Key: normalized,
    ContentType: options.contentType || undefined,
    CacheControl: options.cacheControl || process.env.UPLOAD_CACHE_CONTROL || 'public, max-age=31536000, immutable',
  }));
  if (!result || !result.UploadId) throw new Error('S3 multipart upload did not return UploadId');
  return { key: normalized, uploadId: result.UploadId };
}

async function signedUploadPartUrl(key, uploadId, partNumber, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');
  const normalized = normalizeKey(key);
  const number = Number(partNumber);
  if (!isSafeKey(normalized) || !uploadId || !Number.isInteger(number) || number < 1 || number > 10000) {
    throw new Error('Invalid multipart upload parameters');
  }
  const expiresIn = Math.max(60, Number(options.expires || process.env.COS_SIGNED_UPLOAD_EXPIRES_SECONDS || 900));
  return {
    key: normalized,
    partNumber: number,
    signedUrl: await getSignedUrl(s3, new UploadPartCommand({
      Bucket: getBucket(), Key: normalized, UploadId: String(uploadId), PartNumber: number,
    }), { expiresIn }),
    expiresIn,
  };
}

async function completeMultipartUpload(key, uploadId, parts) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');
  const normalized = normalizeKey(key);
  const normalizedParts = Array.from(parts || []).map((part) => ({
    ETag: String(part && (part.ETag || part.etag) || '').trim(),
    PartNumber: Number(part && (part.PartNumber || part.partNumber)),
  })).filter((part) => part.ETag && Number.isInteger(part.PartNumber) && part.PartNumber > 0 && part.PartNumber <= 10000)
    .sort((a, b) => a.PartNumber - b.PartNumber);
  if (!isSafeKey(normalized) || !uploadId || !normalizedParts.length) throw new Error('Invalid multipart completion parameters');
  return s3.send(new CompleteMultipartUploadCommand({
    Bucket: getBucket(), Key: normalized, UploadId: String(uploadId),
    MultipartUpload: { Parts: normalizedParts },
  }));
}

async function abortMultipartUpload(key, uploadId) {
  const s3 = ensureClient();
  if (!s3) return null;
  const normalized = normalizeKey(key);
  if (!isSafeKey(normalized) || !uploadId) return null;
  return s3.send(new AbortMultipartUploadCommand({ Bucket: getBucket(), Key: normalized, UploadId: String(uploadId) }));
}

function buildAttachmentDisposition(filename) {
  const raw = String(filename || 'download').replace(/[\r\n"]/g, '_').slice(0, 180);
  const ascii = raw.replace(/[^\x20-\x7E]/g, '_') || 'download';
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

async function signedGetUrl(key, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');

  const normalized = keyFromUrlOrPath(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');

  const input = { Bucket: getBucket(), Key: normalized };
  if (options.downloadName) input.ResponseContentDisposition = buildAttachmentDisposition(options.downloadName);
  if (options.contentType) input.ResponseContentType = options.contentType;
  const expiresIn = Math.max(60, Number(options.expires || process.env.COS_SIGNED_READ_EXPIRES_SECONDS || 900));

  return {
    key: normalized,
    signedUrl: await getSignedUrl(s3, new GetObjectCommand(input), { expiresIn }),
    expiresIn,
  };
}

async function uploadStream(key, stream, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');

  const normalized = normalizeKey(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');

  const uploader = new Upload({
    client: s3,
    queueSize: Math.max(1, Math.min(4, Number(options.queueSize) || 2)),
    partSize: Math.max(5 * 1024 * 1024, Number(options.partSize) || 8 * 1024 * 1024),
    leavePartsOnError: false,
    params: {
      Bucket: getBucket(),
      Key: normalized,
      Body: stream,
      ContentType: options.contentType || 'application/octet-stream',
      CacheControl: options.cacheControl || 'private, max-age=0, no-store',
    },
  });
  if (typeof options.onProgress === 'function') uploader.on('httpUploadProgress', options.onProgress);
  const signal = options.signal;
  const abortUpload = () => {
    try { uploader.abort(); } catch (e) { /* upload may already be complete */ }
  };
  if (signal && typeof signal.addEventListener === 'function') {
    if (signal.aborted) abortUpload();
    else signal.addEventListener('abort', abortUpload, { once: true });
  }
  try {
    const result = await uploader.done();
    return { key: normalized, url: objectUrlForKey(normalized), data: result };
  } finally {
    if (signal && typeof signal.removeEventListener === 'function') signal.removeEventListener('abort', abortUpload);
  }
}

async function putBucketCors(origins, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');
  const allowedOrigins = Array.from(new Set((origins || []).map((value) => String(value || '').trim()).filter(Boolean)));
  if (!allowedOrigins.length) throw new Error('At least one CORS origin is required');

  return s3.send(new PutBucketCorsCommand({
    Bucket: getBucket(),
    CORSConfiguration: {
      CORSRules: [{
        AllowedOrigins: allowedOrigins,
        AllowedMethods: ['GET', 'HEAD', 'PUT'],
        AllowedHeaders: ['*'],
        ExposeHeaders: options.exposeHeaders || [
          'Accept-Ranges',
          'Content-Disposition',
          'Content-Length',
          'Content-Range',
          'Content-Type',
          'ETag',
        ],
        MaxAgeSeconds: Math.max(300, Number(options.maxAgeSeconds) || 3600),
      }],
    },
  }));
}

async function getObject(key, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');

  const normalized = keyFromUrlOrPath(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');

  const input = { Bucket: getBucket(), Key: normalized };
  if (options.range) input.Range = options.range;
  if (options.ifNoneMatch) input.IfNoneMatch = options.ifNoneMatch;
  if (options.ifModifiedSince) {
    const date = new Date(options.ifModifiedSince);
    if (!Number.isNaN(date.getTime())) input.IfModifiedSince = date;
  }

  return s3.send(new GetObjectCommand(input));
}

async function headObject(key, options = {}) {
  const s3 = ensureClient();
  if (!s3) throw new Error('S3 client not configured');

  const normalized = keyFromUrlOrPath(key);
  if (!isSafeKey(normalized)) throw new Error('Invalid object key');

  const input = { Bucket: getBucket(), Key: normalized };
  if (options.ifNoneMatch) input.IfNoneMatch = options.ifNoneMatch;
  if (options.ifModifiedSince) {
    const date = new Date(options.ifModifiedSince);
    if (!Number.isNaN(date.getTime())) input.IfModifiedSince = date;
  }

  return s3.send(new HeadObjectCommand(input));
}

async function deleteObjects(keysToDelete) {
  const s3 = ensureClient();
  if (!s3) return { deleted: [], errors: [], skipped: keysToDelete || [] };

  const objectKeys = Array.from(new Set((keysToDelete || []).map(keyFromUrlOrPath).filter((key) => key && isSafeKey(key))));
  if (!objectKeys.length) return { deleted: [], errors: [], skipped: [] };

  const acc = { deleted: [], errors: [], skipped: [] };
  for (let i = 0; i < objectKeys.length; i += 1000) {
    const chunk = objectKeys.slice(i, i + 1000);
    try {
      const result = await s3.send(new DeleteObjectsCommand({
        Bucket: getBucket(),
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: false,
        },
      }));
      const deleted = (result.Deleted || []).map((item) => item && item.Key).filter(Boolean);
      const errors = (result.Errors || result.Error || []).filter(Boolean);
      acc.deleted.push(...(deleted.length ? deleted : chunk));
      acc.errors.push(...errors);
    } catch (err) {
      acc.errors.push({ keys: chunk, message: err && err.message ? err.message : String(err) });
    }
  }

  return acc;
}

function deleteObjectsForPhotoRows(rows) {
  const keysToDelete = [];
  for (const row of rows || []) {
    const urlKey = keyFromUrlOrPath(row.url);
    const thumbKey = keyFromUrlOrPath(row.thumbUrl || row.thumb_url);
    const playbackKey = keyFromUrlOrPath(row.playbackUrl || row.playback_url);
    if (urlKey) keysToDelete.push(urlKey);
    if (thumbKey) keysToDelete.push(thumbKey);
    if (playbackKey) keysToDelete.push(playbackKey);
  }
  return deleteObjects(keysToDelete);
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
  if (mime === 'video/mp4') return '.mp4';
  if (mime === 'video/quicktime') return '.mov';
  if (mime === 'video/webm') return '.webm';
  if (mime === 'video/ogg') return '.ogv';
  return fallback;
}

module.exports = {
  buildAttachmentDisposition,
  deleteObjects,
  deleteObjectsForPhotoRows,
  ensureClient,
  extFromFilenameOrMime,
  getBaseUrl,
  getBucket,
  getEndpointUrl,
  getObject,
  getPublicBaseUrl,
  getRegion,
  headObject,
  uploadFile,
  isConfigured,
  isSafeKey,
  keyFromUrlOrPath,
  normalizeKey,
  objectUrlForKey,
  putBucketCors,
  signedGetUrl,
  signedPutUrl,
  createMultipartUpload,
  signedUploadPartUrl,
  completeMultipartUpload,
  abortMultipartUpload,
  uploadBuffer,
  uploadStream,
};
