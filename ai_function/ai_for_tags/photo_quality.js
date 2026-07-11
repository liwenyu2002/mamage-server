// photo_quality.js
// AI 选片 2.0 的确定性技术指标 + 综合评分。
// 锐度/曝光由代码在大图上实测（7B 视觉模型在缩略图上判断"清晰度"极不可靠），
// 视觉模型只负责构图/主体/瞬间/美感四个主观维度与缺陷 flags；
// 综合分与三档映射全部在这里用固定权重计算，模型不做算术。

const sharp = require('sharp');

const ANALYSIS_MAX_EDGE = 1280; // 分析用图最长边（技术指标与模型输入共用同一份）

const FATAL_FLAGS = new Set(['严重模糊', '闭眼', '主体遮挡']);
const KNOWN_FLAGS = new Set([
  '闭眼', '表情不佳', '背影', '主体遮挡', '画面歪斜', '杂乱背景', '无明显主体', '严重模糊',
]);

// 权重：技术 40%（锐度 25 + 曝光 15），主观 60%
const WEIGHTS = {
  sharpness: 0.25,
  exposure: 0.15,
  composition: 0.2,
  subject: 0.2,
  moment: 0.12,
  aesthetics: 0.08,
};

// 把原图 buffer 统一为分析尺寸的 JPEG（模型输入）与灰度 raw（技术指标）
async function prepareAnalysisImage(buffer) {
  const base = sharp(buffer, { failOn: 'none' }).rotate();
  const resized = base.resize(ANALYSIS_MAX_EDGE, ANALYSIS_MAX_EDGE, { fit: 'inside', withoutEnlargement: true });
  const jpeg = await resized.clone().jpeg({ quality: 88 }).toBuffer();
  const { data, info } = await resized.clone().greyscale().raw().toBuffer({ resolveWithObject: true });
  return { jpeg, grey: data, width: info.width, height: info.height };
}

// 拉普拉斯方差（4x4 分块取前二块均值）：主体清晰+背景虚化的人像
// 全局方差会被大片焦外拉低，取最清晰块才能反映"对没对上焦"。
function laplacianVariance(grey, width, height) {
  const TILES = 4;
  const tileW = Math.floor(width / TILES);
  const tileH = Math.floor(height / TILES);
  if (tileW < 3 || tileH < 3) return 0;
  const tileVars = [];
  for (let ty = 0; ty < TILES; ty += 1) {
    for (let tx = 0; tx < TILES; tx += 1) {
      let sum = 0;
      let sumSq = 0;
      let count = 0;
      const y0 = Math.max(1, ty * tileH);
      const y1 = Math.min(height - 1, (ty + 1) * tileH);
      const x0 = Math.max(1, tx * tileW);
      const x1 = Math.min(width - 1, (tx + 1) * tileW);
      for (let y = y0; y < y1; y += 1) {
        const row = y * width;
        for (let x = x0; x < x1; x += 1) {
          const i = row + x;
          const v = 4 * grey[i] - grey[i - 1] - grey[i + 1] - grey[i - width] - grey[i + width];
          sum += v;
          sumSq += v * v;
          count += 1;
        }
      }
      if (count) {
        const mean = sum / count;
        tileVars.push(sumSq / count - mean * mean);
      }
    }
  }
  if (!tileVars.length) return 0;
  tileVars.sort((a, b) => b - a);
  return (tileVars[0] + (tileVars[1] || tileVars[0])) / 2;
}

function sharpnessScore(variance) {
  // 实测参照：手机/相机正常对焦照片 variance 常在 100-2000+，明显糊片 < 30
  if (variance <= 0) return 1;
  const score = 2.4 * Math.log10(variance) + 1.2;
  return Math.max(1, Math.min(10, score));
}

function exposureStats(grey) {
  let under = 0;
  let over = 0;
  let sum = 0;
  const n = grey.length;
  for (let i = 0; i < n; i += 1) {
    const v = grey[i];
    sum += v;
    if (v <= 8) under += 1;
    else if (v >= 247) over += 1;
  }
  return { mean: sum / n, underRatio: under / n, overRatio: over / n };
}

function exposureScore({ mean, underRatio, overRatio }) {
  let score = 10;
  // 大面积死黑/死白直接重罚（保留少量高光/暗部裁剪的容忍）
  const clip = Math.max(0, underRatio - 0.02) + Math.max(0, overRatio - 0.01);
  score -= Math.min(6, clip * 40);
  // 整体亮度偏离中间调的柔性惩罚
  const deviation = Math.abs(mean - 118) / 118;
  score -= Math.min(3, Math.max(0, deviation - 0.25) * 8);
  return Math.max(1, Math.min(10, score));
}

// 对原图 buffer 计算全部技术指标 + 生成模型输入图
async function computeTechAndImage(buffer) {
  const { jpeg, grey, width, height } = await prepareAnalysisImage(buffer);
  const variance = laplacianVariance(grey, width, height);
  const expo = exposureStats(grey);
  const tech = {
    sharpness: Math.round(sharpnessScore(variance) * 10) / 10,
    exposure: Math.round(exposureScore(expo) * 10) / 10,
    laplacianVar: Math.round(variance),
    meanLuma: Math.round(expo.mean),
    underRatio: Math.round(expo.underRatio * 1000) / 1000,
    overRatio: Math.round(expo.overRatio * 1000) / 1000,
  };
  return { tech, modelJpeg: jpeg };
}

function clampDim(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(1, Math.min(10, n));
}

function normalizeFlags(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    const flag = String(item || '').trim();
    if (KNOWN_FLAGS.has(flag) && !out.includes(flag)) out.push(flag);
    if (out.length >= 4) break;
  }
  return out;
}

// 汇总：技术指标 + 模型主观维度 → 0-100 综合分 + 三档标签
function composeQuality(tech, modelQuality) {
  const dims = {
    sharpness: tech.sharpness,
    exposure: tech.exposure,
    composition: clampDim(modelQuality && modelQuality.composition) || 5,
    subject: clampDim(modelQuality && modelQuality.subject) || 5,
    moment: clampDim(modelQuality && modelQuality.moment) || 5,
    aesthetics: clampDim(modelQuality && modelQuality.aesthetics) || 5,
  };
  const flags = normalizeFlags(modelQuality && modelQuality.flags);
  // 技术锐度过低时补记严重模糊 flag（模型看的是缩过的图，不再让它判模糊）
  if (tech.sharpness < 3 && !flags.includes('严重模糊')) flags.unshift('严重模糊');

  let score = 0;
  for (const [key, weight] of Object.entries(WEIGHTS)) {
    score += (dims[key] || 5) * weight;
  }
  let score100 = Math.round(score * 10);

  const fatal = flags.filter((f) => FATAL_FLAGS.has(f));
  if (fatal.length) score100 = Math.min(score100, 45);
  score100 = Math.max(0, Math.min(100, score100));

  let label = 'AI medium';
  if (fatal.length || score100 <= 40) label = 'AI rejected';
  else if (score100 >= 75) label = 'AI recommended';

  let reason = String((modelQuality && modelQuality.reason) || '').replace(/\s+/g, ' ').trim().slice(0, 60) || null;
  if (!reason && flags.length) reason = `存在问题：${flags.join('、')}`;
  if (!reason && score100 >= 75) reason = '画质与构图俱佳，适合优先选用';

  return {
    score: score100,
    label,
    quality: { dims, flags, reason, tech: { laplacianVar: tech.laplacianVar, meanLuma: tech.meanLuma, underRatio: tech.underRatio, overRatio: tech.overRatio } },
  };
}

module.exports = { computeTechAndImage, composeQuality, ANALYSIS_MAX_EDGE };
