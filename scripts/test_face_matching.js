const assert = require('assert/strict');
const { normalize, cosine } = require('../lib/face_feedback');
const { sameEmbeddingSpace, matchMargin, buildIdentityProfiles, scoreIdentityProfile,
  classifyIdentityMatch } = require('../lib/face_matching');

const space = { modelName: 'buffalo_l', modelVersion: null };
assert(sameEmbeddingSpace({ model_name: 'buffalo_l' }, space));
assert(!sameEmbeddingSpace({ model_name: 'buffalo_l', model_version: 'new' }, space));
assert(!sameEmbeddingSpace({}, space));
for (const invalid of [[1, NaN, 0], [Infinity], [0, 0], ['1', 0], [1e308, 1e308, 1e308, 1e308]]) {
  assert.equal(normalize(invalid), null, 'invalid coordinates must not silently change embedding dimensions');
}
assert.equal(cosine([1, 0], [1, 0, 0]), -1);
assert.equal(matchMargin('bad'), 0.06);

const profiles = buildIdentityProfiles([
  { personId: 1, normalizedEmbedding: '[1,0]', ...space },
  { personId: 1, normalizedEmbedding: [0, 1], ...space },
  { personId: 1, normalizedEmbedding: [1, 0, 0], ...space },
  { personId: 2, normalizedEmbedding: [1, 0], ...space, modelVersion: 'new' },
  { personId: 3, normalizedEmbedding: [1, 0], ...space, status: 'rejected' },
], { space, sampleLimit: 2 });
assert.equal(profiles.length, 1);
assert.equal(profiles[0].count, 2);
assert.equal(scoreIdentityProfile([1, 0, 0], profiles[0]).score, -1);
const negative = scoreIdentityProfile([1, 0], { centroidVec: [-0.8, 0.6], recentVecs: [[-1, 0]] });
assert(Math.abs(negative.score + 0.86) < 1e-10, 'valid negative scores are not missing evidence');
const reviewed = scoreIdentityProfile([1, 0], { centroidVec: [1, 0], recentVecs: [[1, 0]],
  feedbackReferences: [{ sample_kind: 'explicit', vec: [0, 1] }] });
assert.equal(reviewed.score, 0);
assert.equal(classifyIdentityMatch([{ personId: 1, ...reviewed }], { threshold: 0.36 }).best, null);
assert(classifyIdentityMatch([{ score: 0.8 }, { score: 0.79 }], { threshold: 0.36 }).ambiguous);
assert.equal(classifyIdentityMatch([{ personId: 1, score: 0.8 }, { personId: 2, score: 0.3 }],
  { threshold: 0.36 }).best.personId, 1);
console.log('face matching: strict vectors, sample limits, reference priority and ambiguity passed');
