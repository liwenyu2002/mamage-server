// "拍照找我"：用户上传/拍摄单人照 → 热模型服务检测人脸 → 与相册/分享范围内的人脸做相似度匹配。
// 隐私：自拍只落临时文件喂检测服务，用完即删，不入库不进对象存储。
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const fsp = require('fs/promises');
const axios = require('axios');
const sharp = require('sharp');
const { pool } = require('../db');
const { buildMediaUrl } = require('./media_access');
const { loadFeedbackMemory, normalize, cosine, attachFeedbackReferences } = require('./face_feedback');
const { sameEmbeddingSpace, matchMargin, buildIdentityProfiles, scoreIdentityProfile,
  classifyIdentityMatch } = require('./face_matching');

const FIND_ME_THRESHOLD = Number(process.env.FACE_FIND_ME_THRESHOLD || 0.36);
const MAX_SIDE = 1600;
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

// 检测：临时文件 → 热模型服务；返回人脸与模型版本，始终删除临时文件。
async function detectSelfieFaces(buffer) {
  if (!SERVICE_URL) throw new FindMeError(503, 'FACE_SERVICE_UNAVAILABLE');
  const tmp = path.join(os.tmpdir(), `findme_${crypto.randomBytes(8).toString('hex')}.jpg`);
  await fsp.writeFile(tmp, buffer);
  try {
    const resp = await axios.post(`${SERVICE_URL}/detect`, {
      imagePath: tmp, modelName: MODEL_NAME, backend: 'insightface',
    }, { timeout: SERVICE_TIMEOUT });
    const faces = resp && resp.data && Array.isArray(resp.data.faces) ? resp.data.faces : [];
    return { faces, modelName: resp.data.modelName || MODEL_NAME, modelVersion: resp.data.modelVersion || null };
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
  const detected = await detectSelfieFaces(jpeg);
  const { faces } = detected;

  if (!faces.length) throw new FindMeError(422, 'NO_FACE');
  if (faces.length > 1) throw new FindMeError(422, 'MULTIPLE_FACES', { count: faces.length });
  const query = normalize(parseEmb(faces[0].normalizedEmbedding)) || normalize(parseEmb(faces[0].embedding));
  if (!query) throw new FindMeError(422, 'NO_EMBEDDING');
  const space = { modelName: detected.modelName, modelVersion: detected.modelVersion };

  // 取范围内候选脸（带 person_id：两段式识别要用）
  let rows;
  if (scope && scope.projectId) {
    const params = [Number(scope.projectId)];
    let sql = `SELECT f.photo_id AS photoId, f.person_id AS personId, f.normalized_embedding AS ne, f.embedding AS e,
                      f.model_name AS modelName, f.model_version AS modelVersion, f.status,
                      p.url, p.thumb_url AS thumbUrl, p.public_download_url AS publicDownloadUrl,
                      p.playback_url AS playbackUrl, p.type, p.title
               FROM photo_faces f JOIN photos p ON p.id = f.photo_id
               WHERE p.project_id = ?`;
    if (scope.orgId !== undefined && scope.orgId !== null) { sql += ' AND f.organization_id = ?'; params.push(Number(scope.orgId)); }
    if (scope.unitId !== undefined && scope.unitId !== null) { sql += ' AND p.unit_id = ?'; params.push(Number(scope.unitId)); }
    sql += " AND f.model_name = ? AND f.model_version <=> ? AND f.status NOT IN ('rejected', 'deleted')";
    params.push(space.modelName, space.modelVersion);
    sql += ' ORDER BY f.updated_at DESC, f.id DESC';
    [rows] = await pool.query(sql, params);
  } else if (scope && scope.photoIds) {
    const ids = Array.from(scope.photoIds).map(Number).filter(Boolean);
    if (!ids.length) throw new FindMeError(404, 'EMPTY_SCOPE');
    [rows] = await pool.query(
      `SELECT f.photo_id AS photoId, f.person_id AS personId, f.normalized_embedding AS ne, f.embedding AS e,
              f.model_name AS modelName, f.model_version AS modelVersion, f.status,
              p.url, p.thumb_url AS thumbUrl, p.public_download_url AS publicDownloadUrl,
              p.playback_url AS playbackUrl, p.type, p.title
       FROM photo_faces f JOIN photos p ON p.id = f.photo_id
       WHERE f.photo_id IN (?) AND f.model_name = ? AND f.model_version <=> ?
         AND f.status NOT IN ('rejected', 'deleted')
       ORDER BY f.updated_at DESC, f.id DESC`, [ids, space.modelName, space.modelVersion]
    );
  } else {
    throw new FindMeError(400, 'SCOPE_REQUIRED');
  }

  // Identity evidence and photo retrieval are separate: a cluster match cannot bypass per-face checks.
  const scored = [];
  let scanned = 0;
  for (const r of rows || []) {
    if (!sameEmbeddingSpace(r, space) || r.status === 'rejected' || r.status === 'deleted') continue;
    const vec = normalize(parseEmb(r.ne)) || normalize(parseEmb(r.e));
    if (!vec || vec.length !== query.length) continue;
    scanned += 1;
    scored.push({ r, sim: cosine(query, vec) });
  }

  const profiles = buildIdentityProfiles(scored.map(({ r }) => r), { space });
  // Share searches may use feedback only from photos already inside the authorized scope.
  const memory = await loadFeedbackMemory(pool, scope.orgId, {
    ...space, photoIds: [...new Set(scored.map(({ r }) => Number(r.photoId)))],
  });
  const scopedPersonIds = new Set(profiles.map((profile) => profile.personId));
  const scopedReferences = new Map([...memory.references].filter(([personId]) => scopedPersonIds.has(personId)));
  attachFeedbackReferences(profiles, scopedReferences);
  const ranked = profiles.map((profile) => ({ personId: profile.personId, ...scoreIdentityProfile(query, profile) }))
    .sort((a, b) => b.score - a.score);
  const decision = classifyIdentityMatch(ranked, { threshold: FIND_ME_THRESHOLD,
    margin: matchMargin(process.env.FACE_FIND_ME_MATCH_MARGIN ?? process.env.FACE_CLUSTER_MATCH_MARGIN),
    separations: memory.separations });
  if (decision.ambiguous || decision.feedbackConflict) {
    return { matches: [], person: null, ambiguous: true, scannedFaces: scanned, threshold: FIND_ME_THRESHOLD };
  }
  const topPerson = decision.best ? { pid: decision.best.personId, best: decision.best.score } : null;

  const byPhoto = new Map();
  const keep = (r, sim, viaPerson) => {
    const cur = byPhoto.get(r.photoId);
    if (!cur || sim > cur.sim) {
      const displayPath = scope.mediaContext?.shareId
        ? (r.type === 'video' ? (r.playbackUrl || r.thumbUrl) : (r.publicDownloadUrl || r.thumbUrl))
        : r.url;
      byPhoto.set(r.photoId, {
        photoId: Number(r.photoId),
        url: displayPath ? buildMediaUrl(displayPath, { ...scope.mediaContext, photoId: r.photoId }) : null,
        thumbUrl: r.thumbUrl ? buildMediaUrl(r.thumbUrl, { ...scope.mediaContext, photoId: r.photoId }) : null,
        title: r.title || null,
        sim: Number(sim.toFixed(4)),
        viaPerson: viaPerson || (cur ? cur.viaPerson : false),
      });
    } else if (viaPerson && cur) cur.viaPerson = true;
  };
  scored.forEach(({ r, sim }) => {
    const isTopPersonFace = topPerson && Number(r.personId) === topPerson.pid;
    if (isTopPersonFace && sim >= FIND_ME_THRESHOLD) keep(r, sim, true);
    else if (!r.personId && sim >= FIND_ME_THRESHOLD) keep(r, sim, false);
  });

  let person = null;
  if (topPerson) {
    const [[p]] = await pool.query('SELECT id, name FROM face_persons WHERE id = ? LIMIT 1', [topPerson.pid]).catch(() => [[null]]);
    person = { personId: topPerson.pid, bestSim: Number(topPerson.best.toFixed(4)), name: (p && p.name) || null };
  }

  const allMatches = Array.from(byPhoto.values()).sort((a, b) => b.sim - a.sim);
  return { matches: allMatches.slice(0, 200), totalMatches: allMatches.length, truncated: allMatches.length > 200,
    scannedFaces: scanned, threshold: FIND_ME_THRESHOLD, person };
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
