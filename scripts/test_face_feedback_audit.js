const assert = require('assert/strict');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const sample = (org, person, photo, vector, version = null) => ({ organization_id: org, person_id: person,
  photo_id: photo, normalized_embedding: vector, sample_kind: 'explicit', model_name: 'buffalo_l', model_version: version });
const samples = [
  sample(2, 1, 10, [1, 0]), sample(2, 1, 11, [1, 0]),
  sample(2, 2, 12, [1, 0], 'new'), sample(2, 2, 13, [1, 0], 'new'),
  sample(3, 10, 31, [1, 0]), sample(3, 10, 32, [0.8, 0.6]),
  sample(3, 20, 33, [0.79, Math.sqrt(1 - 0.79 ** 2)]), sample(3, 20, 34, [0.79, Math.sqrt(1 - 0.79 ** 2)]),
];
let closed = false;
function stub(relative, exports) {
  const filename = require.resolve(path.join(ROOT, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}
stub('db', { pool: { query: async (sql) => {
  assert(sql.trim().startsWith('SELECT'), 'reference audit must stay read-only');
  if (sql.includes('FROM face_identity_feedback')) return [samples];
  if (sql.includes('FROM face_feedback_events')) return [[]];
  if (sql.includes('FROM face_person_separations')) return [[]];
  throw new Error('unexpected SQL');
}, end: async () => { closed = true; } } });
stub('lib/face_cluster_config', { getOrgFaceClusterConfig: async () => ({ matchThreshold: 0.36 }) });
const { main } = require('./audit_face_feedback');

async function test() {
  const log = console.log;
  let report;
  try {
    console.log = (value) => { report = JSON.parse(value); };
    await main();
  } finally { console.log = log; }
  assert(closed, 'database connection must close after evaluation');
  assert.equal(report.groups.length, 3, 'evaluation must not compare different weight versions');
  const versions = report.groups.filter((group) => JSON.parse(group.group)[0] === 2);
  assert.equal(versions.reduce((count, group) => count + group.correct, 0), 4);
  const ordinary = report.groups.find((group) => JSON.parse(group.group)[0] === 3);
  assert(ordinary.abstained > 0, 'reference evaluation must use the same near-tie guard as matching');
  console.log('face feedback audit: model-version isolation, ambiguity and read-only evaluation passed');
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
