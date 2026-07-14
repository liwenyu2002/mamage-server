// 人物主图（头像）：服务端按人脸 bbox 裁好再发，避免前端下载几 MB 原图 + CSS 缩放定位（卡）。
// 结果内联进 profile（data URI），零额外请求、免签名 URL；内存 LRU 缓存避免重复裁剪。
const sharp = require('sharp');
const fetch = require('node-fetch');
const { buildInternalMediaUrl } = require('../db');

const SIZE = Math.max(64, Number(process.env.FACE_AVATAR_SIZE || 256));
const MARGIN = 0.45; // 人脸框外扩比例（留出头发/下巴，观感更像头像）
const CACHE_MAX = Math.max(20, Number(process.env.FACE_AVATAR_CACHE_MAX || 300));
const FETCH_TIMEOUT = 20000;

const cache = new Map(); // key -> dataUrl（Map 保序，超量淘汰最早插入的）

function cacheGet(key) {
  if (!cache.has(key)) return undefined;
  const v = cache.get(key);
  cache.delete(key); // LRU：命中即刷新到队尾
  cache.set(key, v);
  return v;
}
function cacheSet(key, val) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, val);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

// bbox 归一化为 0~1 比例（库里既可能是 ratio，也可能是像素值）
function toRatioBox(face) {
  let x = Number(face.bbox_x), y = Number(face.bbox_y);
  let w = Number(face.bbox_w), h = Number(face.bbox_h);
  if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) return null;
  const unit = String(face.bbox_unit || '').toLowerCase();
  const looksPixel = unit === 'pixel' || unit === 'px' || w > 1.5 || h > 1.5;
  if (looksPixel) {
    const iw = Number(face.image_width), ih = Number(face.image_height);
    if (!Number.isFinite(iw) || !Number.isFinite(ih) || iw <= 0 || ih <= 0) return null;
    x /= iw; y /= ih; w /= iw; h /= ih;
  }
  return { x, y, w, h };
}

async function fetchPhotoBuffer(rel) {
  const url = buildInternalMediaUrl(rel);
  if (!url) throw new Error('no media url');
  const resp = await fetch(url, { timeout: FETCH_TIMEOUT });
  if (!resp.ok) throw new Error(`fetch photo ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

/**
 * 生成人脸头像 data URI。失败返回 null（前端回退旧路径，不影响功能）。
 * @param {object} faceRow photo_faces 行（需 id、bbox 四值、image 宽高，以及 photo_url 或 photo_thumb_url）
 * @param {number} size 输出边长
 */
async function getFaceAvatarDataUrl(faceRow, size = SIZE) {
  if (!faceRow || !faceRow.id) return null;
  const key = `${faceRow.id}:${size}`;
  const hit = cacheGet(key);
  if (hit !== undefined) return hit;

  try {
    const box = toRatioBox(faceRow);
    const rel = faceRow.photo_url || faceRow.photo_thumb_url;
    if (!box || !rel) { cacheSet(key, null); return null; }

    const src = await fetchPhotoBuffer(rel);
    const meta = await sharp(src).metadata();
    const IW = meta.width, IH = meta.height;
    if (!IW || !IH) { cacheSet(key, null); return null; }

    const bw = box.w * IW, bh = box.h * IH;
    const ex = bw * MARGIN, ey = bh * MARGIN;
    const left = Math.max(0, Math.round(box.x * IW - ex));
    const top = Math.max(0, Math.round(box.y * IH - ey));
    const width = Math.max(8, Math.min(IW - left, Math.round(bw + ex * 2)));
    const height = Math.max(8, Math.min(IH - top, Math.round(bh + ey * 2)));

    const out = await sharp(src)
      .extract({ left, top, width, height })
      .resize(size, size, { fit: 'cover' })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
    const dataUrl = `data:image/jpeg;base64,${out.toString('base64')}`;
    cacheSet(key, dataUrl);
    return dataUrl;
  } catch (e) {
    console.warn('face avatar failed for face', faceRow.id, e && e.message);
    cacheSet(key, null); // 失败也缓存，避免每次打开都重试拖慢接口
    return null;
  }
}

module.exports = { getFaceAvatarDataUrl, SIZE };
