// 人物拆分核心：用户标出「系统认错人」的种子脸后，用 embedding 把该人物
// 名下所有脸重新二分——贴近种子脸的跟着搬去新人物，贴近其余脸的留下。
// 评分口径与聚簇管线一致（质心 0.7 + 近期最优 0.3），保证"拆"和"聚"对
// 像不像的判断同源，不会出现拆完又被下次聚簇判回去的口径漂移。
const DEFAULT_RECENT_VECS = 5;
const DEFAULT_ASSIGN_MARGIN = 0.03;

function envNum(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function parseJsonMaybe(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) return v;
  if (Buffer.isBuffer(v)) {
    try { return JSON.parse(v.toString('utf8')); } catch (e) { return null; }
  }
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch (e) { return null; }
  }
  return null;
}

function normalizeVector(vec) {
  if (!Array.isArray(vec) || vec.length === 0) return null;
  const arr = vec.map((x) => Number(x)).filter((x) => Number.isFinite(x));
  if (arr.length === 0) return null;
  let norm2 = 0;
  for (let i = 0; i < arr.length; i++) norm2 += arr[i] * arr[i];
  const norm = Math.sqrt(norm2);
  if (!Number.isFinite(norm) || norm <= 0) return null;
  return arr.map((x) => x / norm);
}

function cosine(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i++) dot += a[i] * b[i];
  return dot;
}

function faceVector(faceRow) {
  return normalizeVector(parseJsonMaybe(faceRow.normalized_embedding) || parseJsonMaybe(faceRow.embedding));
}

// 与 face_auto_pipeline.buildPersonProfiles 同构：质心 + 最近 N 条向量
function buildSeedProfile(vectors, recentKeep = DEFAULT_RECENT_VECS) {
  const list = (Array.isArray(vectors) ? vectors : []).filter((v) => Array.isArray(v) && v.length > 0);
  if (!list.length) return null;
  const dim = list[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of list) {
    if (v.length !== dim) continue;
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  const centroid = normalizeVector(sum);
  const recent = list.slice(0, recentKeep);
  if (!centroid) return null;
  return { centroidVec: centroid, recentVecs: recent };
}

// 与 face_auto_pipeline.scoreProfile 同一口径
function scoreVsProfile(vec, profile) {
  if (!Array.isArray(vec) || !profile) return -1;
  const centroidScore = profile.centroidVec ? cosine(vec, profile.centroidVec) : -1;
  let recentBest = -1;
  for (const rv of profile.recentVecs || []) {
    const s = cosine(vec, rv);
    if (Number.isFinite(s) && s > recentBest) recentBest = s;
  }
  if (centroidScore < -0.5 && recentBest < -0.5) return -1;
  if (recentBest < -0.5) return centroidScore;
  if (centroidScore < -0.5) return recentBest;
  return (0.7 * centroidScore) + (0.3 * recentBest);
}

/**
 * 把 personFaces 二分成「搬走 / 留下 / 判不了」。
 * @param {Array} personFaces photo_faces 行（含 normalized_embedding/embedding）
 * @param {Array<number|string>} seedFaceIds 用户标记的"不是这个人"的脸 id
 * @param {object} [options] { margin } 判走所需的相似度领先幅度，默认 0.03（FACE_SPLIT_ASSIGN_MARGIN）
 * @returns {{ seeds:Array, move:Array, keep:Array, undecided:Array, rowsById:Map,
 *             scoreOf:Map, seedProfile, keepProfile }}
 *   move = 种子脸 + 明显更贴种子的脸；keep = 明显更贴其余脸的脸；
 *   undecided = 无 embedding（判不了，默认留在原人物，前端允许手动勾走）。
 */
function splitFacesBySeeds(personFaces, seedFaceIds, options = {}) {
  const margin = Math.max(0, envNum('FACE_SPLIT_ASSIGN_MARGIN', options.margin != null ? options.margin : DEFAULT_ASSIGN_MARGIN));
  const seedSet = new Set((Array.isArray(seedFaceIds) ? seedFaceIds : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0));

  const rowsById = new Map();
  const seeds = [];
  const others = [];
  for (const row of Array.isArray(personFaces) ? personFaces : []) {
    const id = Number(row.id);
    if (!Number.isFinite(id) || id <= 0) continue;
    rowsById.set(id, row);
    row.__vec = faceVector(row); // 挂在行上，调用方别序列化这批行
    if (seedSet.has(id)) seeds.push(row);
    else others.push(row);
  }

  const seedProfile = buildSeedProfile(seeds.map((r) => r.__vec).filter(Boolean));
  const keepProfile = buildSeedProfile(others.map((r) => r.__vec).filter(Boolean));

  const move = [];
  const keep = [];
  const undecided = [];
  const scoreOf = new Map();

  for (const row of seeds) {
    move.push(row);
    scoreOf.set(Number(row.id), { scoreSeed: 1, scoreKeep: -1, isSeed: true, hasEmbedding: Boolean(row.__vec) });
  }

  for (const row of others) {
    const id = Number(row.id);
    if (!row.__vec) {
      undecided.push(row);
      scoreOf.set(id, { scoreSeed: -1, scoreKeep: -1, isSeed: false, hasEmbedding: false });
      continue;
    }
    if (!seedProfile) { // 种子全无向量：其余脸都判不了
      undecided.push(row);
      scoreOf.set(id, { scoreSeed: -1, scoreKeep: -1, isSeed: false, hasEmbedding: true });
      continue;
    }
    const scoreSeed = scoreVsProfile(row.__vec, seedProfile);
    const scoreKeep = keepProfile ? scoreVsProfile(row.__vec, keepProfile) : -1;
    scoreOf.set(id, { scoreSeed, scoreKeep, isSeed: false, hasEmbedding: true });
    if (scoreSeed - scoreKeep >= margin) move.push(row);
    else keep.push(row);
  }

  for (const row of rowsById.values()) delete row.__vec;
  return { seeds, move, keep, undecided, rowsById, scoreOf, seedProfile, keepProfile, margin };
}

module.exports = {
  DEFAULT_ASSIGN_MARGIN,
  splitFacesBySeeds,
  faceVector,
  parseJsonMaybe,
  normalizeVector,
  cosine,
};
