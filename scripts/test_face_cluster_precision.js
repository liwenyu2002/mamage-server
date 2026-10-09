const assert = require('assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '..');
process.env.FACE_BURST_PRIOR = '1';
let profileRows = [];
let feedbackRows = [];
let siblings = [];
let inserted = null;
let createdPersons = 0;
let insertedFaces = [];
let vectors = [[1, 0]];
let faceModels = [];
let faceVersions = [];

async function query(sql, params = []) {
  const statement = String(sql).replace(/\s+/g, ' ').trim();
  if (statement.startsWith('SELECT id FROM face_identity_feedback')) return [[]];
  if (statement.includes('FROM face_identity_feedback')) {
    assert(statement.includes('model_name = ?') && statement.includes('model_version <=> ?'));
    return [feedbackRows];
  }
  if (statement.includes('FROM face_person_separations')) return [[]];
  if (statement.includes('FROM photos WHERE id = ?')) {
    return [[{ id: params[0], projectId: 90, organizationId: 2, url: 'unused.jpg' }]];
  }
  if (statement.startsWith('DELETE FROM photo_faces')) return [{ affectedRows: 0 }];
  if (statement.includes('FROM photo_faces pf') && statement.includes('ROW_NUMBER() OVER')) {
    assert(statement.includes('model_name = ?') && statement.includes('model_version <=> ?'));
    assert(statement.includes("status NOT IN ('rejected', 'deleted')"));
    return [profileRows];
  }
  if (statement.includes('FROM ai_image_embeddings')) {
    return [siblings.length ? [{ photoId: 10, embedding: [1, 0] }, { photoId: 11, embedding: [1, 0] }] : []];
  }
  if (statement.includes('FROM photo_faces WHERE photo_id IN')) return [siblings];
  if (statement.includes('MAX(person_no)')) return [[{ maxNo: 526 }]];
  if (statement.startsWith('INSERT INTO face_persons')) {
    createdPersons++;
    return [{ insertId: 900 }];
  }
  if (statement.startsWith('INSERT INTO photo_faces')) {
    inserted = params;
    insertedFaces.push(params);
    return [{ insertId: 13280 + insertedFaces.length }];
  }
  if (statement.startsWith('UPDATE face_persons')) return [{ affectedRows: 1 }];
  throw new Error(`unexpected SQL: ${statement}`);
}

function stub(relativePath, exports) {
  const filename = require.resolve(path.join(ROOT, relativePath));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

stub('db', { pool: {
  query,
  getConnection: async () => ({ query, beginTransaction: async () => {}, commit: async () => {},
    rollback: async () => {}, release: () => {} }),
} });
stub('lib/face_detector', { detectFacesForPhoto: async () => ({
  faces: vectors.map((vector, index) => ({ faceNo: index + 1,
    bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
    normalizedEmbedding: vector, modelName: faceModels[index] || 'buffalo_l', modelVersion: faceVersions[index] ?? null })),
  meta: { modelName: 'buffalo_l' },
}) });
stub('lib/face_cluster_config', {
  getOrgFaceClusterConfig: async () => ({ matchThreshold: 0.36, source: 'test' }),
  clampThreshold: (value) => value == null ? null : Number(value),
  DEFAULT_MATCH_THRESHOLD: 0.36,
});

const { detectAndClusterPhoto } = require('../lib/face_auto_pipeline');
const row = (personId, vector, modelName = 'buffalo_l', modelVersion = null) => ({
  personId, normalizedEmbedding: vector, modelName, modelVersion,
});
const reference = (personId, vector, kind = 'explicit') => ({
  person_id: personId, sample_kind: kind, normalized_embedding: vector,
});
const decision = () => JSON.parse(inserted[20]).clusterDecision;

async function run() {
  inserted = null;
  insertedFaces = [];
  createdPersons = 0;
  await detectAndClusterPhoto({ photoId: 10 });
  assert.ok(inserted, 'the real pipeline must insert a detection');
}

async function main() {
  profileRows = [row(526, [1, 0])];
  feedbackRows = [reference(526, [0, 1])];
  await run();
  assert.equal(inserted[3], null, 'automatic profile drift must not override a human reference');
  assert.equal(inserted[18], 'suspect');
  assert.equal(decision(), 'manual_reference_conflict');
  assert.equal(createdPersons, 0, 'contradictory evidence requires review, not a duplicate identity');

  feedbackRows = [reference(526, [0, 1], 'legacy')];
  await run();
  assert.equal(inserted[3], null, 'recovered historical corrections must also stop profile drift');

  profileRows = [row(526, [0, 1])];
  feedbackRows = [reference(526, [1, 0])];
  await run();
  assert.equal(inserted[3], 526, 'a matching human reference remains authoritative');

  feedbackRows = [];
  profileRows = [row(526, [1, 0]), row(529, [0.999, Math.sqrt(1 - 0.999 ** 2)])];
  await run();
  assert.equal(inserted[3], null, 'near-tied identities must not be automatically confirmed');
  assert.equal(inserted[18], 'suspect');
  assert.equal(decision(), 'ambiguous_match');

  profileRows = [row(526, [1, 0]), row(529, [0, 1])];
  await run();
  assert.equal(inserted[3], 526, 'an unambiguous automatic match still works');

  profileRows = [row(526, [0, 1])];
  feedbackRows = [reference(526, [0, 1])];
  siblings = [{ photoId: 11, personId: 526, ne: [1, 0],
    modelName: 'buffalo_l', modelVersion: null,
    bbox_x: 0.1, bbox_y: 0.1, bbox_w: 0.2, bbox_h: 0.2 }];
  await run();
  assert.equal(inserted[3], null, 'burst position must not bypass contradictory human evidence');
  assert.equal(inserted[18], 'suspect');
  assert.equal(createdPersons, 0);
  feedbackRows = [];
  siblings = [];
  vectors = [[1, 0], [0.99, Math.sqrt(1 - 0.99 ** 2)]];
  profileRows = [row(526, [1, 0]), row(529, [0.8, 0.6])];
  await run();
  assert.equal(insertedFaces[0][3], 526);
  assert.equal(insertedFaces[1][3], null, 'an occupied best match must not force the runner-up identity');
  assert.equal(insertedFaces[1][18], 'suspect');
  vectors = [[1, 0]];
  for (const incompatible of [row(526, [1, 0], 'other-model'), row(526, [1, 0], 'buffalo_l', 'new')]) {
    profileRows = [incompatible];
    await run();
    assert.notEqual(inserted[3], 526, 'automatic clustering must isolate model names and versions');
  }
  vectors = [[1, 0], [0, 1]];
  faceModels = ['buffalo_l', 'other-model'];
  faceVersions = [null, 'new'];
  profileRows = [row(526, [1, 0]), row(529, [0, 1], 'other-model', 'new')];
  await run();
  assert.deepEqual(insertedFaces.map((face) => face[3]), [526, 529], 'each model space needs its own profile context');
  faceModels = [];
  faceVersions = [];
  profileRows = [];
  for (const invalid of [null, [0, 0], [1, NaN, 0]]) {
    vectors = [invalid];
    await run();
    assert.equal(inserted[3], null, 'invalid embeddings must not create an automatic identity');
    assert.equal(createdPersons, 0);
    assert.equal(decision(), 'no_embedding');
    assert.equal(inserted[13], null, 'missing quality must stay unknown, not become a zero measurement');
  }
  console.log('face cluster precision: reference drift, legacy memory, ambiguity and burst safeguards passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
