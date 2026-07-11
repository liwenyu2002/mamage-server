// 合影救场：以"基底照片"为中心的修脸管线。
//
// 用户指定一张基底照片（要修的那张），为基底里的每个人寻找替补脸：
//   1. 参考照片（可选 0-4 张）：与基底 whole-image embedding 相似（≥0.6）判为连拍，
//      匹配时叠加 bbox 位置约束；否则按跨场景处理，只用人脸 embedding（阈值更严）
//   2. 人脸数据库：同 person_id 的其他照片脸（未聚类则全库 embedding 检索），
//      过滤分辨率不足/角度差异过大的候选 —— 只投一张基底也能修
// 每人一张候选拼板（第 1 位固定是基底原脸），qwen3-vl 一次调用裁决：
// 原脸已是最佳则保持不动，否则挑睁眼、表情自然、角度接近的替补。
// 替补贴回前做每通道均值-方差颜色匹配（缓解跨场景光照差），椭圆羽化合成。
//
// 任务异步执行（单进程内存 job 表），HTTP 层轮询进度。

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { pool, buildInternalMediaUrl } = require('../db');
const cosStorage = require('./cos_storage');
const keys = require('../config/keys');
const { callOllamaGenerate } = require('../ai_function/ai_for_tags/ai_for_tags');

const MAX_REFS = 4; // 参考照片上限（加基底共 5）
const MAX_PERSONS = 8; // 基底里最多处理的人数
const DB_CAND_PER_PERSON = 3; // 人脸库每人最多取的候选数
const SHEET_CAND_CAP = 6; // 拼板里替补候选上限（不含基底原脸）
const COS_BURST_FACE = 0.45; // 连拍参考的同人阈值（有 bbox 双保险，可宽）
const COS_CROSS_FACE = 0.5; // 跨场景参考/人脸库的同人阈值（无位置约束，收紧）
const COS_BURST_IMAGE = 0.6; // whole-image 相似度 ≥ 此值判为连拍（与相似分组同阈值）
const BURST_MAX_CENTER_DIST = 0.28; // 连拍 bbox 中心距上限（ratio 空间）
const MAX_ASPECT_DIFF = 0.4; // 候选脸与基底脸 bbox 宽高比相对差上限（粗滤侧脸/仰头）
const MIN_FACE_SCALE = 0.5; // 候选脸像素宽不得小于目标的一半（否则放大发糊）
const CROP_MARGIN = 0.45; // 拼板裁脸扩边
const PASTE_MARGIN = 0.3; // 贴回扩边（羽化落在扩边内）
const JOB_TTL_MS = 30 * 60 * 1000;

const jobs = new Map(); // jobId → { status, step, error, resultPhotoId, createdAt, replacedCount }

function newJobId() {
  return crypto.randomBytes(8).toString('hex');
}

function getJob(jobId) {
  const job = jobs.get(String(jobId));
  if (!job) return null;
  return { status: job.status, step: job.step, error: job.error || null, resultPhotoId: job.resultPhotoId || null, replacedCount: job.replacedCount || 0 };
}

function gcJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) jobs.delete(id);
  }
}

function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || !a.length) return -1;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return -1;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function parseEmbedding(raw) {
  if (Array.isArray(raw)) return raw.map(Number);
  if (typeof raw === 'string') {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map(Number) : null; } catch (e) { return null; }
  }
  return null;
}

// ratio bbox → 像素矩形（带扩边、裁剪到图内）
function bboxToRect(face, imgW, imgH, margin) {
  const bw = Number(face.bbox_w) * imgW;
  const bh = Number(face.bbox_h) * imgH;
  const bx = Number(face.bbox_x) * imgW;
  const by = Number(face.bbox_y) * imgH;
  const mx = bw * margin;
  const my = bh * margin;
  const left = Math.max(0, Math.round(bx - mx));
  const top = Math.max(0, Math.round(by - my));
  const right = Math.min(imgW, Math.round(bx + bw + mx));
  const bottom = Math.min(imgH, Math.round(by + bh + my));
  return { left, top, width: Math.max(8, right - left), height: Math.max(8, bottom - top) };
}

function faceAspect(face) {
  const w = Number(face.bbox_w);
  const h = Number(face.bbox_h);
  return h > 0 ? w / h : 1;
}

function facePixelWidth(face) {
  return Number(face.bbox_w) * Number(face.image_width || 0);
}

async function fetchImageBuffer(rel) {
  const url = buildInternalMediaUrl(rel);
  const resp = await fetch(url, { timeout: 30000 });
  if (!resp.ok) throw new Error(`fetch image failed ${resp.status}: ${rel}`);
  return Buffer.from(await resp.arrayBuffer());
}

// 每人一张候选拼板：第 1 位固定是基底原脸，模型裁决"要不要换、换哪张"
async function pickBestCandidate(candidates) {
  const TILE_H = 300;
  const tiles = [];
  for (const c of candidates) {
    const buf = await sharp(c.imageBuffer)
      .extract(c.cropRect)
      .resize({ height: TILE_H })
      .toBuffer();
    const meta = await sharp(buf).metadata();
    tiles.push({ buf, width: meta.width || TILE_H });
  }
  const GAP = 14;
  const totalW = tiles.reduce((s, t) => s + t.width, 0) + GAP * (tiles.length + 1);
  const labelSvg = (n, x) => `<text x="${x}" y="36" font-size="30" font-weight="bold" fill="#ff3b30" font-family="sans-serif">${n}</text>`;
  let xCursor = GAP;
  const composites = [];
  let labels = '';
  tiles.forEach((t, i) => {
    composites.push({ input: t.buf, left: xCursor, top: 46 });
    labels += labelSvg(i + 1, xCursor + 6);
    xCursor += t.width + GAP;
  });
  const sheet = await sharp({ create: { width: totalW, height: TILE_H + 56, channels: 3, background: { r: 24, g: 24, b: 24 } } })
    .composite([
      ...composites,
      { input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="${TILE_H + 56}">${labels}</svg>`), left: 0, top: 0 },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  const prompt = [
    `图中是同一个人的 ${candidates.length} 张脸，从左到右编号 1 到 ${candidates.length}（红色数字）。`,
    '1 号是基底照片里这个人现在的脸；其余是这个人在其他照片里的瞬间。',
    '如果 1 号已经睁眼且表情自然，返回 {"best": 1}。',
    '否则从其余里选一张睁眼、表情最自然、拍摄角度和光线与 1 号最接近的。',
    '如果某张看起来不是同一个人，绝对不要选它；没有合适的替补也返回 {"best": 1}。',
    '只返回 JSON：{"best": 编号数字}。不要解释。',
  ].join('\n');

  try {
    const raw = String(await callOllamaGenerate(prompt, sheet.toString('base64')) || '');
    const cleaned = raw.replace(/```(?:json)?|```/g, '');
    const jsonMatches = cleaned.match(/\{[^{}]*\}/g);
    let parsed = null;
    if (jsonMatches && jsonMatches.length) {
      try { parsed = JSON.parse(jsonMatches[jsonMatches.length - 1]); } catch (e) { parsed = null; }
    }
    if (!parsed) {
      const m = cleaned.match(/"best"\s*:\s*(\d+)/);
      if (m) parsed = { best: Number(m[1]) };
    }
    const best = Number(parsed && parsed.best);
    if (Number.isFinite(best) && best >= 1 && best <= candidates.length) return best - 1;
    console.warn('[group_rescue] unparsable model verdict, keep base:', raw.slice(0, 200));
  } catch (e) {
    console.warn('[group_rescue] pickBestCandidate model call failed, keep base:', e && e.message ? e.message : e);
  }
  return 0; // 模型失败 → 保持基底原脸
}

// 椭圆羽化 alpha 蒙版
function featherMaskSvg(w, h) {
  const rx = w / 2;
  const ry = h / 2;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
      <defs><radialGradient id="f" cx="50%" cy="50%" r="50%">
        <stop offset="62%" stop-color="#fff" stop-opacity="1"/>
        <stop offset="100%" stop-color="#fff" stop-opacity="0"/>
      </radialGradient></defs>
      <ellipse cx="${rx}" cy="${ry}" rx="${rx}" ry="${ry}" fill="url(#f)"/>
    </svg>`
  );
}

// 每通道均值-方差匹配：把替补 patch 的色调拉向基底目标区域（缓解跨场景光照/肤色差）
async function colorMatchPatch(patchBuffer, targetRegionBuffer) {
  try {
    const [ps, ts] = await Promise.all([sharp(patchBuffer).stats(), sharp(targetRegionBuffer).stats()]);
    const a = [];
    const b = [];
    for (let c = 0; c < 3; c += 1) {
      const stdP = Math.max(ps.channels[c].stdev, 1e-3);
      const gain = Math.min(2.5, Math.max(0.4, ts.channels[c].stdev / stdP));
      a.push(gain);
      b.push(ts.channels[c].mean - gain * ps.channels[c].mean);
    }
    return await sharp(patchBuffer).linear(a, b).toBuffer();
  } catch (e) {
    console.warn('[group_rescue] color match failed, use raw patch:', e && e.message ? e.message : e);
    return patchBuffer;
  }
}

async function loadPhotosWithFaces(ids, orgId) {
  if (!ids.length) return { photos: [], facesByPhoto: new Map() };
  const [photoRows] = await pool.query(
    `SELECT id, project_id, timeline_section_id, url, thumb_url, title, ai_score, photographer_id, organization_id
     FROM photos WHERE id IN (?) AND type <> 'video'` + (orgId === null ? ' AND organization_id IS NULL' : ' AND organization_id = ?'),
    orgId === null ? [ids] : [ids, orgId]
  );
  const facesByPhoto = new Map();
  if (photoRows && photoRows.length) {
    const [faceRows] = await pool.query(
      `SELECT photo_id, face_no, person_id, bbox_x, bbox_y, bbox_w, bbox_h, image_width, image_height,
              detection_score, quality_score, embedding, normalized_embedding
       FROM photo_faces WHERE photo_id IN (?) AND status <> 'deleted'`,
      [photoRows.map((p) => p.id)]
    );
    (faceRows || []).forEach((f) => {
      const emb = parseEmbedding(f.normalized_embedding) || parseEmbedding(f.embedding);
      if (!emb) return;
      if (!facesByPhoto.has(f.photo_id)) facesByPhoto.set(f.photo_id, []);
      facesByPhoto.get(f.photo_id).push({ ...f, emb });
    });
  }
  return { photos: photoRows || [], facesByPhoto };
}

// 判断参考照片是否与基底同为连拍：whole-image embedding 余弦 ≥ 0.6
async function burstRefIds(basePhotoId, refIds) {
  if (!refIds.length) return new Set();
  try {
    const [rows] = await pool.query(
      `SELECT photo_id, embedding FROM ai_image_embeddings WHERE model_name = 'resnet50' AND photo_id IN (?)`,
      [[basePhotoId, ...refIds]]
    );
    const map = new Map();
    (rows || []).forEach((r) => { const v = parseEmbedding(r.embedding); if (v) map.set(r.photo_id, v); });
    const baseVec = map.get(basePhotoId);
    if (!baseVec) return new Set();
    const out = new Set();
    refIds.forEach((id) => {
      const v = map.get(id);
      if (v && cosineSim(baseVec, v) >= COS_BURST_IMAGE) out.add(id);
    });
    return out;
  } catch (e) {
    return new Set(); // 无 whole-image embedding 时全部按跨场景严格阈值处理
  }
}

// 人脸库检索：同 person_id 优先，未聚类则全库 embedding 余弦 top-K
async function gatherDbCandidates(baseFace, orgId, excludePhotoIds) {
  const targetPixelW = facePixelWidth(baseFace);
  const targetAspect = faceAspect(baseFace);
  const exclude = new Set(excludePhotoIds.map(Number));

  let rows = [];
  if (baseFace.person_id) {
    const [r] = await pool.query(
      `SELECT f.photo_id, f.face_no, f.person_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h,
              f.image_width, f.image_height, f.detection_score, f.quality_score,
              f.normalized_embedding, f.embedding, p.url, p.thumb_url
       FROM photo_faces f JOIN photos p ON p.id = f.photo_id
       WHERE f.person_id = ? AND f.status <> 'deleted' AND p.type <> 'video'` +
       (orgId === null ? ' AND p.organization_id IS NULL' : ' AND p.organization_id = ?'),
      orgId === null ? [baseFace.person_id] : [baseFace.person_id, orgId]
    );
    rows = (r || []).map((f) => ({ ...f, sim: 1 }));
  } else {
    const [r] = await pool.query(
      `SELECT f.photo_id, f.face_no, f.person_id, f.bbox_x, f.bbox_y, f.bbox_w, f.bbox_h,
              f.image_width, f.image_height, f.detection_score, f.quality_score,
              f.normalized_embedding, f.embedding, p.url, p.thumb_url
       FROM photo_faces f JOIN photos p ON p.id = f.photo_id
       WHERE f.status <> 'deleted' AND p.type <> 'video'` +
       (orgId === null ? ' AND p.organization_id IS NULL' : ' AND p.organization_id = ?'),
      orgId === null ? [] : [orgId]
    );
    rows = (r || []).map((f) => {
      const emb = parseEmbedding(f.normalized_embedding) || parseEmbedding(f.embedding);
      return { ...f, sim: emb ? cosineSim(baseFace.emb, emb) : -1 };
    }).filter((f) => f.sim >= COS_CROSS_FACE);
  }

  return rows
    .filter((f) => !exclude.has(Number(f.photo_id)))
    .filter((f) => facePixelWidth(f) >= targetPixelW * MIN_FACE_SCALE)
    .filter((f) => {
      const ar = faceAspect(f);
      return targetAspect > 0 && Math.abs(ar - targetAspect) / targetAspect <= MAX_ASPECT_DIFF;
    })
    .sort((a, b) => (b.sim * 0.6 + Number(b.quality_score || b.detection_score || 0) * 0.4)
                  - (a.sim * 0.6 + Number(a.quality_score || a.detection_score || 0) * 0.4))
    .slice(0, DB_CAND_PER_PERSON);
}

async function storeResult(baseRow, buffer, thumbBuffer) {
  const now = new Date();
  const prefix = `uploads/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
  const uuid = crypto.randomUUID();
  const originalKey = `${prefix}/${uuid}.jpg`;
  const thumbKey = `${prefix}/thumbs/thumb_${uuid}.jpg`;

  let stored = false;
  try {
    await cosStorage.uploadBuffer(originalKey, buffer, { contentType: 'image/jpeg' });
    await cosStorage.uploadBuffer(thumbKey, thumbBuffer, { contentType: 'image/jpeg' });
    stored = true;
  } catch (e) {
    // 本地开发无 S3：落盘到 uploads 目录（与静态服务一致）
    const baseDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
    const rootDir = baseDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads') ? path.dirname(baseDir) : baseDir;
    const origAbs = path.join(rootDir, originalKey);
    const thumbAbs = path.join(rootDir, thumbKey);
    fs.mkdirSync(path.dirname(origAbs), { recursive: true });
    fs.mkdirSync(path.dirname(thumbAbs), { recursive: true });
    fs.writeFileSync(origAbs, buffer);
    fs.writeFileSync(thumbAbs, thumbBuffer);
    stored = true;
    console.warn('[group_rescue] S3 unavailable, stored to local disk:', e && e.message ? e.message : e);
  }
  if (!stored) throw new Error('store result failed');

  // 复用上传链路的事务插入（项目归属校验、缺列降级）+ photo_ids 同步
  const { createPhotoRecordWithRetry, appendPhotoIdToProjectBestEffort } = require('../routes/upload');
  const insertedId = await createPhotoRecordWithRetry({
    projectId: baseRow.project_id,
    orgId: baseRow.organization_id,
    timelineSectionId: baseRow.timeline_section_id,
    relPath: `/${originalKey}`,
    thumbRel: `/${thumbKey}`,
    title: `合影救场·${baseRow.title || baseRow.id}`,
    description: null,
    tags: null,
    aiStatus: 'pending',
    type: 'normal',
    photographerId: baseRow.photographer_id,
  });
  await appendPhotoIdToProjectBestEffort(baseRow.project_id, insertedId);
  return insertedId;
}

async function runJob(job, params, orgId) {
  const step = (s) => { job.step = s; };
  try {
    step('加载基底照片与人脸');
    let basePhotoId = Number(params.basePhotoId) || null;
    let referencePhotoIds = (params.referencePhotoIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);

    // 兼容旧 photoIds 模式：自动选 AI 分最高的有脸照片为基底，其余为参考
    if (!basePhotoId && Array.isArray(params.photoIds) && params.photoIds.length) {
      const legacy = await loadPhotosWithFaces(params.photoIds.map(Number), orgId);
      const withFaces = legacy.photos.filter((p) => (legacy.facesByPhoto.get(p.id) || []).length > 0);
      if (!withFaces.length) throw new Error('这组照片还没有人脸数据（人脸分析可能未完成）');
      withFaces.sort((a, b) => (Number(b.ai_score) || -1) - (Number(a.ai_score) || -1));
      basePhotoId = withFaces[0].id;
      referencePhotoIds = legacy.photos.map((p) => p.id).filter((id) => id !== basePhotoId);
    }
    if (!basePhotoId) throw new Error('缺少基底照片');
    referencePhotoIds = referencePhotoIds.filter((id) => id !== basePhotoId).slice(0, MAX_REFS);

    const { photos, facesByPhoto } = await loadPhotosWithFaces([basePhotoId, ...referencePhotoIds], orgId);
    const base = photos.find((p) => p.id === basePhotoId);
    if (!base) throw new Error('基底照片不存在或无权访问');
    const baseFaces = (facesByPhoto.get(base.id) || [])
      .sort((a, b) => Number(b.bbox_w) * Number(b.bbox_h) - Number(a.bbox_w) * Number(a.bbox_h))
      .slice(0, MAX_PERSONS);
    if (!baseFaces.length) throw new Error('基底照片还没有人脸数据（人脸分析可能未完成）');
    const refs = photos.filter((p) => p.id !== base.id);

    step('判断参考照片类型');
    const burstSet = await burstRefIds(base.id, refs.map((r) => r.id));

    // 图片按需下载并缓存（人脸库候选可能来自很多照片）
    const buffers = new Map();
    const metas = new Map();
    const ensureImage = async (photoId, rel) => {
      if (!buffers.has(photoId)) {
        buffers.set(photoId, await fetchImageBuffer(rel));
        metas.set(photoId, await sharp(buffers.get(photoId)).metadata());
      }
      return { buf: buffers.get(photoId), meta: metas.get(photoId) };
    };

    step('下载基底原图');
    await ensureImage(base.id, base.url || base.thumb_url);
    const baseMeta = metas.get(base.id);
    const baseW = baseMeta.width;
    const baseH = baseMeta.height;

    let composite = sharp(buffers.get(base.id));
    const overlays = [];
    let replaced = 0;
    let dbHits = 0;

    for (let i = 0; i < baseFaces.length; i += 1) {
      const bf = baseFaces[i];
      step(`收集第 ${i + 1}/${baseFaces.length} 个人的候选脸`);

      // ① 参考照片候选：连拍启用 bbox 约束（阈值放宽），跨场景只看 embedding（阈值收紧）
      const refCands = [];
      for (const rp of refs) {
        const isBurst = burstSet.has(rp.id);
        const minCos = isBurst ? COS_BURST_FACE : COS_CROSS_FACE;
        let best = null;
        for (const f of (facesByPhoto.get(rp.id) || [])) {
          const sim = cosineSim(bf.emb, f.emb);
          if (sim < minCos) continue;
          if (isBurst) {
            const dx = (Number(bf.bbox_x) + Number(bf.bbox_w) / 2) - (Number(f.bbox_x) + Number(f.bbox_w) / 2);
            const dy = (Number(bf.bbox_y) + Number(bf.bbox_h) / 2) - (Number(f.bbox_y) + Number(f.bbox_h) / 2);
            if (Math.hypot(dx, dy) > BURST_MAX_CENTER_DIST) continue;
          }
          if (!best || sim > best.sim) best = { face: f, sim };
        }
        if (best) refCands.push({ photo: rp, face: best.face, sim: best.sim, source: 'ref' });
      }

      // ② 人脸库候选（排除基底与参考照片，避免重复）
      const dbFaces = await gatherDbCandidates(bf, orgId, [base.id, ...refs.map((r) => r.id)]);
      const dbCands = dbFaces.map((f) => ({
        photo: { id: f.photo_id, url: f.url, thumb_url: f.thumb_url },
        face: f,
        sim: f.sim,
        source: 'db',
      }));
      if (dbCands.length) dbHits += 1;

      const pool_ = [...refCands.sort((a, b) => b.sim - a.sim), ...dbCands].slice(0, SHEET_CAND_CAP);
      if (!pool_.length) continue; // 没有任何替补 → 这个人保持原样

      step(`评审第 ${i + 1}/${baseFaces.length} 个人（${pool_.length} 个候选）`);
      const sheet = [{
        photoId: base.id,
        face: bf,
        imageBuffer: buffers.get(base.id),
        cropRect: bboxToRect(bf, baseW, baseH, CROP_MARGIN),
        imgW: baseW,
        imgH: baseH,
      }];
      for (const c of pool_) {
        try {
          const { buf, meta } = await ensureImage(c.photo.id, c.photo.url || c.photo.thumb_url);
          sheet.push({
            photoId: c.photo.id,
            face: c.face,
            imageBuffer: buf,
            cropRect: bboxToRect(c.face, meta.width, meta.height, CROP_MARGIN),
            imgW: meta.width,
            imgH: meta.height,
          });
        } catch (e) {
          console.warn('[group_rescue] candidate image fetch failed, skip:', c.photo.id, e && e.message ? e.message : e);
        }
      }
      if (sheet.length < 2) continue;

      const bestIdx = await pickBestCandidate(sheet);
      if (bestIdx === 0) continue; // 基底原脸已是最佳

      step(`替换第 ${i + 1}/${baseFaces.length} 个人的人脸`);
      const chosen = sheet[bestIdx];
      const targetRect = bboxToRect(bf, baseW, baseH, PASTE_MARGIN);
      const sourceRect = bboxToRect(chosen.face, chosen.imgW, chosen.imgH, PASTE_MARGIN);
      const rawPatch = await sharp(chosen.imageBuffer)
        .extract(sourceRect)
        .resize(targetRect.width, targetRect.height, { fit: 'fill' })
        .toBuffer();
      const targetRegion = await sharp(buffers.get(base.id)).extract(targetRect).toBuffer();
      const matchedPatch = await colorMatchPatch(rawPatch, targetRegion);
      const feathered = await sharp(matchedPatch)
        .composite([{ input: featherMaskSvg(targetRect.width, targetRect.height), blend: 'dest-in' }])
        .png()
        .toBuffer();
      overlays.push({ input: feathered, left: targetRect.left, top: targetRect.top });
      replaced += 1;
    }

    if (!replaced) {
      job.status = 'done_noop';
      job.step = '基底照片里每个人已是最佳状态，或没有找到可用的替补脸';
      job.replacedCount = 0;
      return;
    }

    step('合成输出');
    const outBuffer = await composite.composite(overlays).jpeg({ quality: 92 }).toBuffer();
    const thumbBuffer = await sharp(outBuffer).resize(640).jpeg({ quality: 80 }).toBuffer();

    step('保存新照片');
    const newId = await storeResult(base, outBuffer, thumbBuffer);
    try {
      require('./ai_tags_worker').enqueue({ id: newId });
    } catch (e) { /* 打标失败不影响救场结果 */ }

    job.resultPhotoId = newId;
    job.replacedCount = replaced;
    job.status = 'done';
    job.step = `完成：替换了 ${replaced} 张人脸` + (dbHits ? '（部分替补来自人脸库）' : '');
  } catch (err) {
    job.status = 'failed';
    job.error = err && err.message ? err.message : String(err);
    console.error('[group_rescue] job failed:', job.error);
  }
}

// params: { basePhotoId, referencePhotoIds } 或旧版 { photoIds }
function startJob(params, orgId) {
  gcJobs();
  const jobId = newJobId();
  const job = { status: 'running', step: '排队中', createdAt: Date.now() };
  jobs.set(jobId, job);
  runJob(job, params || {}, orgId);
  return jobId;
}

module.exports = { startJob, getJob };
