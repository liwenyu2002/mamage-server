const { normalize, cosine, referenceScore, isSeparatedAmbiguity } = require('./face_feedback');
const { isUsableFaceResult } = require('./face_result_policy');

function sameEmbeddingSpace(candidate, space) {
  if (!candidate || !space) return false;
  const name = candidate.modelName ?? candidate.model_name;
  const version = candidate.modelVersion ?? candidate.model_version ?? null;
  const expectedName = space.modelName ?? space.model_name;
  const expectedVersion = space.modelVersion ?? space.model_version ?? null;
  return Boolean(name && expectedName && name === expectedName && version === expectedVersion);
}

function matchMargin(value = process.env.FACE_CLUSTER_MATCH_MARGIN) {
  const number = value == null || String(value).trim() === '' ? NaN : Number(value);
  return Math.max(0.01, Math.min(0.2, Number.isFinite(number) ? number : 0.06));
}

function buildIdentityProfiles(rows, { space, sampleLimit = 8, recentLimit = 5 } = {}) {
  const profiles = new Map();
  for (const row of rows || []) {
    if (space && !sameEmbeddingSpace(row, space)) continue;
    if (!isUsableFaceResult(row)) continue;
    const personId = Number(row.personId ?? row.person_id);
    if (!Number.isSafeInteger(personId) || personId <= 0) continue;
    const vec = normalize(row.normalizedEmbedding ?? row.normalized_embedding ?? row.ne)
      || normalize(row.embedding ?? row.e);
    if (!vec) continue;
    if (!profiles.has(personId)) {
      profiles.set(personId, { personId, count: 0, sumVec: new Array(vec.length).fill(0),
        centroidVec: null, recentVecs: [] });
    }
    const profile = profiles.get(personId);
    if (profile.sumVec.length !== vec.length || profile.count >= sampleLimit) continue;
    vec.forEach((value, index) => { profile.sumVec[index] += value; });
    profile.count++;
    if (profile.recentVecs.length < recentLimit) profile.recentVecs.push(vec);
  }
  for (const profile of profiles.values()) profile.centroidVec = normalize(profile.sumVec);
  return [...profiles.values()];
}

function scoreIdentityProfile(vector, profile) {
  if (!vector || !profile) return { score: -1, automaticScore: -1, referenceScore: null };
  const centroid = profile.centroidVec?.length === vector.length ? profile.centroidVec : null;
  const recent = (profile.recentVecs || []).filter((vec) => vec.length === vector.length);
  const centroidScore = centroid ? cosine(vector, centroid) : -1;
  const recentBest = recent.length ? Math.max(...recent.map((vec) => cosine(vector, vec))) : -1;
  const automaticScore = centroid && recent.length ? 0.7 * centroidScore + 0.3 * recentBest
    : centroid ? centroidScore : recentBest;
  const references = (profile.feedbackReferences || []).filter((row) => row.vec?.length === vector.length);
  const reviewedScore = references.length ? referenceScore(vector, references) : null;
  return { score: reviewedScore ?? automaticScore, automaticScore, referenceScore: reviewedScore };
}

function classifyIdentityMatch(ranked, { threshold, margin = matchMargin(), separations = new Set() }) {
  const best = ranked[0] || null;
  const feedbackConflict = isSeparatedAmbiguity(ranked, separations, threshold, margin);
  const ambiguous = Boolean(best && ranked[1] && best.score >= threshold
    && best.score - ranked[1].score < margin);
  const referenceConflict = ranked.some((candidate) => candidate.referenceScore != null
    && candidate.automaticScore >= threshold && candidate.referenceScore < threshold);
  return { best: best && best.score >= threshold && !feedbackConflict && !ambiguous ? best : null,
    ambiguous, feedbackConflict, referenceConflict };
}

module.exports = { sameEmbeddingSpace, matchMargin, buildIdentityProfiles, scoreIdentityProfile, classifyIdentityMatch };
