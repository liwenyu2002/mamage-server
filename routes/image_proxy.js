const express = require('express');
const cosStorage = require('../lib/cos_storage');

const router = express.Router();

const DEFAULT_CACHE_CONTROL = process.env.IMAGE_PROXY_CACHE_CONTROL || 'public, max-age=31536000, immutable';
const CONTENT_TYPE_BY_EXT = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
  ['.heic', 'image/heic'],
  ['.heif', 'image/heif'],
  ['.avif', 'image/avif'],
]);

function normalizeProxyKey(req) {
  const pathKey = String(req.path || '').replace(/^\/+/, '');
  return cosStorage.keyFromUrlOrPath(pathKey);
}

function isValidRangeHeader(value) {
  if (!value) return true;
  const raw = String(value).trim();
  return /^bytes=\d*-\d*$/.test(raw);
}

function inferContentType(key, object) {
  const current = String(object.ContentType || '').trim().toLowerCase();
  if (current && current !== 'application/octet-stream') return object.ContentType;
  const match = String(key || '').toLowerCase().match(/\.[a-z0-9]+$/);
  return (match && CONTENT_TYPE_BY_EXT.get(match[0])) || object.ContentType || 'application/octet-stream';
}

function setObjectHeaders(res, key, object) {
  res.setHeader('Content-Type', inferContentType(key, object));
  if (object.ContentLength !== undefined && object.ContentLength !== null) {
    res.setHeader('Content-Length', String(object.ContentLength));
  }
  if (object.CacheControl) {
    res.setHeader('Cache-Control', object.CacheControl);
  } else {
    res.setHeader('Cache-Control', DEFAULT_CACHE_CONTROL);
  }
  if (object.ETag) res.setHeader('ETag', object.ETag);
  if (object.LastModified) res.setHeader('Last-Modified', new Date(object.LastModified).toUTCString());
  if (object.ContentRange) res.setHeader('Content-Range', object.ContentRange);
  if (object.ContentDisposition) res.setHeader('Content-Disposition', object.ContentDisposition);
  if (object.ContentEncoding) res.setHeader('Content-Encoding', object.ContentEncoding);
  res.setHeader('Accept-Ranges', object.AcceptRanges || 'bytes');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

function statusFromStorageError(err) {
  const metadataStatus = err && err.$metadata && err.$metadata.httpStatusCode;
  if (metadataStatus) return metadataStatus;

  const name = err && err.name;
  if (name === 'NoSuchKey' || name === 'NotFound') return 404;
  if (name === 'NotModified') return 304;
  if (name === 'PreconditionFailed') return 412;
  if (name === 'InvalidRange' || name === 'RequestedRangeNotSatisfiable') return 416;
  return 502;
}

router.use(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range,If-None-Match,If-Modified-Since');
    return res.status(204).end();
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD, OPTIONS');
    return res.status(405).end();
  }

  const key = normalizeProxyKey(req);
  if (!key || !cosStorage.isSafeKey(key)) return res.status(400).end();

  if (!cosStorage.isConfigured()) {
    return res.status(503).json({ error: 'S3_NOT_CONFIGURED' });
  }

  const range = req.get('range');
  if (!isValidRangeHeader(range)) return res.status(416).end();

  const requestOptions = {
    ifNoneMatch: req.get('if-none-match') || undefined,
    ifModifiedSince: req.get('if-modified-since') || undefined,
  };
  if (range && req.method === 'GET') requestOptions.range = range;

  try {
    const object = req.method === 'HEAD'
      ? await cosStorage.headObject(key, requestOptions)
      : await cosStorage.getObject(key, requestOptions);

    setObjectHeaders(res, key, object);
    const status = object && object.$metadata && object.$metadata.httpStatusCode === 206 ? 206 : 200;
    res.status(status);

    if (req.method === 'HEAD') return res.end();

    const stream = object.Body;
    if (!stream || typeof stream.pipe !== 'function') return res.end();

    res.on('close', () => {
      if (!res.writableEnded && typeof stream.destroy === 'function') stream.destroy();
    });
    stream.on('error', (err) => {
      console.error('[image_proxy] stream error:', err && err.message ? err.message : err);
      if (!res.headersSent) return res.status(502).end();
      res.destroy(err);
    });
    return stream.pipe(res);
  } catch (err) {
    const status = statusFromStorageError(err);
    if (status === 304) return res.status(304).end();
    if (status === 404 || status === 412 || status === 416) return res.status(status).end();

    console.error('[image_proxy]', err && err.stack ? err.stack : err);
    return res.status(status).end();
  }
});

module.exports = router;
