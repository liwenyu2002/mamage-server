// 直传代理通道（/api/upload/video/direct/*）集成测试：
// 用假 DB pool 与假对象存储替身驱动真实路由处理器，验证 HTTPS 页面自动协商
// proxy 传输、分片大小校验与 ETag 透传。不连真实 MySQL / S3。
const assert = require('assert');
const path = require('path');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'direct-video-proxy-test';
process.env.COS_SECRET_ID = 'test-id';
process.env.COS_SECRET_KEY = 'test-key';
process.env.COS_BUCKET = 'test-bucket';
process.env.COS_REGION = 'us-east-1';
process.env.COS_BASE_URL = 'http://10.1.131.207:8082';
process.env.COS_DIRECT_UPLOAD_ENABLED = '1';
process.env.VIDEO_PREVIEW_ENABLED = '0';
process.env.VIDEO_PLAYBACK_ENABLED = '0';
process.env.DIRECT_VIDEO_MULTIPART_THRESHOLD_MB = String(2048);
process.env.DIRECT_VIDEO_PART_SIZE_MB = String(32);
process.env.DIRECT_VIDEO_PROXY_PART_SIZE_MB = String(8);

// 假 DB pool：任何查询都返回最小结果集
const fakePool = {
  query: async (sql, params) => {
    if (/^INSERT INTO photos/i.test(String(sql).trim())) return [{ insertId: 4321 }, null];
    if (/SELECT role FROM users/i.test(sql)) return [[{ role: 'admin' }], null];
    if (/SELECT organization_id FROM users/i.test(sql)) return [[{ organization_id: 1 }], null];
    if (/role_permissions/i.test(sql)) return [[{ 1: 1 }], null];
    if (/^SELECT name FROM users/i.test(String(sql).trim())) return [{ name: 'Tester' }, null];
    if (/FOR UPDATE/i.test(sql)) return [[{ photo_ids: null }], null];
    return [[], null];
  },
  getConnection: async () => {
    const conn = {
      beginTransaction: async () => null,
      commit: async () => null,
      rollback: async () => null,
      release: () => null,
      query: fakePool.query,
    };
    return conn;
  },
};

// 假对象存储：记录调用并返回确定性 ETag
const uploadedParts = [];
const fakeStorage = {
  configured: true,
  endpointUrl: process.env.COS_BASE_URL,
  multipartUploads: 0,
  completedUploads: [],
  isConfigured: () => fakeStorage.configured,
  getEndpointUrl: () => fakeStorage.endpointUrl,
  normalizeKey: (key) => String(key || '').replace(/^\/+/, ''),
  extFromFilenameOrMime: (name, mime, fallback) => fallback || '.mp4',
  createMultipartUpload: async (key) => {
    fakeStorage.multipartUploads += 1;
    return { key, uploadId: `mpu-${fakeStorage.multipartUploads}` };
  },
  uploadPart: async (key, uploadId, partNumber, body) => {
    uploadedParts.push({ key, uploadId, partNumber, bytes: body.length });
    return { partNumber, etag: `"etag-${uploadId}-${partNumber}"` };
  },
  completeMultipartUpload: async (key, uploadId, parts) => {
    fakeStorage.completedUploads.push({ key, uploadId, parts });
    return { ok: true };
  },
  abortMultipartUpload: async () => null,
  deleteObjects: async (keys) => ({ deleted: keys || [], errors: [], skipped: [] }),
  headObject: async (key) => ({ ContentLength: fakeStorage.headSize || 0 }),
  signedPost: async (key) => ({ key, postUrl: `${fakeStorage.endpointUrl}/${key}`, fields: { key }, publicUrl: '', expiresIn: 900 }),
  signedUploadPartUrl: async (key, uploadId, partNumber) => ({ partNumber, signedUrl: `${fakeStorage.endpointUrl}/${key}?partNumber=${partNumber}&uploadId=${uploadId}`, expiresIn: 900 }),
};

// 在真实模块加载前注入替身
const dbPath = require.resolve(path.join(ROOT, 'db'));
const cosPath = require.resolve(path.join(ROOT, 'lib/cos_storage'));
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { pool: fakePool, buildUploadUrl: (rel) => `https://mamage.test${rel}` } };
require.cache[cosPath] = { id: cosPath, filename: cosPath, loaded: true, exports: fakeStorage };

const express = require('express');
const uploadRouter = require(path.join(ROOT, 'routes/upload.js'));

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '5m' });
}

function makeApp() {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use('/api/upload', uploadRouter);
  return app;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function call(server, method, url, { token, body, rawBody, headers = {} } = {}) {
  const port = server.address().port;
  const opts = { method, headers: { ...headers } };
  if (token) opts.headers.Authorization = `Bearer ${token}`;
  if (rawBody !== undefined) {
    opts.headers['Content-Type'] = 'application/octet-stream';
    opts.body = rawBody;
  } else if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(`http://127.0.0.1:${port}${url}`, opts);
  const text = await resp.text();
  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* keep text */ }
  return { status: resp.status, json, text, headers: resp.headers };
}

async function main() {
  const app = makeApp();
  const server = await listen(app);
  const token = signToken({ id: 7 });
  const baseFields = { projectId: null, title: 't', fileName: 'clip.mp4', mimeType: 'video/mp4' };

  try {
    // 1) HTTPS 页面 + HTTP 存储端点 → 自动协商 proxy，且统一 multipart
    const initHttps = await call(server, 'POST', '/api/upload/video/direct/init', {
      token, body: { ...baseFields, fileSize: 3 * 1024 * 1024, clientProtocol: 'https:' },
    });
    assert.strictEqual(initHttps.status, 200, `init https failed: ${initHttps.text}`);
    assert.strictEqual(initHttps.json.transport, 'proxy');
    assert.strictEqual(initHttps.json.uploadMode, 'direct-video-multipart-proxy');
    assert.strictEqual(initHttps.json.partSize, 8 * 1024 * 1024);
    assert.strictEqual(initHttps.json.partCount, 1);
    assert(initHttps.json.partUploadUrlPath.includes('/api/upload/video/direct/part-proxy/'));

    // 2) HTTP 页面 + 小文件 → 保留预签名 POST（原行为不变）
    const initHttp = await call(server, 'POST', '/api/upload/video/direct/init', {
      token, body: { ...baseFields, fileSize: 3 * 1024 * 1024, clientProtocol: 'http:' },
    });
    assert.strictEqual(initHttp.status, 200);
    assert.strictEqual(initHttp.json.transport, 'direct');
    assert.strictEqual(initHttp.json.uploadMode, 'direct-video-post');

    // 3) HTTP 页面 + 大文件 → 直传 multipart（32MB 分片，原行为不变）
    const initBig = await call(server, 'POST', '/api/upload/video/direct/init', {
      token, body: { ...baseFields, fileSize: 5 * 1024 * 1024 * 1024, clientProtocol: 'http:' },
    });
    assert.strictEqual(initBig.status, 200);
    assert.strictEqual(initBig.json.transport, 'direct');
    assert.strictEqual(initBig.json.uploadMode, 'direct-video-multipart');
    assert.strictEqual(initBig.json.partSize, 32 * 1024 * 1024);

    // 4) 显式 transport=proxy → 无视页面协议走代理
    const initForced = await call(server, 'POST', '/api/upload/video/direct/init', {
      token, body: { ...baseFields, fileSize: 12 * 1024 * 1024, clientProtocol: 'http:', transport: 'proxy' },
    });
    assert.strictEqual(initForced.status, 200);
    assert.strictEqual(initForced.json.transport, 'proxy');
    assert.strictEqual(initForced.json.partCount, 2);

    // 5) 分片代理：大小不符 → 400；正确大小 → 200 且 ETag 透传
    const sessionId = initForced.json.sessionId;
    const bad = await call(server, 'PUT', `/api/upload/video/direct/part-proxy/${sessionId}/1`, {
      token, rawBody: Buffer.alloc(4 * 1024 * 1024),
    });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.json.error, 'DIRECT_VIDEO_PART_SIZE_MISMATCH');

    const good1 = await call(server, 'PUT', `/api/upload/video/direct/part-proxy/${sessionId}/1`, {
      token, rawBody: Buffer.alloc(8 * 1024 * 1024),
    });
    assert.strictEqual(good1.status, 200, `part1 failed: ${good1.text}`);
    assert.strictEqual(good1.json.etag, `"etag-mpu-3-1"`);
    assert.strictEqual(good1.headers.get('etag'), `"etag-mpu-3-1"`);

    // 6) 非法分片号 / 他人会话 → 400 / 404
    const invalidPart = await call(server, 'PUT', `/api/upload/video/direct/part-proxy/${sessionId}/99`, {
      token, rawBody: Buffer.alloc(8 * 1024 * 1024),
    });
    assert.strictEqual(invalidPart.status, 400);
    assert.strictEqual(invalidPart.json.error, 'INVALID_PART_NUMBER');

    const strangerToken = signToken({ id: 999 });
    const stranger = await call(server, 'PUT', `/api/upload/video/direct/part-proxy/${sessionId}/1`, {
      token: strangerToken, rawBody: Buffer.alloc(8 * 1024 * 1024),
    });
    assert.strictEqual(stranger.status, 404);

    // 7) 完成直传：head 校验大小一致 → 落库 → 返回媒体记录
    fakeStorage.headSize = 12 * 1024 * 1024;
    const good2 = await call(server, 'PUT', `/api/upload/video/direct/part-proxy/${sessionId}/2`, {
      token, rawBody: Buffer.alloc(4 * 1024 * 1024),
    });
    assert.strictEqual(good2.status, 200);
    const complete = await call(server, 'POST', '/api/upload/video/direct/complete', {
      token, body: { sessionId, parts: [good1.json.etag, good2.json.etag].map((etag, i) => ({ partNumber: i + 1, etag })) },
    });
    assert.strictEqual(complete.status, 200, `complete failed: ${complete.text}`);
    assert.strictEqual(complete.json.id, 4321);
    assert.strictEqual(fakeStorage.completedUploads.length, 1);
    assert.strictEqual(fakeStorage.completedUploads[0].parts.length, 2);

    // 8) 无鉴权 → 401
    const noAuth = await call(server, 'PUT', `/api/upload/video/direct/part-proxy/${sessionId}/1`, {
      rawBody: Buffer.alloc(8 * 1024 * 1024),
    });
    assert.strictEqual(noAuth.status, 401);

    console.log('test_direct_video_proxy: all assertions passed');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
