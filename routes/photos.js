const express = require('express');
const router = express.Router();
const { pool, buildUploadUrl, buildInternalMediaUrl } = require('../db');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');
const keys = require('../config/keys');
const cosStorage = require('../lib/cos_storage');
const JWT_SECRET = keys.JWT_SECRET;
// 与 upload.js/app.js 保持一致：优先使用 UPLOAD_ABS_DIR 环境变量（从 config/keys 读取）
const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
const uploadRoot = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
  ? uploadsAbsDir
  : path.join(uploadsAbsDir, 'uploads');

// 当图片迁移到远程对象存储（如腾讯云 COS）时，
// 默认在部署到没有本地 uploads 的环境（例如 ECS）时跳过本地文件存在性检查，
// 或者可通过环境变量 UPLOAD_SKIP_LOCAL_FILE_CHECK=1 强制跳过。
const skipLocalFileCheck = (() => {
  const envVal = String(process.env.UPLOAD_SKIP_LOCAL_FILE_CHECK || '').trim().toLowerCase();
  if (envVal === '1' || envVal === 'true' || envVal === 'yes') return true;
  // 如果配置了 UPLOAD_BASE_URL 并且是一个 http(s) 地址且不是 localhost/127.0.0.1，则默认跳过本地检查
  try {
    const base = (keys.UPLOAD_BASE_URL || '').trim();
    if (base && /^https?:\/\//i.test(base) && !/localhost|127\.0\.0\.1/.test(base)) return true;
  } catch (e) { }
  // 如果没有配置 UPLOAD_ABS_DIR，说明没有本地 uploads 目录，跳过本地检查
  if (!keys.UPLOAD_ABS_DIR) return true;
  return false;
})();

// ========= 1) 照片列表接口：支持 projectId + random =========
// 如果挂在 /api/photos 下：GET /api/photos?projectId=1&limit=4&random=1&type=normal(可选)
const { requirePermission, requireAdmin, hasPermissionForUserId } = require('../lib/permissions');
const MAX_SEARCH_PAGE_SIZE = 100;
const MAX_SEARCH_TOKENS = 5;
const MAX_SEARCH_QUERY_LEN = 64;
const MAX_DELETE_PHOTOS = Math.max(1, Number(process.env.PHOTO_DELETE_MAX_IDS || 200));
// 与前端中转站容量(transferStore.MAX_COUNT)保持一致；不一致会出现"存得下却打不了包"(413)
const MAX_ZIP_PHOTOS = Math.max(1, Number(process.env.PHOTO_ZIP_MAX_IDS || 1000));
const ZIP_REMOTE_TIMEOUT_MS = Math.max(1000, Number(process.env.PHOTO_ZIP_REMOTE_TIMEOUT_MS || 20000));
const ZIP_MAX_REMOTE_BYTES = Math.max(1024 * 1024, Number(process.env.PHOTO_ZIP_MAX_REMOTE_BYTES || 1024 * 1024 * 1024));
const ZIP_MAX_RENDER_SOURCE_BYTES = Math.max(1024 * 1024, Number(process.env.PHOTO_ZIP_RENDER_MAX_SOURCE_BYTES || 128 * 1024 * 1024));
const RENDER_SOURCE_TIMEOUT_MS = Math.max(1000, Number(process.env.PHOTO_RENDER_SOURCE_TIMEOUT_MS || 20000));
const RENDER_MAX_SOURCE_BYTES = Math.max(1024 * 1024, Number(process.env.PHOTO_RENDER_MAX_SOURCE_BYTES || 128 * 1024 * 1024));
const TONE_ENGINE = 'mamage-tone-v2-acr-like';

async function cleanupDeletedPhotoRows(rows, context = {}) {
  const deletedFiles = [];
  const notFoundFiles = [];

  async function tryUnlink(absPath) {
    try {
      await fs.promises.unlink(absPath);
      deletedFiles.push(absPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        notFoundFiles.push(absPath);
      } else {
        console.error('[photos.delete] unlink error:', absPath, err && err.message ? err.message : err);
      }
    }
  }

  const storageDeleteResult = await cosStorage.deleteObjectsForPhotoRows(rows);
  if (storageDeleteResult.errors && storageDeleteResult.errors.length) {
    console.error('[photos.delete] COS delete errors:', storageDeleteResult.errors);
  }

  if (!skipLocalFileCheck) {
    for (const row of rows || []) {
      try {
        if (row.url && !/^https?:\/\//i.test(String(row.url))) {
          let rel = row.url.replace(/^\/uploads[\\/]/, '');
          rel = rel.split('/').join(path.sep);
          await tryUnlink(path.join(uploadRoot, rel));
        }

        if (row.thumbUrl && !/^https?:\/\//i.test(String(row.thumbUrl))) {
          let relt = row.thumbUrl.replace(/^\/uploads[\\/]/, '');
          relt = relt.split('/').join(path.sep);
          await tryUnlink(path.join(uploadRoot, relt));
        }
      } catch (e) {
        console.error('[photos.delete] check/unlink file error:', e && e.message ? e.message : e);
      }
    }
  }

  console.info(
    '[photos.delete.cleanup] user=%s deletedPhotoIds=%o deletedFiles=%d notFoundFiles=%d storageDeleted=%d storageErrors=%d',
    context.userId || null,
    context.photoIds || [],
    deletedFiles.length,
    notFoundFiles.length,
    (storageDeleteResult.deleted || []).length,
    (storageDeleteResult.errors || []).length
  );
}

async function populateReqUserFromAuthIfPresent(req) {
  try {
    if (req.user && req.user.id !== undefined) return;
    const auth = req.get('authorization') || '';
    const m = auth.match(/^Bearer\s+(.*)$/i);
    if (!m) return;
    const token = m[1];
    let payload;
    try { payload = jwt.verify(token, JWT_SECRET); } catch (e) { return; }
    if (!payload || !payload.id) return;
    const [rows] = await pool.query('SELECT id, organization_id, role FROM users WHERE id = ? LIMIT 1', [payload.id]);
    if (!rows || rows.length === 0) return;
    const u = rows[0];
    const org = (u.organization_id !== undefined && u.organization_id !== null) ? Number(u.organization_id) : null;
    req.user = { id: u.id, role: u.role || null, organization_id: org };
  } catch (e) {
    return;
  }
}

function isDemoRequest(req) {
  const raw = req && req.query ? String(req.query.demo || '').trim().toLowerCase() : '';
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y';
}

function getScopedOrgIdFromReq(req) {
  const authOrgId = req && req.user && req.user.organization_id !== undefined && req.user.organization_id !== null
    ? parseInt(req.user.organization_id, 10)
    : null;
  if (authOrgId !== null && Number.isFinite(authOrgId)) return authOrgId;
  if (!isDemoRequest(req)) return null;
  const demoOrgRaw = process.env.DEMO_ORGANIZATION_ID || process.env.PUBLIC_ORGANIZATION_ID || '';
  const demoOrgId = parseInt(String(demoOrgRaw).trim(), 10);
  if (!Number.isFinite(demoOrgId) || demoOrgId <= 0) return null;
  return demoOrgId;
}

function escapeLikeToken(input) {
  return String(input || '').replace(/[#%_]/g, '#$&');
}

function tokenizeSearchQuery(query) {
  const normalized = String(query || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_SEARCH_QUERY_LEN);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TOKENS);
}

function parsePhotoTags(rawTags) {
  if (!rawTags) return null;
  if (Array.isArray(rawTags)) return rawTags;
  try {
    const parsed = typeof rawTags === 'string' ? JSON.parse(rawTags) : rawTags;
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

function clampNumber(value, min, max, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function computeWbGains(temperature = 0, tint = 0) {
  const t = clampNumber(temperature, -100, 100, 0) / 100;
  const g = clampNumber(tint, -100, 100, 0) / 100;
  return [
    clampNumber(1 + t * 0.22, 0.5, 1.8, 1),
    clampNumber(1 - g * 0.16, 0.5, 1.8, 1),
    clampNumber(1 - t * 0.22, 0.5, 1.8, 1),
  ];
}

function normalizePhotoAdjustments(input) {
  if (input === null) return null;
  if (input === undefined) return undefined;

  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = JSON.parse(input);
    } catch (e) {
      return undefined;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;

  const brightness = clampNumber(parsed.brightness, -100, 100, 0);
  const contrast = clampNumber(parsed.contrast, -100, 100, 0);
  const highlights = clampNumber(parsed.highlights, -100, 100, 0);
  const shadows = clampNumber(parsed.shadows, -100, 100, 0);
  const whites = clampNumber(parsed.whites, -100, 100, 0);
  const blacks = clampNumber(parsed.blacks, -100, 100, 0);
  const temperature = clampNumber(parsed.temperature, -100, 100, 0);
  const tint = clampNumber(parsed.tint, -100, 100, 0);
  const rawGains = Array.isArray(parsed.wbGains) && parsed.wbGains.length >= 3
    ? parsed.wbGains
    : computeWbGains(temperature, tint);
  const wbGains = [0, 1, 2].map((idx) => clampNumber(rawGains[idx], 0.5, 1.8, 1));
  const source = String(parsed.source || 'manual').trim().slice(0, 24) || 'manual';

  return {
    version: 2,
    engine: TONE_ENGINE,
    brightness,
    contrast,
    highlights,
    shadows,
    whites,
    blacks,
    temperature,
    tint,
    wbGains,
    source,
    updatedAt: parsed.updatedAt ? String(parsed.updatedAt).slice(0, 64) : new Date().toISOString(),
  };
}

function parsePhotoAdjustments(rawAdjustments) {
  if (!rawAdjustments) return null;
  if (typeof rawAdjustments === 'object') return normalizePhotoAdjustments(rawAdjustments) || null;
  try {
    return normalizePhotoAdjustments(JSON.parse(rawAdjustments)) || null;
  } catch (e) {
    return null;
  }
}

function hasMeaningfulPhotoAdjustments(adjustments) {
  const a = normalizePhotoAdjustments(adjustments);
  if (!a) return false;
  return Math.abs(a.brightness) >= 0.01
    || Math.abs(a.contrast) >= 0.01
    || Math.abs(a.whites) >= 0.01
    || Math.abs(a.highlights) >= 0.01
    || Math.abs(a.shadows) >= 0.01
    || Math.abs(a.blacks) >= 0.01
    || Math.abs(a.temperature) >= 0.01
    || Math.abs(a.tint) >= 0.01;
}

function srgbToLinear(v) {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v, dither = 0) {
  const x = clampNumber(v, 0, 1, 0);
  const y = x <= 0.0031308 ? x * 12.92 : (1.055 * Math.pow(x, 1 / 2.4)) - 0.055;
  return clampNumber(Math.round((y * 255) + dither), 0, 255, 0);
}

function smoothstep(edge0, edge1, value) {
  if (edge0 === edge1) return value >= edge1 ? 1 : 0;
  const x = clampNumber((value - edge0) / (edge1 - edge0), 0, 1, 0);
  return x * x * (3 - (2 * x));
}

function curvePushPull(luma, sliderValue, mask, scale) {
  const amount = (clampNumber(sliderValue, -100, 100, 0) / 100) * clampNumber(mask, 0, 1, 0) * scale;
  if (Math.abs(amount) < 0.00001) return luma;
  const strength = 1 - Math.exp(-Math.abs(amount) * 2.2);
  if (amount > 0) {
    return clampNumber(luma + (1 - luma) * strength, 0, 1, luma);
  }
  return clampNumber(luma - luma * strength, 0, 1, luma);
}

function applyMidtoneContrast(luma, contrastValue) {
  const amount = (clampNumber(contrastValue, -100, 100, 0) / 100) * 0.58;
  if (Math.abs(amount) < 0.00001) return luma;
  const midMask = Math.pow(clampNumber(4 * luma * (1 - luma), 0, 1, 0), 0.72);
  return clampNumber(luma + amount * (luma - 0.5) * midMask, 0, 1, luma);
}

function acrLikeToneMapLuma(luma, adjustments) {
  let y = clampNumber(luma, 0, 1, 0);
  const highlightsMask = smoothstep(0.44, 0.82, y) * (1 - smoothstep(0.96, 1, y) * 0.42);
  y = curvePushPull(y, adjustments.highlights, highlightsMask, 0.34);

  const shadowsMask = (1 - smoothstep(0.18, 0.58, y)) * (0.38 + smoothstep(0.012, 0.11, y) * 0.62);
  y = curvePushPull(y, adjustments.shadows, shadowsMask, 0.36);

  const whitesMask = smoothstep(0.68, 0.985, y);
  y = curvePushPull(y, adjustments.whites, whitesMask, 0.3);

  const blacksMask = 1 - smoothstep(0.012, 0.32, y);
  y = curvePushPull(y, adjustments.blacks, blacksMask, 0.28);

  return applyMidtoneContrast(y, adjustments.contrast);
}

function fitRgbToLuma(lr, lg, lb, sourceLuma, targetLuma) {
  const y = clampNumber(targetLuma, 0, 1, 0);
  if (sourceLuma <= 0.000001) return [y, y, y];
  const ratio = clampNumber(y / sourceLuma, 0, 8, 1);
  let nr = lr * ratio;
  let ng = lg * ratio;
  let nb = lb * ratio;
  const maxChannel = Math.max(nr, ng, nb);
  if (maxChannel > 1) {
    const overshoot = maxChannel - 1;
    const blendToGray = smoothstep(0, 0.42, overshoot) * 0.72;
    nr += (y - nr) * blendToGray;
    ng += (y - ng) * blendToGray;
    nb += (y - nb) * blendToGray;
  }
  return [clampNumber(nr, 0, 1), clampNumber(ng, 0, 1), clampNumber(nb, 0, 1)];
}

function applyToneToRgb(r, g, b, adjustments, dither = 0) {
  const exposure = Math.pow(2, (adjustments.brightness / 100) * 1.12);
  const gains = Array.isArray(adjustments.wbGains) ? adjustments.wbGains : [1, 1, 1];
  let lr = srgbToLinear(r) * gains[0] * exposure;
  let lg = srgbToLinear(g) * gains[1] * exposure;
  let lb = srgbToLinear(b) * gains[2] * exposure;
  const luma = clampNumber((0.2126 * lr) + (0.7152 * lg) + (0.0722 * lb), 0, 1, 0);
  const mappedLuma = acrLikeToneMapLuma(luma, adjustments);
  [lr, lg, lb] = fitRgbToLuma(lr, lg, lb, luma, mappedLuma);
  return [linearToSrgb(lr, dither), linearToSrgb(lg, dither), linearToSrgb(lb, dither)];
}

const BAYER_4 = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
];

function orderedDither(x, y, strength = 0.55) {
  const idx = ((y & 3) * 4) + (x & 3);
  return ((BAYER_4[idx] / 15) - 0.5) * strength;
}

async function renderAdjustedPhotoBuffer(inputBuffer, adjustments, options = {}) {
  const sharp = require('sharp');
  const normalizedAdjustments = normalizePhotoAdjustments(adjustments) || normalizePhotoAdjustments({});
  const maxSize = Math.max(320, Math.min(4096, Number(options.maxSize || 4096)));
  const format = String(options.format || 'jpeg').toLowerCase();
  const quality = Math.max(70, Math.min(98, Number(options.quality || 96)));
  const pipeline = sharp(inputBuffer, { failOn: 'none' })
    .rotate()
    .resize({
      width: maxSize,
      height: maxSize,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .toColourspace('srgb')
    .flatten({ background: '#ffffff' });
  const { data, info } = await pipeline.raw({ depth: 'ushort' }).toBuffer({ resolveWithObject: true });
  const channels = info.channels || 3;
  const outputChannels = 3;
  const out = Buffer.alloc(info.width * info.height * outputChannels);

  let maxSample = 0;
  for (let offset = 0; offset + 1 < data.length; offset += 2) {
    const sample = data.readUInt16LE(offset);
    if (sample > maxSample) maxSample = sample;
  }
  const sampleToByte = maxSample > 1024 ? (255 / 65535) : 1;
  const pixelCount = info.width * info.height;

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const sourceOffset = pixelIndex * channels * 2;
    const targetOffset = pixelIndex * outputChannels;
    const x = pixelIndex % info.width;
    const y = Math.floor(pixelIndex / info.width);
    const dither = orderedDither(x, y, 0.62);
    const sourceR = data.readUInt16LE(sourceOffset) * sampleToByte;
    const sourceG = data.readUInt16LE(sourceOffset + 2) * sampleToByte;
    const sourceB = data.readUInt16LE(sourceOffset + 4) * sampleToByte;
    const [r, g, b] = applyToneToRgb(sourceR, sourceG, sourceB, normalizedAdjustments, dither);
    out[targetOffset] = r;
    out[targetOffset + 1] = g;
    out[targetOffset + 2] = b;
  }
  const image = sharp(out, {
    raw: {
      width: info.width,
      height: info.height,
      channels: outputChannels,
    },
  });

  if (format === 'webp') {
    return image.webp({ quality, smartSubsample: true }).toBuffer();
  }
  if (format === 'png') {
    return image.png({ compressionLevel: 8, palette: false }).toBuffer();
  }
  return image.jpeg({ quality, chromaSubsampling: '4:4:4', mozjpeg: true }).toBuffer();
}

async function getScopedPhotoSourceRow(req, id) {
  const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
  let sql = 'SELECT id, url, thumb_url AS thumbUrl, title, adjustments FROM photos WHERE id = ?';
  const params = [id];
  if (orgId === null) {
    sql += ' AND organization_id IS NULL';
  } else {
    sql += ' AND organization_id = ?';
    params.push(orgId);
  }
  sql += ' LIMIT 1';
  const [rows] = await pool.query(sql, params);
  return rows && rows.length ? rows[0] : null;
}

function resolvePhotoSourceTargetUrl(req, row, variant = 'original') {
  const requested = String(variant || 'original').toLowerCase();
  const raw = requested === 'thumb' ? (row.thumbUrl || row.url) : (row.url || row.thumbUrl);
  if (!raw) return '';
  const built = /^https?:\/\//i.test(String(raw)) ? String(raw) : buildUploadUrl(raw);
  return /^https?:\/\//i.test(built)
    ? built
    : `${req.protocol}://${req.get('host')}${String(built).startsWith('/') ? built : `/${built}`}`;
}

async function fetchImageBufferFromUrl(targetUrl, options = {}) {
  const maxBytes = Math.max(1024 * 1024, Number(options.maxBytes || RENDER_MAX_SOURCE_BYTES));
  // 服务端自取媒体走内网基址（若配置），避免经公网 cloudflared 回环超时
  const response = await fetch(buildInternalMediaUrl(targetUrl), {
    timeout: Math.max(1000, Number(options.timeoutMs || RENDER_SOURCE_TIMEOUT_MS)),
    headers: { 'User-Agent': 'MaMage photo renderer' },
  });

  if (!response.ok) {
    const err = new Error(`photo source unavailable: ${response.status}`);
    err.status = 502;
    throw err;
  }

  const contentType = response.headers.get('content-type') || 'image/jpeg';
  if (!/^image\//i.test(contentType)) {
    const err = new Error('photo source is not an image');
    err.status = 415;
    throw err;
  }

  const contentLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    const err = new Error('photo source too large');
    err.status = 413;
    throw err;
  }

  const buffer = await response.buffer();
  if (buffer.length > maxBytes) {
    const err = new Error('photo source too large');
    err.status = 413;
    throw err;
  }
  return { buffer, contentType };
}

function normalizeRenderFormat(input) {
  const raw = String(input || 'jpeg').trim().toLowerCase();
  if (raw === 'jpg' || raw === 'jpeg') return 'jpeg';
  if (raw === 'webp') return 'webp';
  if (raw === 'png') return 'png';
  return '';
}

function getRenderedContentType(format) {
  if (format === 'webp') return 'image/webp';
  if (format === 'png') return 'image/png';
  return 'image/jpeg';
}

function parseProjectPhotoIds(existing) {
  if (!existing) return [];
  if (Array.isArray(existing)) return existing.map(Number).filter(Number.isFinite);
  if (typeof existing === 'string') {
    try {
      const parsed = JSON.parse(existing);
      if (Array.isArray(parsed)) return parsed.map(Number).filter(Number.isFinite);
    } catch (e) {
      // fall back below
    }
    return existing.split(',').map((s) => Number(String(s).trim())).filter(Number.isFinite);
  }
  return [];
}

// GET /api/photos - require permission and organization scope
router.get('/', requirePermission('photos.view'), async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (Number.isNaN(limit) || limit <= 0 || limit > 100) {
      limit = 10;
    }

    const type = req.query.type || null;
    const projectId = req.query.projectId
      ? parseInt(req.query.projectId, 10)
      : null;
    const random = req.query.random === '1' || req.query.random === 'true';

    let sql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id      AS projectId,
        p.timeline_section_id AS timelineSectionId,
        p.url,
        p.thumb_url       AS thumbUrl,
        p.playback_url    AS playbackUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.ai_status       AS aiStatus,
        p.ai_score        AS aiScore,
        p.ai_quality      AS aiQuality,
        p.ai_error        AS aiError,
        p.ai_started_at   AS aiStartedAt,
        p.ai_finished_at  AS aiFinishedAt,
        p.type,
        p.photographer_id AS photographerId,
        u.name            AS photographerName,
        pts.name          AS timelineSectionName,
        pts.section_time  AS timelineSectionTime,
        p.created_at      AS createdAt,
        p.updated_at      AS updatedAt
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
      LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
    `;
    const conds = [];
    const params = [];

    if (type) {
      conds.push('p.type = ?');
      params.push(type);
    }
    if (!Number.isNaN(projectId) && projectId) {
      conds.push('p.project_id = ?');
      params.push(projectId);
    }

    // organization scoping: only return photos for user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    if (orgId === null) {
      conds.push('p.organization_id IS NULL');
    } else {
      conds.push('p.organization_id = ?');
      params.push(orgId);
    }

    if (conds.length > 0) {
      sql += ' WHERE ' + conds.join(' AND ');
    }

    if (random) {
      sql += ' ORDER BY RAND()';
    } else {
      sql += ' ORDER BY p.created_at DESC';
    }

    sql += ' LIMIT ?';
    params.push(limit);

    let rows;
    try {
      [rows] = await pool.query(sql, params);
    } catch (colErr) {
      // 缺列降级（迁移 20260711_001 尚未执行时）：去掉 ai_score/ai_quality 重查
      if (colErr && (colErr.code === 'ER_BAD_FIELD_ERROR' || String(colErr.message || '').includes('Unknown column'))) {
        const degraded = sql
          .replace('p.ai_score        AS aiScore,', '')
          .replace('p.ai_quality      AS aiQuality,', '');
        [rows] = await pool.query(degraded, params);
      } else {
        throw colErr;
      }
    }

    const mapped = rows.map((p) => {
      // 如果文件不存在，返回一个内联 SVG 占位图（data URL）以避免浏览器断图
      function resolveUrl(raw) {
        if (!raw) return null;
        const str = String(raw);

        // 远程 URL 直接透传（例如 COS 返回的 https://bucket.cos...）
        if (/^https?:\/\//i.test(str)) {
          return str;
        }

        const finalUrl = buildUploadUrl(str);

        if (skipLocalFileCheck) {
          return finalUrl;
        }

        try {
          let rel = str;
          if (rel.startsWith('/uploads/')) {
            rel = rel.replace(/^\/uploads[\\/]/, '');
          } else if (rel.startsWith('uploads/')) {
            rel = rel.replace(/^uploads[\\/]/, '');
          }
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          if (fs.existsSync(abs)) return finalUrl;
        } catch (e) {
          // 本地检查失败时忽略，后面走占位图
        }

        // simple SVG placeholder（本地文件不存在且未跳过检查时使用）
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='%23f3f3f3'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='20' fill='%23999'>占位图</text></svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      }

      return {
        ...p,
        url: resolveUrl(p.url),
        thumbUrl: resolveUrl(p.thumbUrl),
        playbackUrl: resolveUrl(p.playbackUrl),
        playback_url: resolveUrl(p.playbackUrl),
        description: p.description || null,
        adjustments: parsePhotoAdjustments(p.adjustments),
        aiStatus: p.aiStatus || null,
        aiScore: p.aiScore !== undefined && p.aiScore !== null ? p.aiScore : null,
        aiQuality: (() => { try { return typeof p.aiQuality === 'string' ? JSON.parse(p.aiQuality) : (p.aiQuality || null); } catch (e) { return null; } })(),
        aiError: p.aiError || null,
        aiStartedAt: p.aiStartedAt || null,
        aiFinishedAt: p.aiFinishedAt || null
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error('GET /api/photos error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 获取随机风景（scenery 项目）照片
// GET /api/photos/scenery/random?limit=4&random=1
// 说明：风景由 projects.type = 'scenery' 决定
router.get('/scenery/random', requirePermission('photos.view'), async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (Number.isNaN(limit) || limit <= 0 || limit > 100) {
      limit = 4;
    }
    const random = req.query.random === '1' || req.query.random === 'true' || req.query.random === undefined;

    // organization scoping: only return photos for user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;

    let sql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id      AS projectId,
        p.timeline_section_id AS timelineSectionId,
        p.url,
        p.thumb_url       AS thumbUrl,
        p.playback_url    AS playbackUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.ai_status       AS aiStatus,
        p.ai_error        AS aiError,
        p.ai_started_at   AS aiStartedAt,
        p.ai_finished_at  AS aiFinishedAt,
        p.type,
        p.photographer_id AS photographerId,
        u.name            AS photographerName,
        pts.name          AS timelineSectionName,
        pts.section_time  AS timelineSectionTime,
        p.created_at      AS createdAt,
        p.updated_at      AS updatedAt
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
      INNER JOIN projects pr ON p.project_id = pr.id
      LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
      WHERE pr.type = 'scenery'
    `;

    const params = [];
    if (orgId === null) {
      sql += ' AND p.organization_id IS NULL';
    } else {
      sql += ' AND p.organization_id = ?';
      params.push(orgId);
    }

    if (random) {
      sql += ' ORDER BY RAND()';
    } else {
      sql += ' ORDER BY p.created_at DESC';
    }

    sql += ' LIMIT ?';
    params.push(limit);

    const [rows] = await pool.query(sql, params);

    const mapped = (rows || []).map((p) => {
      function resolveUrl(raw) {
        if (!raw) return null;
        const str = String(raw);
        if (/^https?:\/\//i.test(str)) return str;

        const finalUrl = buildUploadUrl(str);
        if (skipLocalFileCheck) return finalUrl;

        try {
          let rel = str;
          if (rel.startsWith('/uploads/')) {
            rel = rel.replace(/^\/uploads[\\/]/, '');
          } else if (rel.startsWith('uploads/')) {
            rel = rel.replace(/^uploads[\\/]/, '');
          }
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          if (fs.existsSync(abs)) return finalUrl;
        } catch (e) {
          // ignore
        }

        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'><rect width='100%' height='100%' fill='%23f3f3f3'/><text x='50%' y='50%' dominant-baseline='middle' text-anchor='middle' font-size='20' fill='%23999'>占位图</text></svg>`;
        return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
      }

      return {
        ...p,
        url: resolveUrl(p.url),
        thumbUrl: resolveUrl(p.thumbUrl),
        playbackUrl: resolveUrl(p.playbackUrl),
        playback_url: resolveUrl(p.playbackUrl),
        description: p.description || null,
        adjustments: parsePhotoAdjustments(p.adjustments),
        aiStatus: p.aiStatus || null,
        aiError: p.aiError || null,
        aiStartedAt: p.aiStartedAt || null,
        aiFinishedAt: p.aiFinishedAt || null
      };
    });

    res.json(mapped);
  } catch (err) {
    console.error('GET /api/photos/scenery/random error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 基于数据库的权限检查（使用 role_permissions 表）

// 照片删除（仅 admin）
// GET /api/photos/search?q=xxx&page=1&pageSize=20&projectId=1&sort=relevance|newest
router.get('/search', async (req, res) => {
  try {
    await populateReqUserFromAuthIfPresent(req);
    const userId = req && req.user && req.user.id ? Number(req.user.id) : null;
    if (userId) {
      const ok = await hasPermissionForUserId(userId, 'photos.view');
      if (!ok) return res.status(403).json({ error: 'forbidden' });
    } else if (!isDemoRequest(req)) {
      return res.status(401).json({ error: 'Missing Authorization Bearer token' });
    }

    let page = parseInt(req.query.page, 10);
    let pageSize = parseInt(req.query.pageSize, 10);
    const rawSort = String(req.query.sort || '').toLowerCase();
    const sort = rawSort === 'newest' ? 'newest' : 'relevance';
    const tokens = tokenizeSearchQuery(req.query.q || '');

    if (!Number.isFinite(page) || page <= 0) page = 1;
    if (!Number.isFinite(pageSize) || pageSize <= 0 || pageSize > MAX_SEARCH_PAGE_SIZE) {
      pageSize = 20;
    }

    const hasProjectIdParam = req.query.projectId !== undefined && req.query.projectId !== null && String(req.query.projectId).trim() !== '';
    let projectId = null;
    if (hasProjectIdParam) {
      projectId = parseInt(req.query.projectId, 10);
      if (!Number.isFinite(projectId) || projectId <= 0) {
        return res.status(400).json({ error: 'invalid projectId' });
      }
    }

    const whereClauses = [];
    const whereParams = [];

    const orgId = getScopedOrgIdFromReq(req);
    if (orgId === null) {
      whereClauses.push('p.organization_id IS NULL');
    } else {
      whereClauses.push('p.organization_id = ?');
      whereParams.push(orgId);
    }

    if (projectId) {
      whereClauses.push('p.project_id = ?');
      whereParams.push(projectId);
    }

    if (tokens.length > 0) {
      tokens.forEach((token) => {
        const escaped = escapeLikeToken(token);
        const like = `%${escaped}%`;
        whereClauses.push(`(
          LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(p.ocr_text, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(CAST(p.tags AS CHAR), '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(p.url, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(p.thumb_url, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(pts.name, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(u.nickname, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(u.student_no, '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(CAST(p.photographer_id AS CHAR), '')) LIKE ? ESCAPE '#'
          OR LOWER(COALESCE(CONCAT('摄影师#', CAST(p.photographer_id AS CHAR)), '')) LIKE ? ESCAPE '#'
        )`);
        whereParams.push(like, like, like, like, like, like, like, like, like, like, like, like, like);
      });
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';
    const baseFromSql = `
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
      LEFT JOIN projects pr ON p.project_id = pr.id
      LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
    `;

    const [countRows] = await pool.query(
      `SELECT COUNT(*) AS total ${baseFromSql} ${whereSql}`,
      whereParams
    );
    const total = (countRows && countRows[0] && Number(countRows[0].total)) || 0;
    const offset = (page - 1) * pageSize;

    const scoreParts = [];
    const scoreParams = [];
    if (tokens.length > 0) {
      tokens.forEach((token) => {
        const escaped = escapeLikeToken(token);
        const prefixLike = `${escaped}%`;
        const containLike = `%${escaped}%`;
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#' THEN 30 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#' THEN 26 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(pts.name, '')) LIKE ? ESCAPE '#' THEN 25 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '#' THEN 24 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.nickname, '')) LIKE ? ESCAPE '#' THEN 24 ELSE 0 END`);
        scoreParams.push(prefixLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.title, '')) LIKE ? ESCAPE '#' THEN 16 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(pr.name, '')) LIKE ? ESCAPE '#' THEN 14 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(pts.name, '')) LIKE ? ESCAPE '#' THEN 13 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.name, '')) LIKE ? ESCAPE '#' THEN 12 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.nickname, '')) LIKE ? ESCAPE '#' THEN 12 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(u.student_no, '')) LIKE ? ESCAPE '#' THEN 8 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(CAST(p.photographer_id AS CHAR), '')) LIKE ? ESCAPE '#' THEN 6 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(CONCAT('摄影师#', CAST(p.photographer_id AS CHAR)), '')) LIKE ? ESCAPE '#' THEN 6 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.description, '')) LIKE ? ESCAPE '#' THEN 10 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.ocr_text, '')) LIKE ? ESCAPE '#' THEN 10 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(CAST(p.tags AS CHAR), '')) LIKE ? ESCAPE '#' THEN 10 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.url, '')) LIKE ? ESCAPE '#' THEN 4 ELSE 0 END`);
        scoreParams.push(containLike);
        scoreParts.push(`CASE WHEN LOWER(COALESCE(p.thumb_url, '')) LIKE ? ESCAPE '#' THEN 4 ELSE 0 END`);
        scoreParams.push(containLike);
      });
    }
    const relevanceScoreSql = scoreParts.length ? scoreParts.join(' + ') : '0';
    const orderBySql = sort === 'relevance' && tokens.length > 0
      ? 'ORDER BY relevanceScore DESC, p.created_at DESC, p.id DESC'
      : 'ORDER BY p.created_at DESC, p.id DESC';

    const selectSql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id AS projectId,
        pr.name AS projectName,
        p.timeline_section_id AS timelineSectionId,
        pts.name AS timelineSectionName,
        pts.section_time AS timelineSectionTime,
        p.url,
        p.thumb_url AS thumbUrl,
        p.playback_url AS playbackUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.ai_status AS aiStatus,
        p.ai_error AS aiError,
        p.ai_started_at AS aiStartedAt,
        p.ai_finished_at AS aiFinishedAt,
        p.type,
        p.photographer_id AS photographerId,
        COALESCE(NULLIF(u.name, ''), NULLIF(u.nickname, '')) AS photographerName,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt,
        ${relevanceScoreSql} AS relevanceScore
      ${baseFromSql}
      ${whereSql}
      ${orderBySql}
      LIMIT ? OFFSET ?
    `;
    const selectParams = [...scoreParams, ...whereParams, pageSize, offset];
    const [rows] = await pool.query(selectSql, selectParams);

    const list = (rows || []).map((p) => ({
      id: p.id,
      uuid: p.uuid,
      projectId: p.projectId,
      projectName: p.projectName || null,
      timelineSectionId: p.timelineSectionId || null,
      timelineSectionName: p.timelineSectionName || null,
      timelineSectionTime: p.timelineSectionTime || null,
      url: p.url ? buildUploadUrl(p.url) : null,
      thumbUrl: p.thumbUrl ? buildUploadUrl(p.thumbUrl) : null,
      playbackUrl: p.playbackUrl ? buildUploadUrl(p.playbackUrl) : null,
      playback_url: p.playbackUrl ? buildUploadUrl(p.playbackUrl) : null,
      title: p.title || null,
      description: p.description || null,
      adjustments: parsePhotoAdjustments(p.adjustments),
      tags: parsePhotoTags(p.tags),
      aiStatus: p.aiStatus || null,
      aiError: p.aiError || null,
      aiStartedAt: p.aiStartedAt || null,
      aiFinishedAt: p.aiFinishedAt || null,
      type: p.type,
      photographerId: p.photographerId || null,
      photographerName: p.photographerName || null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      relevanceScore: Number(p.relevanceScore) || 0,
    }));

    const hasMore = page * pageSize < total;
    res.json({
      list,
      page,
      pageSize,
      total,
      hasMore,
      q: String(req.query.q || '').trim(),
      tokens,
      sort,
    });
  } catch (err) {
    console.error('GET /api/photos/search error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/delete', requirePermission('photos.delete'), async (req, res) => {
  let rows = [];
  let foundIds = [];
  let notFoundIds = [];
  try {
    let ids = req.body.photoIds;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'photoIds must be a non-empty array' });
    }

    ids = ids
      .map((n) => parseInt(n, 10))
      .filter((n) => !Number.isNaN(n));

    ids = Array.from(new Set(ids));

    // debug log: who requested deletion and which ids
    try { console.log('[photos.delete] requested by user=%s ids=%o', req.user && req.user.id, ids); } catch (e) { }

    if (ids.length === 0) {
      return res.status(400).json({ error: 'no valid photo id' });
    }
    if (ids.length > MAX_DELETE_PHOTOS) {
      return res.status(413).json({ error: 'TOO_MANY_PHOTOS', maxPhotoIds: MAX_DELETE_PHOTOS });
    }

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();

      let selSql = 'SELECT id, project_id AS projectId, url, thumb_url AS thumbUrl, playback_url AS playbackUrl FROM photos WHERE id IN (?)';
      const selParams = [ids];
      if (orgId === null) {
        selSql += ' AND organization_id IS NULL';
      } else {
        selSql += ' AND organization_id = ?';
        selParams.push(orgId);
      }
      const [selectedRows] = await conn.query(selSql, selParams);
      rows = selectedRows || [];

      if (rows.length === 0) {
        await conn.rollback();
        return res.json({ deletedIds: [], notFoundIds: ids });
      }

      foundIds = rows.map((r) => r.id);
      notFoundIds = ids.filter((id) => !foundIds.includes(id));

      await conn.query('DELETE FROM photos WHERE id IN (?)', [foundIds]);

      const byProject = {};
      for (const r of rows) {
        if (!r.projectId) continue;
        byProject[r.projectId] = byProject[r.projectId] || [];
        byProject[r.projectId].push(r.id);
      }

      for (const [projIdStr, removedIds] of Object.entries(byProject)) {
        const projId = Number(projIdStr);
        const [projRows] = await conn.query('SELECT photo_ids FROM projects WHERE id = ? FOR UPDATE', [projId]);
        if (!projRows || !projRows.length) continue;
        const arr = parseProjectPhotoIds(projRows[0].photo_ids).filter((id) => !removedIds.includes(id));
        await conn.query('UPDATE projects SET photo_ids = ? WHERE id = ?', [arr.length ? JSON.stringify(arr) : null, projId]);
      }

      await conn.commit();
    } catch (err) {
      try { await conn.rollback(); } catch (e) { }
      throw err;
    } finally {
      try { conn.release(); } catch (e) { }
    }

    const cleanupRows = rows.slice();
    const cleanupContext = { userId: req.user && req.user.id, photoIds: foundIds.slice() };
    setImmediate(() => {
      cleanupDeletedPhotoRows(cleanupRows, cleanupContext).catch((err) => {
        console.error('[photos.delete.cleanup] failed:', err && err.stack ? err.stack : err);
      });
    });
    console.info('[photos.delete] user=%s deletedPhotoIds=%o cleanupQueued=1', req.user && req.user.id, foundIds);

    res.json({
      deletedIds: foundIds,
      notFoundIds,
      storageDeleteQueued: true,
    });
  } catch (err) {
    console.error('POST /api/photos/delete error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// POST /api/photos/assign-section
// 批量把照片移入/移出时间线环节。body: { photoIds: [1,2,3], timelineSectionId: 5 | null }
// timelineSectionId 为 null/空 表示移出（回落"未归类"）
router.post('/assign-section', requirePermission('photos.edit'), async (req, res) => {
  try {
    const ids = Array.isArray(req.body && req.body.photoIds)
      ? req.body.photoIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    if (!ids.length) return res.status(400).json({ error: 'no valid photo id' });
    if (ids.length > 500) return res.status(413).json({ error: 'TOO_MANY_PHOTOS', maxPhotoIds: 500 });

    const rawSection = req.body ? (req.body.timelineSectionId ?? req.body.timeline_section_id ?? req.body.sectionId ?? null) : null;
    const sectionId = rawSection === null || rawSection === undefined || String(rawSection).trim() === ''
      ? null
      : parseInt(rawSection, 10);
    if (sectionId !== null && (!Number.isFinite(sectionId) || sectionId <= 0)) {
      return res.status(400).json({ error: 'INVALID_TIMELINE_SECTION' });
    }

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;

    let selSql = 'SELECT id, project_id AS projectId FROM photos WHERE id IN (?)';
    const selParams = [ids];
    if (orgId === null) selSql += ' AND organization_id IS NULL';
    else { selSql += ' AND organization_id = ?'; selParams.push(orgId); }
    const [rows] = await pool.query(selSql, selParams);
    if (!rows || !rows.length) return res.status(404).json({ error: 'photos not found' });

    if (sectionId !== null) {
      // 环节必须存在，且所有照片与环节属于同一项目（同 org 作用域）
      const [secRows] = await pool.query(
        `SELECT s.id, s.project_id AS projectId
         FROM project_timeline_sections s
         JOIN projects p ON p.id = s.project_id
         WHERE s.id = ?${orgId === null ? ' AND p.organization_id IS NULL' : ' AND p.organization_id = ?'}`,
        orgId === null ? [sectionId] : [sectionId, orgId]
      );
      const section = secRows && secRows[0];
      if (!section) return res.status(404).json({ error: 'Section not found' });
      const mismatched = rows.filter((r) => Number(r.projectId) !== Number(section.projectId));
      if (mismatched.length) {
        return res.status(400).json({ error: 'PHOTO_PROJECT_MISMATCH', photoIds: mismatched.map((r) => r.id) });
      }
    }

    const foundIds = rows.map((r) => r.id);
    let updSql = 'UPDATE photos SET timeline_section_id = ? WHERE id IN (?)';
    const updParams = [sectionId, foundIds];
    if (orgId === null) updSql += ' AND organization_id IS NULL';
    else { updSql += ' AND organization_id = ?'; updParams.push(orgId); }
    const [result] = await pool.query(updSql, updParams);

    return res.json({
      ok: true,
      updated: result.affectedRows || 0,
      timelineSectionId: sectionId,
      notFoundIds: ids.filter((id) => !foundIds.includes(id)),
    });
  } catch (err) {
    console.error('POST /api/photos/assign-section error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/photos/group-rescue
// 合影救场：body { basePhotoId, referencePhotoIds?: [0-4张] }（参考可跨相册；无参考时自动从人脸库找替补）。
// 兼容旧版 body { photoIds: [..] }（自动选最高分为基底）。异步任务，返回 { jobId }
router.post('/group-rescue', requirePermission('photos.edit'), async (req, res) => {
  try {
    const body = req.body || {};
    const basePhotoId = body.basePhotoId !== undefined ? parseInt(body.basePhotoId, 10) : null;
    const referencePhotoIds = Array.isArray(body.referencePhotoIds)
      ? body.referencePhotoIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0)
      : [];
    const legacyIds = Array.isArray(body.photoIds)
      ? body.photoIds.map((v) => parseInt(v, 10)).filter((n) => Number.isFinite(n) && n > 0)
      : [];

    let params = null;
    if (Number.isFinite(basePhotoId) && basePhotoId > 0) {
      if (referencePhotoIds.length > 4) return res.status(413).json({ error: 'TOO_MANY_REFERENCES', maxReferences: 4 });
      params = { basePhotoId, referencePhotoIds };
    } else if (legacyIds.length >= 2) {
      if (legacyIds.length > 5) return res.status(413).json({ error: 'TOO_MANY_PHOTOS', maxPhotoIds: 5 });
      params = { photoIds: legacyIds };
    } else {
      return res.status(400).json({ error: 'NEED_BASE_PHOTO' });
    }

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    const jobId = require('../lib/group_rescue').startJob(params, orgId);
    return res.json({ ok: true, jobId });
  } catch (err) {
    console.error('POST /api/photos/group-rescue error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/photos/group-rescue/:jobId — 轮询任务进度
router.get('/group-rescue/:jobId', requirePermission('photos.edit'), async (req, res) => {
  const job = require('../lib/group_rescue').getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'JOB_NOT_FOUND' });
  return res.json(job);
});

// POST /api/photos/zip
// 请求 body: { photoIds: [1,2,3], zipName: 'my-photos' }
// 分享页(公开、无登录态)也要能打包：带 shareCode 时改用"分享码鉴权"，
// 并把可下载范围严格钉死在该分享自身的照片里（下方 resolveShareZipScope）。
async function resolveShareZipScope(code) {
  const [rows] = await pool.query(
    'SELECT id, code, share_type, project_id, organization_id, expires_at, revoked_at FROM share_links WHERE code = ? LIMIT 1',
    [String(code || '').trim()]
  );
  if (!rows || rows.length === 0) return { error: 'NOT_FOUND', status: 404 };
  const s = rows[0];
  if (s.revoked_at) return { error: 'REVOKED', status: 410 };
  if (s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) return { error: 'EXPIRED', status: 410 };

  let allowed = [];
  if (s.share_type === 'collection') {
    const [items] = await pool.query('SELECT photo_id FROM share_link_items WHERE share_id = ?', [s.id]);
    allowed = (items || []).map((r) => Number(r.photo_id)).filter(Boolean);
  } else if (s.share_type === 'project') {
    const [ps] = await pool.query(
      `SELECT id FROM photos WHERE project_id = ?${s.organization_id === null ? ' AND organization_id IS NULL' : ' AND organization_id = ?'}`,
      s.organization_id === null ? [s.project_id] : [s.project_id, s.organization_id]
    );
    allowed = (ps || []).map((r) => Number(r.id)).filter(Boolean);
  } else {
    return { error: 'UNSUPPORTED_SHARE_TYPE', status: 400 };
  }
  return { orgId: s.organization_id === null ? null : parseInt(s.organization_id, 10), allowed: new Set(allowed) };
}

// 返回: application/zip attachment
router.post('/zip', (req, res, next) => {
  // 有 shareCode → 走公开分享路径（不要求登录）；否则维持原有登录鉴权
  if (req.body && req.body.shareCode) return next();
  return requirePermission('photos.view')(req, res, next);
}, async (req, res) => {
  try {
    const shareCode = req.body && req.body.shareCode ? String(req.body.shareCode).trim() : '';
    let shareScope = null;
    if (shareCode) {
      shareScope = await resolveShareZipScope(shareCode);
      if (shareScope.error) return res.status(shareScope.status).json({ error: shareScope.error });
      if (!shareScope.allowed.size) return res.status(404).json({ error: 'no photos found' });
    }

    let ids = Array.isArray(req.body.photoIds)
      ? Array.from(new Set(req.body.photoIds.map(n => parseInt(n, 10)).filter(n => !Number.isNaN(n))))
      : [];
    if (shareScope) {
      // 未指定就打包整个分享；指定了则取交集——越权 id 一律丢弃
      ids = ids.length ? ids.filter((id) => shareScope.allowed.has(id)) : Array.from(shareScope.allowed);
      if (!ids.length) return res.status(403).json({ error: 'PHOTOS_NOT_IN_SHARE' });
    }
    if (ids.length === 0) return res.status(400).json({ error: 'photoIds must be a non-empty array' });
    if (ids.length > MAX_ZIP_PHOTOS) {
      return res.status(413).json({ error: 'TOO_MANY_PHOTOS', maxPhotoIds: MAX_ZIP_PHOTOS });
    }

    // 延迟 require archiver，这样在缺少依赖时能返回友好提示
    let archiver;
    try {
      archiver = require('archiver');
    } catch (e) {
      console.error('archiver not installed:', e.message);
      return res.status(500).json({ error: 'Server requires module "archiver". Run: npm install archiver' });
    }

    // 查询照片及其 project_id
    // enforce organization scoping for zip：分享路径没有 req.user，用分享自身的组织，别让它落到 null 扫全库
    const orgId = shareScope
      ? shareScope.orgId
      : (req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null);
    let zipSql = `SELECT id, project_id AS projectId, timeline_section_id AS sectionId, url, thumb_url AS thumbUrl, title, adjustments FROM photos WHERE id IN (?)`;
    const zipParams = [ids];
    if (orgId === null) {
      zipSql += ' AND organization_id IS NULL';
    } else {
      zipSql += ' AND organization_id = ?';
      zipParams.push(orgId);
    }
    const [rows] = await pool.query(zipSql, zipParams);

    if (!rows || rows.length === 0) return res.status(404).json({ error: 'no photos found' });

    // 查询相关项目名
    const projIds = [...new Set(rows.map(r => r.projectId).filter(Boolean))];
    let projMap = {};
    if (projIds.length > 0) {
      const [projRows] = await pool.query(`SELECT id, name FROM projects WHERE id IN (?)`, [projIds]);
      for (const p of projRows) {
        projMap[p.id] = p.name || `project-${p.id}`;
      }
    }

    // 环节名：带时间线环节的相册，文件名里带上环节，便于下载后直接分辨
    const sectionIds = [...new Set(rows.map(r => r.sectionId).filter(Boolean))];
    const sectionMap = {};
    if (sectionIds.length > 0) {
      try {
        const [secRows] = await pool.query('SELECT id, name FROM project_timeline_sections WHERE id IN (?)', [sectionIds]);
        for (const s of secRows) {
          const n = String(s.name || '').trim();
          if (n) sectionMap[s.id] = n;
        }
      } catch (e) {
        console.warn('[photos.zip] load timeline sections failed, fallback to plain naming:', e.message);
      }
    }

    // prepare zip
    const rawZipName = req.body.zipName && String(req.body.zipName).trim() ? String(req.body.zipName).trim() : `photos-${Date.now()}`;
    const safeZipBase = rawZipName.replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, '_').slice(0, 96) || `photos-${Date.now()}`;
    const zipName = safeZipBase.toLowerCase().endsWith('.zip') ? safeZipBase : `${safeZipBase}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(zipName)}"; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    res.setHeader('X-Accel-Buffering', 'no');

    const archive = archiver('zip', { store: true, zlib: { level: 0 } });
    const activeRequests = new Set();
    let clientClosed = false;

    res.on('close', () => {
      if (res.writableEnded) return;
      clientClosed = true;
      for (const activeReq of activeRequests) {
        try { activeReq.destroy(new Error('CLIENT_CLOSED')); } catch (e) { }
      }
      try { archive.abort(); } catch (e) { }
    });

    archive.on('error', (err) => {
      console.error('archive error:', err.message);
      try { res.status(500).end(); } catch (e) { }
    });
    archive.on('warning', (err) => {
      console.warn('archive warning:', err && err.message ? err.message : err);
    });

    // pipe archive to response
    archive.pipe(res);

    // counters per project
    const counters = {};
    let addedFileCount = 0;

    const getExtFromUrl = (u) => {
      try {
        return path.extname(new URL(u).pathname) || '';
      } catch (e) {
        return path.extname(String(u || '')) || '';
      }
    };

    const appendRemoteFileToArchive = async (remoteUrl, nameInZip) => {
      try {
        if (clientClosed) return false;
        // ⚠️ 必须走内网回环：照片已迁 S3、本地磁盘无文件，调用方给的是 buildUploadUrl 的公网地址，
        // 直接 GET 会让 Mini 经 cloudflared 绕公网一圈回来取自己的图（实测 1.3MB/s vs 内网 16-27MB/s，慢 15 倍）。
        // buildInternalMediaUrl 只改写本站域名，外站 URL 原样返回，安全。
        const url = buildInternalMediaUrl(remoteUrl) || remoteUrl;
        const client = url.startsWith('https') ? require('https') : require('http');
        const { PassThrough } = require('stream');
        return await new Promise((resolve) => {
          const req = client.get(url, (response) => {
            // 响应已到达 → 撤掉空闲超时。zip 是边拉边发的流：客户端下载慢时背压会把本 socket
            // 按住长时间静止，这是正常现象不是故障；不撤的话 20s 空闲即被 destroy，
            // 表现为下载中途 ERR_INCOMPLETE_CHUNKED_ENCODING（用户实际踩到的 bug）。
            // 连接/首字节阶段的 20s 超时仍然保留（下方 setTimeout 只在响应前生效）。
            req.setTimeout(0);
            activeRequests.delete(req);
            // ⚠️ 响应已到 → 立刻撤掉空闲超时。zip 是边拉边发的流：客户端慢(公网隧道 ~0.7MB/s)时，
            // archiver 的背压会把源 socket 按住不动几十秒——那是正常背压，不是故障。
            // 留着 20s 空闲超时会把正常下载腰斩，客户端看到 ERR_INCOMPLETE_CHUNKED_ENCODING。
            // 连接/首字节阶段的超时仍由下面那次 setTimeout 负责；客户端断开由 res.on('close') 兜底。
            try { req.setTimeout(0); if (req.socket) req.socket.setTimeout(0); } catch (e) { /* ignore */ }
            if (response.statusCode >= 200 && response.statusCode < 300) {
              const contentLength = Number(response.headers['content-length'] || 0);
              if (Number.isFinite(contentLength) && contentLength > ZIP_MAX_REMOTE_BYTES) {
                console.warn('[photos.zip] remote file too large, skip:', remoteUrl, contentLength);
                response.resume();
                resolve(false);
                return;
              }
              const passthrough = new PassThrough();
              let received = 0;
              response.on('data', (chunk) => {
                received += chunk.length;
                if (received > ZIP_MAX_REMOTE_BYTES) {
                  console.warn('[photos.zip] remote stream exceeded max bytes, abort:', remoteUrl);
                  response.destroy(new Error('REMOTE_FILE_TOO_LARGE'));
                  passthrough.destroy(new Error('REMOTE_FILE_TOO_LARGE'));
                }
              });
              response.on('error', (err) => {
                console.error('[photos.zip] remote response error:', remoteUrl, err && err.message ? err.message : err);
                // 不销毁的话 passthrough 永不 end，archiver 会无限等待、整个 zip 挂死
                passthrough.destroy(err);
              });
              response.pipe(passthrough);
              archive.append(passthrough, { name: nameInZip, store: true });
              addedFileCount += 1;
              resolve(true);
              return;
            }
            console.warn('[photos.zip] remote file not available, skip:', remoteUrl, response.statusCode);
            response.resume();
            resolve(false);
          });
          activeRequests.add(req);
          req.setTimeout(ZIP_REMOTE_TIMEOUT_MS, () => {
            req.destroy(new Error('REMOTE_DOWNLOAD_TIMEOUT'));
          });
          req.on('error', (err) => {
            activeRequests.delete(req);
            console.error('[photos.zip] remote download error:', remoteUrl, err && err.message ? err.message : err);
            resolve(false);
          });
        });
      } catch (e) {
        console.error('[photos.zip] append remote file failed:', e && e.message ? e.message : e);
        return false;
      }
    };

    const fetchRemoteFileBuffer = async (remoteUrl) => {
      const response = await fetch(buildInternalMediaUrl(remoteUrl), { timeout: ZIP_REMOTE_TIMEOUT_MS });
      if (!response || !response.ok) {
        console.warn('[photos.zip] remote file not available for render:', remoteUrl, response && response.status);
        return null;
      }
      const contentLength = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0);
      if (Number.isFinite(contentLength) && contentLength > ZIP_MAX_RENDER_SOURCE_BYTES) {
        console.warn('[photos.zip] remote file too large for render:', remoteUrl, contentLength);
        return null;
      }
      const buffer = await response.buffer();
      if (buffer.length > ZIP_MAX_RENDER_SOURCE_BYTES) {
        console.warn('[photos.zip] remote rendered source exceeded max bytes:', remoteUrl, buffer.length);
        return null;
      }
      return buffer;
    };

    const appendAdjustedBufferToArchive = async (sourceBuffer, adjustments, nameInZip) => {
      try {
        if (clientClosed || !sourceBuffer || !hasMeaningfulPhotoAdjustments(adjustments)) return false;
        const rendered = await renderAdjustedPhotoBuffer(sourceBuffer, adjustments);
        archive.append(rendered, { name: nameInZip, store: true });
        addedFileCount += 1;
        return true;
      } catch (e) {
        console.error('[photos.zip] render adjusted photo failed:', e && e.message ? e.message : e);
        return false;
      }
    };

    // add files with project-based sequential naming
    for (const r of rows) {
      if (clientClosed) break;
      try {
        if (!r.url) continue;
        const rawPath = String(r.url).trim();
        if (!rawPath) continue;

        const projId = r.projectId || 0;
        const rawProjName = projMap[projId] || `project-${projId}`;
        // sanitize project name for file names
        const safeProjName = String(rawProjName).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_') || `project-${projId}`;
        // 环节名（有才加）：文件名形如 相册-环节-序号.jpg；序号按"每个环节"各自从 1 开始
        const rawSecName = r.sectionId ? (sectionMap[r.sectionId] || '') : '';
        const safeSecName = rawSecName ? (String(rawSecName).replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, '_')) : '';
        const namePrefix = safeSecName ? `${safeProjName}-${safeSecName}` : safeProjName;

        const counterKey = `${projId}:${r.sectionId || 0}`;
        counters[counterKey] = (counters[counterKey] || 0) + 1;
        const seq = counters[counterKey];
        const adjustments = parsePhotoAdjustments(r.adjustments);
        const shouldRenderAdjusted = hasMeaningfulPhotoAdjustments(adjustments);

        // 如果是远程 URL（例如 COS 上的图片），通过 HTTP(S) 下载并把响应流追加到 zip
        if (/^https?:\/\//i.test(rawPath)) {
          const ext = getExtFromUrl(rawPath);
          const originalNameInZip = `${namePrefix}-${seq}${ext}`;
          const nameInZip = shouldRenderAdjusted ? `${namePrefix}-${seq}.jpg` : originalNameInZip;
          if (shouldRenderAdjusted) {
            const sourceBuffer = await fetchRemoteFileBuffer(rawPath);
            if (sourceBuffer && await appendAdjustedBufferToArchive(sourceBuffer, adjustments, nameInZip)) continue;
          }
          await appendRemoteFileToArchive(rawPath, originalNameInZip);
        } else {
          // 本地文件处理（保留原有行为）
          let rel = rawPath.replace(/^\/?uploads[\\\/]/i, '');
          rel = rel.split('/').join(path.sep);
          const abs = path.join(uploadRoot, rel);
          if (!fs.existsSync(abs)) {
            // local miss -> fallback to remote original URL
            const fallbackRemoteUrl = buildUploadUrl(rawPath);
            if (/^https?:\/\//i.test(String(fallbackRemoteUrl || ''))) {
              const ext = getExtFromUrl(fallbackRemoteUrl);
              const originalNameInZip = `${namePrefix}-${seq}${ext}`;
              const nameInZip = shouldRenderAdjusted ? `${namePrefix}-${seq}.jpg` : originalNameInZip;
              if (shouldRenderAdjusted) {
                const sourceBuffer = await fetchRemoteFileBuffer(fallbackRemoteUrl);
                if (sourceBuffer && await appendAdjustedBufferToArchive(sourceBuffer, adjustments, nameInZip)) continue;
              }
              await appendRemoteFileToArchive(fallbackRemoteUrl, originalNameInZip);
              continue;
            }
            console.warn('[photos.zip] file not found and no remote fallback URL:', rawPath);
            continue;
          }

          const ext = path.extname(abs) || '';
          const originalNameInZip = `${namePrefix}-${seq}${ext}`;
          const nameInZip = shouldRenderAdjusted ? `${namePrefix}-${seq}.jpg` : originalNameInZip;
          if (shouldRenderAdjusted) {
            const stat = await fs.promises.stat(abs).catch(() => null);
            if (stat && stat.size <= ZIP_MAX_RENDER_SOURCE_BYTES) {
              const sourceBuffer = await fs.promises.readFile(abs);
              if (await appendAdjustedBufferToArchive(sourceBuffer, adjustments, nameInZip)) continue;
            }
          }
          archive.file(abs, { name: originalNameInZip, store: true });
          addedFileCount += 1;
        }
      } catch (e) {
        console.error('add file to zip error:', e && e.message ? e.message : e);
      }
    }

    if (addedFileCount === 0) {
      console.warn('[photos.zip] no files were added to archive, check photo urls and upload config');
    }

    // finalize
    if (!clientClosed) archive.finalize();
  } catch (err) {
    console.error('POST /api/photos/zip error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// POST /api/photos/:id/rendered
// Render adjusted image bytes server-side from the original/thumbnail source.
router.post('/:id/rendered', requirePermission('photos.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const row = await getScopedPhotoSourceRow(req, id);
    if (!row) return res.status(404).json({ error: 'photo not found' });

    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
    const variant = String(body.variant || req.query.variant || 'original').trim().toLowerCase();
    if (variant !== 'original' && variant !== 'thumb') {
      return res.status(400).json({ error: 'invalid variant' });
    }

    const format = normalizeRenderFormat(body.format || req.query.format || 'jpeg');
    if (!format) return res.status(400).json({ error: 'invalid format' });

    const defaultMaxSize = variant === 'thumb' ? 900 : 4096;
    const maxSize = clampNumber(body.maxSize || req.query.maxSize, 320, 4096, defaultMaxSize);
    const quality = clampNumber(body.quality || req.query.quality, 70, 98, format === 'webp' ? 92 : 96);
    const hasBodyAdjustments = Object.prototype.hasOwnProperty.call(body, 'adjustments');
    const rawAdjustments = hasBodyAdjustments ? body.adjustments : row.adjustments;
    let adjustments = normalizePhotoAdjustments(rawAdjustments);
    if (adjustments === undefined && rawAdjustments !== undefined && rawAdjustments !== null && rawAdjustments !== '') {
      return res.status(400).json({ error: 'invalid adjustments' });
    }
    if (!adjustments) adjustments = normalizePhotoAdjustments({});

    const targetUrl = resolvePhotoSourceTargetUrl(req, row, variant);
    if (!targetUrl) return res.status(404).json({ error: 'photo source not found' });

    const { buffer } = await fetchImageBufferFromUrl(targetUrl, {
      timeoutMs: RENDER_SOURCE_TIMEOUT_MS,
      maxBytes: RENDER_MAX_SOURCE_BYTES,
    });
    const rendered = await renderAdjustedPhotoBuffer(buffer, adjustments, { maxSize, format, quality });

    res.setHeader('Content-Type', getRenderedContentType(format));
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Vary', 'Authorization');
    res.setHeader('X-MaMage-Tone-Engine', TONE_ENGINE);
    res.setHeader('X-MaMage-Render-Variant', variant);
    return res.send(rendered);
  } catch (err) {
    const status = Number(err && err.status) || 500;
    console.error('POST /api/photos/:id/rendered error:', err && err.stack ? err.stack : err);
    return res.status(status).json({
      error: status === 500 ? 'Internal server error' : (err && err.message ? err.message : 'render failed'),
    });
  }
});


// GET /api/photos/:id/pixel-source
// Authenticated same-origin image bytes for front-end canvas analysis.
router.get('/:id/pixel-source', requirePermission('photos.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let sql = 'SELECT id, url, thumb_url AS thumbUrl FROM photos WHERE id = ?';
    const params = [id];
    if (orgId === null) {
      sql += ' AND organization_id IS NULL';
    } else {
      sql += ' AND organization_id = ?';
      params.push(orgId);
    }
    sql += ' LIMIT 1';

    const [rows] = await pool.query(sql, params);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'photo not found' });

    const row = rows[0];
    const variant = String(req.query.variant || 'thumb').toLowerCase();
    const raw = variant === 'original' ? (row.url || row.thumbUrl) : (row.thumbUrl || row.url);
    if (!raw) return res.status(404).json({ error: 'photo source not found' });

    const built = /^https?:\/\//i.test(String(raw)) ? String(raw) : buildUploadUrl(raw);
    const targetUrl = /^https?:\/\//i.test(built)
      ? built
      : `${req.protocol}://${req.get('host')}${String(built).startsWith('/') ? built : `/${built}`}`;
    const response = await fetch(buildInternalMediaUrl(targetUrl), {
      timeout: Math.max(1000, Number(process.env.PHOTO_PIXEL_SOURCE_TIMEOUT_MS || 15000)),
      headers: { 'User-Agent': 'MaMage pixel analyzer' },
    });

    if (!response.ok) {
      return res.status(502).json({ error: 'photo source unavailable', status: response.status });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!/^image\//i.test(contentType)) {
      return res.status(415).json({ error: 'photo source is not an image' });
    }

    const contentLength = response.headers.get('content-length');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (contentLength) res.setHeader('Content-Length', contentLength);
    response.body.on('error', (err) => {
      console.error('pixel-source stream error:', err && err.message ? err.message : err);
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    response.body.pipe(res);
  } catch (err) {
    console.error('GET /api/photos/:id/pixel-source error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// 获取单张照片（包含 photographerName）
// GET /api/photos/:id
router.get('/:id', requirePermission('photos.view'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let sql = `
      SELECT
        p.id,
        p.uuid,
        p.project_id AS projectId,
        p.timeline_section_id AS timelineSectionId,
        pts.name AS timelineSectionName,
        pts.section_time AS timelineSectionTime,
        p.url,
        p.thumb_url AS thumbUrl,
        p.playback_url AS playbackUrl,
        p.title,
        p.description,
        p.adjustments,
        p.tags,
        p.ai_status AS aiStatus,
        p.ai_score AS aiScore,
        p.ai_quality AS aiQuality,
        p.ai_error AS aiError,
        p.ai_started_at AS aiStartedAt,
        p.ai_finished_at AS aiFinishedAt,
        p.type,
        p.photographer_id AS photographerId,
        u.name AS photographerName,
        p.created_at AS createdAt,
        p.updated_at AS updatedAt
      FROM photos p
      LEFT JOIN users u ON p.photographer_id = u.id
      LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
      WHERE p.id = ?`;

    // apply organization scoping for single photo
    const params = [id];
    if (orgId === null) {
      sql += ' AND p.organization_id IS NULL';
    } else {
      sql += ' AND p.organization_id = ?';
      params.push(orgId);
    }
    sql += ' LIMIT 1';

    const [rows] = await pool.query(sql, params);
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'photo not found' });

    const p = rows[0];

    function resolveUrl(raw) {
      if (!raw) return null;
      const str = String(raw);
      if (/^https?:\/\//i.test(str)) return str;
      return buildUploadUrl(str);
    }

    let parsedTags = null;
    try { parsedTags = p.tags ? JSON.parse(p.tags) : null; } catch (e) { parsedTags = null; }

    res.json({
      id: p.id,
      uuid: p.uuid,
      projectId: p.projectId,
      timelineSectionId: p.timelineSectionId || null,
      timelineSectionName: p.timelineSectionName || null,
      timelineSectionTime: p.timelineSectionTime || null,
      url: resolveUrl(p.url),
      thumbUrl: resolveUrl(p.thumbUrl),
      playbackUrl: resolveUrl(p.playbackUrl),
      playback_url: resolveUrl(p.playbackUrl),
      title: p.title,
      description: p.description || null,
      adjustments: parsePhotoAdjustments(p.adjustments),
      tags: parsedTags,
      aiStatus: p.aiStatus || null,
      aiScore: p.aiScore !== undefined && p.aiScore !== null ? p.aiScore : null,
      aiQuality: (() => { try { return typeof p.aiQuality === 'string' ? JSON.parse(p.aiQuality) : (p.aiQuality || null); } catch (e) { return null; } })(),
      aiError: p.aiError || null,
      aiStartedAt: p.aiStartedAt || null,
      aiFinishedAt: p.aiFinishedAt || null,
      type: p.type,
      photographerId: p.photographerId || null,
      photographerName: p.photographerName || null,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt
    });
  } catch (err) {
    console.error('GET /api/photos/:id error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});


// 更新单张照片的 description 与 tags
// PATCH /api/photos/:id
router.patch('/:id', requirePermission('photos.edit'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: 'invalid id' });

    const { description, tags, adjustments } = req.body || {};

    const updates = [];
    const params = [];

    if (typeof description !== 'undefined') {
      updates.push('description = ?');
      params.push(description === null ? null : String(description));
    }

    if (typeof tags !== 'undefined') {
      let tagsVal = null;
      if (tags === null) {
        tagsVal = null;
      } else if (Array.isArray(tags)) {
        tagsVal = JSON.stringify(tags);
      } else if (typeof tags === 'string') {
        // try parse JSON string like '["a","b"]' or comma separated 'a,b'
        try {
          const parsed = JSON.parse(tags);
          if (Array.isArray(parsed)) tagsVal = JSON.stringify(parsed);
          else tagsVal = JSON.stringify([String(tags)]);
        } catch (e) {
          // fallback: comma separated
          const arr = String(tags).split(',').map(s => s.trim()).filter(Boolean);
          tagsVal = arr.length ? JSON.stringify(arr) : JSON.stringify([]);
        }
      }

      updates.push('tags = ?');
      params.push(tagsVal);
    }

    if (typeof adjustments !== 'undefined') {
      const normalizedAdjustments = normalizePhotoAdjustments(adjustments);
      if (adjustments !== null && !normalizedAdjustments) {
        return res.status(400).json({ error: 'invalid adjustments' });
      }
      updates.push('adjustments = ?');
      params.push(normalizedAdjustments ? JSON.stringify(normalizedAdjustments) : null);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });

    // enforce organization scoping: ensure photo belongs to user's organization
    const orgId = req.user && (req.user.organization_id !== undefined && req.user.organization_id !== null) ? parseInt(req.user.organization_id, 10) : null;
    let ownershipSql = 'SELECT id FROM photos WHERE id = ?';
    const ownershipParams = [id];
    if (orgId === null) {
      ownershipSql += ' AND organization_id IS NULL';
    } else {
      ownershipSql += ' AND organization_id = ?';
      ownershipParams.push(orgId);
    }
    const [ownRows] = await pool.query(ownershipSql, ownershipParams);
    if (!ownRows || ownRows.length === 0) return res.status(404).json({ error: 'photo not found' });

    params.push(id);
    const sql = `UPDATE photos SET ${updates.join(', ')} WHERE id = ?`;
    await pool.query(sql, params);

    const [rows] = await pool.query(
      `SELECT p.id, p.project_id AS projectId, p.timeline_section_id AS timelineSectionId,
              pts.name AS timelineSectionName, pts.section_time AS timelineSectionTime,
              p.url, p.thumb_url AS thumbUrl, p.playback_url AS playbackUrl, p.title, p.description, p.adjustments, p.tags,
              ai_status AS aiStatus, ai_error AS aiError,
              ai_started_at AS aiStartedAt, ai_finished_at AS aiFinishedAt
       FROM photos p
       LEFT JOIN project_timeline_sections pts ON p.timeline_section_id = pts.id
       WHERE p.id = ?`,
      [id]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'photo not found' });

    const p = rows[0];
    // ensure tags is parsed for response
    let parsedTags = null;
    try { parsedTags = p.tags ? JSON.parse(p.tags) : null; } catch (e) { parsedTags = null; }

    res.json({
      id: p.id,
      projectId: p.projectId || null,
      timelineSectionId: p.timelineSectionId || null,
      timelineSectionName: p.timelineSectionName || null,
      timelineSectionTime: p.timelineSectionTime || null,
      url: buildUploadUrl(p.url),
      thumbUrl: buildUploadUrl(p.thumbUrl),
      playbackUrl: p.playbackUrl ? buildUploadUrl(p.playbackUrl) : null,
      playback_url: p.playbackUrl ? buildUploadUrl(p.playbackUrl) : null,
      title: p.title,
      description: p.description,
      adjustments: parsePhotoAdjustments(p.adjustments),
      tags: parsedTags,
      aiStatus: p.aiStatus || null,
      aiError: p.aiError || null,
      aiStartedAt: p.aiStartedAt || null,
      aiFinishedAt: p.aiFinishedAt || null
    });
  } catch (err) {
    console.error('PATCH /api/photos/:id error:', err && err.stack ? err.stack : err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
