// 人物拆分核心：用户标出「系统认错人」的种子脸后，用 embedding 把该人物
// 名下所有脸重新二分——贴近种子脸的跟着搬去新人物，贴近其余脸的留下。
// 与自动归类共享质心/近期样本评分；拆分建议排除待判脸自身，分差不足时交给人工确认。
const { normalize: normalizeVector, cosine } = require('./face_feedback');
const { scoreIdentityProfile } = require('./face_matching');
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

function faceVector(faceRow) {
  return normalizeVector(faceRow.normalized_embedding) || normalizeVector(faceRow.embedding);
}

// Each caller groups model, version and dimension before building a profile.
function buildSeedProfile(vectors, recentKeep = DEFAULT_RECENT_VECS) {
  const list = vectors || [];
  if (!list.length) return null;
  const dim = list[0].length;
  const sum = new Array(dim).fill(0);
  for (const v of list) {
    for (let i = 0; i < dim; i++) sum[i] += v[i];
  }
  const centroid = normalizeVector(sum);
  const recent = list.slice(0, recentKeep);
  if (!centroid) return null;
  return { centroidVec: centroid, recentVecs: recent, sumVec: sum, count: list.length };
}

function groupEvidence(rows, vectors) {
  const groups = new Map();
  for (const row of rows) {
    const vec = vectors.get(Number(row.id));
    if (!vec || !row.model_name) continue;
    const key = JSON.stringify([row.model_name, row.model_version ?? null, vec.length]);
    if (!groups.has(key)) groups.set(key, { rows: [], vectors: [] });
    groups.get(key).rows.push(row);
    groups.get(key).vectors.push(vec);
  }
  for (const group of groups.values()) {
    group.profile = buildSeedProfile(group.vectors);
    group.recentRows = group.rows.slice(0, DEFAULT_RECENT_VECS + 1);
  }
  return groups;
}

/**
 * 把 personFaces 二分成「搬走 / 留下 / 判不了」。
 * @param {Array} personFaces photo_faces 行（含 normalized_embedding/embedding）
 * @param {Array<number|string>} seedFaceIds 用户标记的"不是这个人"的脸 id
 * @param {object} [options] { margin } 判走所需的相似度领先幅度，默认 0.03（FACE_SPLIT_ASSIGN_MARGIN）
 * @returns {{ seeds:Array, move:Array, keep:Array, undecided:Array, rowsById:Map,
 *             scoreOf:Map }}
 *   move = 种子脸 + 明显更贴种子的脸；keep = 明显更贴其余脸的脸；
 *   undecided = 无有效独立证据或分差太小（默认留在原人物，前端允许手动勾走）。
 */
function splitFacesBySeeds(personFaces, seedFaceIds, options = {}) {
  const margin = Math.max(0, envNum('FACE_SPLIT_ASSIGN_MARGIN', options.margin != null ? options.margin : DEFAULT_ASSIGN_MARGIN));
  const seedSet = new Set((Array.isArray(seedFaceIds) ? seedFaceIds : []).map((x) => Number(x)).filter((x) => Number.isFinite(x) && x > 0));

  const rowsById = new Map();
  const vectors = new Map();
  const seeds = [];
  const others = [];
  for (const row of Array.isArray(personFaces) ? personFaces : []) {
    const id = Number(row.id);
    if (!Number.isSafeInteger(id) || id <= 0 || rowsById.has(id)) continue;
    rowsById.set(id, row);
    vectors.set(id, faceVector(row));
    if (seedSet.has(id)) seeds.push(row);
    else others.push(row);
  }

  const seedGroups = groupEvidence(seeds, vectors);
  const keepGroups = groupEvidence(others, vectors);

  const move = [];
  const keep = [];
  const undecided = [];
  const scoreOf = new Map();

  for (const row of seeds) {
    move.push(row);
    scoreOf.set(Number(row.id), { scoreSeed: 1, scoreKeep: -1, isSeed: true, hasEmbedding: Boolean(vectors.get(Number(row.id))) });
  }

  for (const row of others) {
    const id = Number(row.id);
    const vec = vectors.get(id);
    const key = JSON.stringify([row.model_name, row.model_version ?? null, vec?.length]);
    const seedProfile = seedGroups.get(key)?.profile;
    const keepGroup = keepGroups.get(key);
    if (!vec || !seedProfile || !keepGroup?.profile || keepGroup.profile.count < 2) {
      undecided.push(row);
      scoreOf.set(id, { scoreSeed: -1, scoreKeep: -1, isSeed: false, hasEmbedding: Boolean(vec) });
      continue;
    }
    // Subtract the query once instead of rebuilding every profile: O(N * embedding dimension).
    const centroidVec = normalizeVector(keepGroup.profile.sumVec.map((value, index) => value - vec[index]));
    const recentVecs = keepGroup.recentRows.filter((candidate) => Number(candidate.id) !== id)
      .slice(0, DEFAULT_RECENT_VECS).map((candidate) => vectors.get(Number(candidate.id)));
    if (!centroidVec) {
      undecided.push(row);
      scoreOf.set(id, { scoreSeed: -1, scoreKeep: -1, isSeed: false, hasEmbedding: true });
      continue;
    }
    const scoreSeed = scoreIdentityProfile(vec, seedProfile).score;
    const scoreKeep = scoreIdentityProfile(vec, { centroidVec, recentVecs }).score;
    scoreOf.set(id, { scoreSeed, scoreKeep, isSeed: false, hasEmbedding: true });
    if (scoreSeed > scoreKeep && scoreSeed - scoreKeep >= margin) move.push(row);
    else if (scoreKeep > scoreSeed && scoreKeep - scoreSeed >= margin) keep.push(row);
    else undecided.push(row);
  }

  return { seeds, move, keep, undecided, rowsById, scoreOf, margin };
}

module.exports = {
  DEFAULT_ASSIGN_MARGIN,
  splitFacesBySeeds,
  faceVector,
  parseJsonMaybe,
  normalizeVector,
  cosine,
};
