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

async function query(sql, params = []) {
  const statement = String(sql).replace(/\s+/g, ' ').trim();
  if (statement.includes('FROM photos WHERE id = ?')) {
    return [[{ id: params[0], projectId: 7, organizationId: 2, url: 'unused.jpg' }]];
  }
  if (statement.startsWith('DELETE FROM photo_faces')) return [{ affectedRows: 0 }];
  if (statement.includes('FROM photo_faces pf') && statement.includes('normalized_embedding')) {
    if (statement.includes('ROW_NUMBER() OVER')) {
      const perPerson = Number(params[2]) || 8;
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
        rollback: async () => {},
        release: () => {},
      }),
    },
  },
};

const detectorPath = require.resolve(path.join(ROOT, 'lib/face_detector'));
require.cache[detectorPath] = {
  id: detectorPath, filename: detectorPath, loaded: true,
  exports: {
    detectFacesForPhoto: async () => ({
      faces: [{
        faceNo: 1,
        bbox: { left: 0.1, top: 0.1, width: 0.2, height: 0.2 },
        normalizedEmbedding: [1, 0],
        modelName: 'buffalo_l',
      }],
      meta: { modelName: 'buffalo_l' },
    }),
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
  const result = await detectAndClusterPhoto({ photoId: 10 });
  assert.strictEqual(insertedPersonId, 1, 'an old person must remain a match candidate');
  assert.strictEqual(createdPersons, 0, 'a matching old person must not be duplicated');
  assert.strictEqual(result.matchedCount, 1);
  console.log('face cluster candidates: old person remains eligible after 5000 newer faces');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
