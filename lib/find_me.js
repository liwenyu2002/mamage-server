// "拍照找我"：用户上传/拍摄单人照 → 热模型服务检测人脸 → 与相册/分享范围内的人脸做相似度匹配。
// 隐私：自拍只落临时文件喂检测服务，用完即删，不入库不进对象存储。
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const axios = require('axios');
const sharp = require('sharp');
const { pool, buildUploadUrl } = require('../db');

const FIND_ME_THRESHOLD = Number(process.env.FACE_FIND_ME_THRESHOLD || 0.36);
const MAX_SIDE = 1600; // 检测前缩边，够 buffalo_l 用，省 CPU
const SERVICE_URL = (process.env.FACE_DETECTOR_SERVICE_URL || '').replace(/\/+$/, '');
const SERVICE_TIMEOUT = Number(process.env.FACE_DETECTOR_SERVICE_TIMEOUT_MS || 60000);
const MODEL_NAME = process.env.FACE_DETECTOR_MODEL_NAME || 'buffalo_l';

function parseEmb(v) {
  if (!v) return null;
  if (Buffer.isBuffer(v)) {
    try { const a = JSON.parse(v.toString('utf8')); if (Array.isArray(a)) return a; } catch (e) { /* */ }
    if (v.length % 4 === 0) {
      try {
        const f = new Float32Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.length));
        const a = Array.from(f);
        if (a.length >= 64 && a.every(Number.isFinite)) return a;
      } catch (e) { /* */ }
    }
    return null;
  }
  if (typeof v === 'string') { try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch (e) { return null; } }
  return Array.isArray(v) ? v : null;
}
const cosine = (a, b) => {
  if (!a || !b || a.length !== b.length) return -1;
  let s = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { s += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; }
  return s / (Math.sqrt(x) * Math.sqrt(y) || 1);
};

class FindMeError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra || {};
  }
}

// EXIF 旋转 + 缩边 + 转 JPEG；HEIC(iPhone 相册) sharp 解不了时走 heic-convert
async function normalizeSelfie(buffer) {
  try {
    return await sharp(buffer).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
  } catch (e) {
    try {
      const heicConvert = require('heic-convert');
      const raw = await heicConvert({ buffer, format: 'JPEG', quality: 0.9 });
      return await sharp(raw).rotate().resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    } catch (e2) {
      throw new FindMeError(422, 'IMAGE_DECODE_FAILED');
    }
  }
}

// 检测：写临时文件 → 热模型服务(imagePath)。返回 faces 数组（服务的归一化 bbox+embedding）
async function detectSelfieFaces(buffer) {
  if (!SERVICE_URL) throw new FindMeError(503, 'FACE_SERVICE_UNAVAILABLE');
  const tmp = path.join(os.tmpdir(), `findme_${crypto.randomBytes(8).toString('hex')}.jpg`);
  await fsp.writeFile(tmp, buffer);
  try {
    const resp = await axios.post(`${SERVICE_URL}/detect`, { imagePath: tmp, modelName: MODEL_NAME }, { timeout: SERVICE_TIMEOUT });
    const faces = resp && resp.data && Array.isArray(resp.data.faces) ? resp.data.faces : [];
    return faces;
  } catch (e) {
    if (e instanceof FindMeError) throw e;
    throw new FindMeError(503, 'FACE_SERVICE_UNAVAILABLE');
  } finally {
    try { await fsp.unlink(tmp); } catch (e) { /* 尽力删除 */ }
  }
}

/**
 * 核心：单人照校验 + 范围内匹配。
 * @param {Buffer} fileBuffer 上传原图
 * @param {{photoIds?: number[]|Set<number>, projectId?: number, orgId?: number|null}} scope 二选一
 * @returns {{matches: [{photoId,url,thumbUrl,title,sim}], scannedFaces, threshold}}
 */
async function findMe(fileBuffer, scope) {
  if (!fileBuffer || !fileBuffer.length) throw new FindMeError(400, 'NO_FILE');
  const jpeg = await normalizeSelfie(fileBuffer);
  const faces = await detectSelfieFaces(jpeg);

  if (!faces.length) throw new FindMeError(422, 'NO_FACE');
  if (faces.length > 1) throw new FindMeError(422, 'MULTIPLE_FACES', { count: faces.length });
  const query = parseEmb(faces[0].normalizedEmbedding) || parseEmb(faces[0].embedding);
  if (!query) throw new FindMeError(422, 'NO_EMBEDDING');

  // 取范围内候选脸
  let rows;
  if (scope && scope.projectId) {
    const params = [Number(scope.projectId)];
    let sql = `SELECT f.photo_id AS photoId, f.normalized_embedding AS ne, f.embedding AS e,
                      p.url, p.thumb_url AS thumbUrl, p.title
               FROM photo_faces f JOIN photos p ON p.id = f.photo_id
               WHERE p.project_id = ?`;
    if (scope.orgId !== undefined && scope.orgId !== null) { sql += ' AND f.organization_id = ?'; params.push(Number(scope.orgId)); }
    [rows] = await pool.query(sql, params);
  } else if (scope && scope.photoIds) {
    const ids = Array.from(scope.photoIds).map(Number).filter(Boolean);
    if (!ids.length) throw new FindMeError(404, 'EMPTY_SCOPE');
    [rows] = await pool.query(
      `SELECT f.photo_id AS photoId, f.normalized_embedding AS ne, f.embedding AS e,
              p.url, p.thumb_url AS thumbUrl, p.title
       FROM photo_faces f JOIN photos p ON p.id = f.photo_id
       WHERE f.photo_id IN (?)`, [ids]
    );
  } else {
    throw new FindMeError(400, 'SCOPE_REQUIRED');
  }

  const byPhoto = new Map();
  let scanned = 0;
  for (const r of rows || []) {
    const vec = parseEmb(r.ne) || parseEmb(r.e);
    if (!vec) continue;
    scanned += 1;
    const sim = cosine(query, vec);
    if (sim < FIND_ME_THRESHOLD) continue;
    const cur = byPhoto.get(r.photoId);
    if (!cur || sim > cur.sim) {
      byPhoto.set(r.photoId, {
        photoId: Number(r.photoId),
        url: r.url ? buildUploadUrl(r.url) : null,
        thumbUrl: r.thumbUrl ? buildUploadUrl(r.thumbUrl) : null,
        title: r.title || null,
        sim: Number(sim.toFixed(4)),
      });
    }
  }
  const matches = Array.from(byPhoto.values()).sort((a, b) => b.sim - a.sim).slice(0, 200);
  return { matches, scannedFaces: scanned, threshold: FIND_ME_THRESHOLD };
}

// 简易内存限速（公开分享页也开放，防刷 CPU）：每 IP 每分钟 N 次
const rateBuckets = new Map();
function checkRateLimit(ip, maxPerMinute = 6) {
  const now = Date.now();
  const key = String(ip || 'unknown');
  const list = (rateBuckets.get(key) || []).filter((t) => now - t < 60000);
  if (list.length >= maxPerMinute) return false;
  list.push(now);
  rateBuckets.set(key, list);
  if (rateBuckets.size > 5000) rateBuckets.clear(); // 粗暴防泄漏
  return true;
}

module.exports = { findMe, FindMeError, checkRateLimit, FIND_ME_THRESHOLD };
