// 一键合影救场：从同机位连拍组中为每个人挑出最佳表情的人脸，合成一张全员状态最好的合影。
//
// 流程：
//   1. 基准图 = 组内 AI 综合分最高的照片
//   2. 跨图人脸匹配：normalized_embedding 余弦相似度 + bbox 中心距离约束（连拍机位近似不动）
//   3. 每人生成一张"候选脸拼板"（横向编号拼接），qwen3-vl 一次调用选出睁眼且表情最自然的一张
//   4. 需要替换的人脸从候选图裁出，椭圆羽化后贴回基准图对应位置
//   5. 产出新照片入库（沿用基准图的项目/环节/摄影师），进 AI 打标队列
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

const MAX_PHOTOS = 5;
const MAX_PERSONS = 8;
const MATCH_MIN_COS = 0.45; // 跨图同人 embedding 相似度下限
const MATCH_MAX_CENTER_DIST = 0.28; // 跨图同人 bbox 中心距离上限（ratio 空间，连拍应很小）
const CROP_MARGIN = 0.45; // 拼板裁脸的扩边比例
const PASTE_MARGIN = 0.3; // 贴回时的扩边比例（略小于拼板，羽化边缘落在扩边内）
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

async function fetchImageBuffer(rel) {
  const url = buildInternalMediaUrl(rel);
  const resp = await fetch(url, { timeout: 30000 });
  if (!resp.ok) throw new Error(`fetch image failed ${resp.status}: ${rel}`);
  return Buffer.from(await resp.arrayBuffer());
}

// 每人一张候选拼板：横向排列编号 1..N，一次模型调用选最佳
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
    `图中是同一个人在连拍中的 ${candidates.length} 个瞬间，从左到右编号 1 到 ${candidates.length}（红色数字）。`,
    '选出睁眼、表情最自然、面部最清晰的一张。',
    '只返回 JSON：{"best": 编号数字}。不要解释。',
  ].join('\n');

  try {
    const raw = String(await callOllamaGenerate(prompt, sheet.toString('base64')) || '');
    // thinking 型模型可能在 JSON 前带推理文字：取最后一个 {...} 片段解析
    const cleaned = raw.replace(/```(?:json)?|```/g, '');
    const jsonMatches = cleaned.match(/\{[^{}]*\}/g);
    let parsed = null;
    if (jsonMatches && jsonMatches.length) {
      try { parsed = JSON.parse(jsonMatches[jsonMatches.length - 1]); } catch (e) { parsed = null; }
    }
    // 输出被截断（如 `{"best": 1` 没闭合）时直接抓字段
    if (!parsed) {
      const m = cleaned.match(/"best"\s*:\s*(\d+)/);
      if (m) parsed = { best: Number(m[1]) };
    }
    const best = Number(parsed && parsed.best);
    if (Number.isFinite(best) && best >= 1 && best <= candidates.length) return best - 1;
    console.warn('[group_rescue] unparsable model verdict, fallback to base:', raw.slice(0, 200));
  } catch (e) {
    console.warn('[group_rescue] pickBestCandidate model call failed, fallback to base:', e && e.message ? e.message : e);
  }
  return null; // 模型失败 → 保持基准图原样
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

async function runJob(job, photoIds, orgId) {
  const step = (s) => { job.step = s; };
  try {
    step('加载照片与人脸');
    const ids = photoIds.slice(0, MAX_PHOTOS);
    const [photoRows] = await pool.query(
      `SELECT id, project_id, timeline_section_id, url, thumb_url, title, ai_score, photographer_id, organization_id
       FROM photos WHERE id IN (?) AND type <> 'video'` + (orgId === null ? ' AND organization_id IS NULL' : ' AND organization_id = ?'),
      orgId === null ? [ids] : [ids, orgId]
    );
    if (!photoRows || photoRows.length < 2) throw new Error('至少需要组内 2 张照片');
    if (new Set(photoRows.map((p) => p.project_id)).size > 1) throw new Error('请选择同一相册中的连拍照片');

    const [faceRows] = await pool.query(
      `SELECT photo_id, face_no, bbox_x, bbox_y, bbox_w, bbox_h, detection_score, quality_score, normalized_embedding, embedding
       FROM photo_faces WHERE photo_id IN (?) AND status <> 'deleted'`,
      [photoRows.map((p) => p.id)]
    );
    const facesByPhoto = new Map();
    (faceRows || []).forEach((f) => {
      const emb = parseEmbedding(f.normalized_embedding) || parseEmbedding(f.embedding);
      if (!emb) return;
      if (!facesByPhoto.has(f.photo_id)) facesByPhoto.set(f.photo_id, []);
      facesByPhoto.get(f.photo_id).push({ ...f, emb });
    });

    // 基准图 = 有人脸的照片里 AI 分最高
    const withFaces = photoRows.filter((p) => (facesByPhoto.get(p.id) || []).length > 0);
    if (!withFaces.length) throw new Error('这组照片还没有人脸数据（人脸分析可能未完成）');
    withFaces.sort((a, b) => (Number(b.ai_score) || -1) - (Number(a.ai_score) || -1) || (facesByPhoto.get(b.id).length - facesByPhoto.get(a.id).length));
    const base = withFaces[0];
    const others = photoRows.filter((p) => p.id !== base.id && (facesByPhoto.get(p.id) || []).length > 0);
    if (!others.length) throw new Error('其余照片没有人脸数据，无法比较');

    step('下载原图');
    const buffers = new Map();
    for (const p of [base, ...others]) {
      buffers.set(p.id, await fetchImageBuffer(p.url || p.thumb_url));
    }
    const baseMeta = await sharp(buffers.get(base.id)).metadata();
    const baseW = baseMeta.width;
    const baseH = baseMeta.height;

    // 跨图匹配：以基准图的每张脸为锚
    step('跨图匹配人脸');
    const baseFaces = (facesByPhoto.get(base.id) || [])
      .sort((a, b) => Number(b.bbox_w) * Number(b.bbox_h) - Number(a.bbox_w) * Number(a.bbox_h))
      .slice(0, MAX_PERSONS);
    const persons = [];
    for (const bf of baseFaces) {
      const cands = [{ photo: base, face: bf }];
      for (const p of others) {
        let best = null;
        for (const f of facesByPhoto.get(p.id)) {
          const sim = cosineSim(bf.emb, f.emb);
          if (sim < MATCH_MIN_COS) continue;
          const dx = (Number(bf.bbox_x) + Number(bf.bbox_w) / 2) - (Number(f.bbox_x) + Number(f.bbox_w) / 2);
          const dy = (Number(bf.bbox_y) + Number(bf.bbox_h) / 2) - (Number(f.bbox_y) + Number(f.bbox_h) / 2);
          if (Math.hypot(dx, dy) > MATCH_MAX_CENTER_DIST) continue;
          if (!best || sim > best.sim) best = { face: f, sim };
        }
        if (best) cands.push({ photo: p, face: best.face });
      }
      if (cands.length >= 2) persons.push({ baseFace: bf, candidates: cands });
    }
    if (!persons.length) throw new Error('未找到可跨图比较的人脸（连拍间隔可能过大）');

    // 每人拼板评审
    let composite = sharp(buffers.get(base.id));
    const overlays = [];
    let replaced = 0;
    for (let i = 0; i < persons.length; i += 1) {
      const person = persons[i];
      step(`评审第 ${i + 1}/${persons.length} 个人的最佳瞬间`);
      const cands = [];
      for (const c of person.candidates) {
        const meta = c.photo.id === base.id ? { width: baseW, height: baseH } : await sharp(buffers.get(c.photo.id)).metadata();
        cands.push({
          photoId: c.photo.id,
          face: c.face,
          imageBuffer: buffers.get(c.photo.id),
          cropRect: bboxToRect(c.face, meta.width, meta.height, CROP_MARGIN),
          imgW: meta.width,
          imgH: meta.height,
        });
      }
      const bestIdx = await pickBestCandidate(cands);
      if (bestIdx === null || bestIdx === 0) continue; // 基准图已是最佳（第 0 位）或模型失败

      step(`替换第 ${i + 1}/${persons.length} 个人的人脸`);
      const chosen = cands[bestIdx];
      const targetRect = bboxToRect(person.baseFace, baseW, baseH, PASTE_MARGIN);
      const sourceRect = bboxToRect(chosen.face, chosen.imgW, chosen.imgH, PASTE_MARGIN);
      const patch = await sharp(chosen.imageBuffer)
        .extract(sourceRect)
        .resize(targetRect.width, targetRect.height, { fit: 'fill' })
        .toBuffer();
      const feathered = await sharp(patch)
        .composite([{ input: featherMaskSvg(targetRect.width, targetRect.height), blend: 'dest-in' }])
        .png()
        .toBuffer();
      overlays.push({ input: feathered, left: targetRect.left, top: targetRect.top });
      replaced += 1;
    }

    if (!replaced) {
      job.status = 'done_noop';
      job.step = '基准图每个人已是最佳状态，无需合成';
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
    job.step = `完成：替换了 ${replaced} 张人脸`;
  } catch (err) {
    job.status = 'failed';
    job.error = err && err.message ? err.message : String(err);
    console.error('[group_rescue] job failed:', job.error);
  }
}

function startJob(photoIds, orgId) {
  gcJobs();
  const jobId = newJobId();
  const job = { status: 'running', step: '排队中', createdAt: Date.now() };
  jobs.set(jobId, job);
  runJob(job, photoIds, orgId);
  return jobId;
}

module.exports = { startJob, getJob };
