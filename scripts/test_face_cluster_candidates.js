const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const faceRows = [
  ...Array.from({ length: 5000 }, (_, index) => ({
    personId: 2,
    normalizedEmbedding: JSON.stringify([0, 1]),
    embedding: null,
    rank: index + 1,
  })),
  {
    personId: 1,
    normalizedEmbedding: JSON.stringify([1, 0]),
    embedding: null,
    rank: 5001,
  },
];
let insertedPersonId = null;
let createdPersons = 0;
let feedbackRows = [];
let pairs = [];
let protectedPhoto = false;
let protectDuringDetection = false;
let deletes = 0;
let rollbacks = 0;
let detectionCalls = 0;
let insertedFace = null;

async function query(sql, params = []) {
  const statement = String(sql).replace(/\s+/g, ' ').trim();
  if (statement.startsWith('SELECT id FROM face_identity_feedback')) return [protectedPhoto ? [{ id: 1 }] : []];
  if (statement.includes('FROM face_identity_feedback')) return [feedbackRows];
  if (statement.includes('FROM face_person_separations')) return [pairs];
  if (statement.includes('FROM photos WHERE id = ?')) {
    return [[{ id: params[0], projectId: 7, organizationId: 2, url: 'unused.jpg' }]];
  }
  if (statement.startsWith('DELETE FROM photo_faces')) { deletes++; return [{ affectedRows: 0 }]; }
  if (statement.includes('FROM photo_faces pf') && statement.includes('normalized_embedding')) {
    if (statement.includes('ROW_NUMBER() OVER')) {
      const perPerson = Number(params.at(-1)) || 8;
      const seen = new Map();
      return [faceRows.filter((row) => {
        const count = (seen.get(row.personId) || 0) + 1;
        seen.set(row.personId, count);
        return count <= perPerson;
      })];
    }
    return [faceRows.slice(0, Number(params[2]) || 5000)];
  }
  if (statement.includes('FROM ai_image_embeddings')) return [[]];
  if (statement.includes('MAX(person_no)')) return [[{ maxNo: 2 }]];
  if (statement.startsWith('INSERT INTO face_persons')) {
    createdPersons += 1;
    return [{ insertId: 3 }];
  }
  if (statement.startsWith('INSERT INTO photo_faces')) {
    insertedPersonId = params[3];
    insertedFace = params;
    return [{ insertId: 99 }];
  }
  if (statement.startsWith('UPDATE face_persons')) return [{ affectedRows: 1 }];
  throw new Error(`unexpected SQL: ${statement}`);
}

const dbPath = require.resolve(path.join(ROOT, 'db'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: {
      query,
      getConnection: async () => ({
        query,
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => { rollbacks++; },
        release: () => {},
      }),
    },
  },
};

const detectorPath = require.resolve(path.join(ROOT, 'lib/face_detector'));
require.cache[detectorPath] = {
  id: detectorPath, filename: detectorPath, loaded: true,
  exports: {
    detectFacesForPhoto: async () => {
      detectionCalls++;
      if (protectDuringDetection) protectedPhoto = true;
      return ({
      faces: [{
        faceNo: 1,
        bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
        normalizedEmbedding: [1, 0],
        modelName: 'buffalo_l',
      }],
      meta: { modelName: 'buffalo_l' },
      });
    },
  },
};

const configPath = require.resolve(path.join(ROOT, 'lib/face_cluster_config'));
require.cache[configPath] = {
  id: configPath, filename: configPath, loaded: true,
  exports: {
    getOrgFaceClusterConfig: async () => ({ matchThreshold: 0.36, source: 'test' }),
    clampThreshold: (value) => value == null ? null : Number(value),
    DEFAULT_MATCH_THRESHOLD: 0.36,
  },
};

const { detectAndClusterPhoto } = require(path.join(ROOT, 'lib/face_auto_pipeline'));

async function main() {
  for (const row of faceRows) Object.assign(row, { modelName: 'buffalo_l', modelVersion: null });
  const result = await detectAndClusterPhoto({ photoId: 10 });
  assert.strictEqual(insertedPersonId, 1, 'an old person must remain a match candidate');
  assert.strictEqual(createdPersons, 0, 'a matching old person must not be duplicated');
  assert.strictEqual(result.matchedCount, 1);
  faceRows.splice(0, faceRows.length, { personId: 2, normalizedEmbedding: [0, 1], modelName: 'buffalo_l', modelVersion: null });
  feedbackRows = [{ person_id: 1, sample_kind: 'explicit', normalized_embedding: [1, 0] }];
  await detectAndClusterPhoto({ photoId: 11 });
  assert.strictEqual(insertedPersonId, 1, 'durable correction must match even without recent automatic samples');
  faceRows[0].normalizedEmbedding = [0.99, Math.sqrt(1 - 0.99 ** 2)];
  pairs = [{ person_low_id: 1, person_high_id: 2 }];
  await detectAndClusterPhoto({ photoId: 12 });
  assert.strictEqual(insertedPersonId, null, 'separated near-tie cannot auto-assign');
  assert.strictEqual(insertedFace[18], 'suspect');
  assert.strictEqual(JSON.parse(insertedFace[20]).clusterDecision, 'manual_separation_conflict');
  assert.strictEqual(createdPersons, 0, 'ambiguity must not create another duplicate person');
  protectedPhoto = true;
  const previousDeletes = deletes;
  const previousDetections = detectionCalls;
  const protectedResult = await detectAndClusterPhoto({ photoId: 13, force: true });
  assert.strictEqual(protectedResult.reason, 'manual_faces_protected');
  assert.strictEqual(deletes, previousDeletes);
  assert.strictEqual(detectionCalls, previousDetections, 'force refresh must not even detect corrected photos');
  protectedPhoto = false;
  protectDuringDetection = true;
  const raced = await detectAndClusterPhoto({ photoId: 14, force: true });
  assert.strictEqual(raced.reason, 'manual_faces_protected');
  assert.strictEqual(rollbacks, 1, 'a correction committed during detection must roll back destructive refresh');
  console.log('face cluster candidates: old person remains eligible after 5000 newer faces');
  console.log('face feedback integration: persistent reference, split ambiguity, forced refresh and concurrent correction passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
