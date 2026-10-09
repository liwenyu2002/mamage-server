const assert = require('assert/strict');
const { splitFacesBySeeds } = require('../lib/face_person_split');
const { normalize, cosine } = require('../lib/face_feedback');

function face(id, vector, model = 'buffalo_l', version = null) {
  return { id, normalized_embedding: vector, model_name: model, model_version: version };
}

const seed = face(1, [1, 0]);
const query = face(2, [0.8, 0.6]);
const other = face(3, [0, 1]);
const split = splitFacesBySeeds([seed, query, other], [1]);
assert(split.move.some((row) => row.id === 2), 'a face cannot use itself as evidence to stay in the old identity');
assert(Math.abs(split.scoreOf.get(2).scoreKeep - 0.6) < 1e-10);
assert.deepEqual(split.keep.map((row) => row.id), [3]);

const noIndependentEvidence = splitFacesBySeeds([seed, face(2, [0.8, 0.6])], [1]);
assert.deepEqual(noIndependentEvidence.undecided.map((row) => row.id), [2], 'one-sided evidence alone cannot justify an automatic split');

const ambiguous = splitFacesBySeeds([seed, face(2, [Math.SQRT1_2, Math.SQRT1_2]), other], [1]);
assert.deepEqual(ambiguous.undecided.map((row) => row.id), [2], 'close scores require explicit review');

for (const incompatible of [face(2, [1, 0, 0]), face(2, [1, 0], 'other-model'), face(2, [1, 0], 'buffalo_l', 'new')]) {
  const isolated = splitFacesBySeeds([seed, incompatible, other], [1]);
  assert(isolated.undecided.some((row) => row.id === 2), 'incompatible embeddings cannot move automatically');
}
let state = 42;
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
const synthetic = Array.from({ length: 32 }, (_, index) => face(index + 1,
  normalize(Array.from({ length: 512 }, () => random() * 2 - 1))));
const checked = splitFacesBySeeds(synthetic, [1]);
for (const row of synthetic.slice(1)) {
  const independent = synthetic.slice(1).filter((candidate) => candidate.id !== row.id).map((candidate) => candidate.normalized_embedding);
  const sum = new Array(512).fill(0);
  for (const vector of independent) vector.forEach((value, index) => { sum[index] += value; });
  const expected = 0.7 * cosine(row.normalized_embedding, normalize(sum))
    + 0.3 * Math.max(...independent.slice(0, 5).map((vector) => cosine(row.normalized_embedding, vector)));
  assert(Math.abs(checked.scoreOf.get(row.id).scoreKeep - expected) < 1e-10,
    'linear-time exclusion must match a full independent profile rebuild');
  assert(!Object.hasOwn(row, '__vec'), 'splitting must not mutate database rows');
}
console.log('face split precision: independent evidence, ambiguity and embedding-space isolation passed');
