const assert = require('assert');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
let separationPairs = [];
let feedbackRows = [];
let queryVector = [1, 0];
let detectorFails = false;
const temporaryPaths = [];
process.env.FACE_DETECTOR_SERVICE_URL = 'http://127.0.0.1:8009';

const otherFace = [0.4, Math.sqrt(1 - (0.4 * 0.4))];
let rows = [
  { photoId: 1, personId: 10, ne: JSON.stringify([1, 0]), url: 'together.jpg', title: 'together' },
  { photoId: 1, personId: 20, ne: JSON.stringify(otherFace), url: 'together.jpg', title: 'together' },
  { photoId: 2, personId: 20, ne: JSON.stringify(otherFace), url: 'other.jpg', title: 'other' },
  { photoId: 3, personId: 10, ne: JSON.stringify([0.9, Math.sqrt(1 - (0.9 * 0.9))]), url: 'mine.jpg', title: 'mine' },
  { photoId: 4, personId: null, ne: JSON.stringify([0.8, 0.6]), url: 'unassigned.jpg', title: 'unassigned' },
];

const dbPath = require.resolve(path.join(ROOT, 'db'));
require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: {
      query: async (sql, params) => {
        if (sql.includes('FROM face_identity_feedback')) {
          assert(sql.includes('model_name = ?') && sql.includes('model_version <=> ?'));
          const photoIds = params.find(Array.isArray);
          assert(photoIds, 'memory must be scoped to authorized photos');
          assert(photoIds.every((id) => rows.some((row) => row.photoId === id)), 'memory cannot extend the authorized scope');
          return [feedbackRows];
        }
        if (sql.includes('FROM face_person_separations')) return [separationPairs];
        if (sql.includes('FROM photo_faces')) {
          assert(sql.includes('f.model_name = ?') && sql.includes('f.model_version <=> ?'));
          return [rows];
        }
        if (sql.includes('FROM face_persons')) return [[{ id: params[0], name: 'query person' }]];
        throw new Error(`unexpected SQL: ${sql}`);
      },
    },
  },
};

const mediaPath = require.resolve(path.join(ROOT, 'lib/media_access'));
require.cache[mediaPath] = {
  id: mediaPath, filename: mediaPath, loaded: true,
  exports: { buildMediaUrl: (value) => value },
};

const axiosPath = require.resolve('axios');
require.cache[axiosPath] = {
  id: axiosPath, filename: axiosPath, loaded: true,
  exports: { post: async (_url, payload) => {
    assert.equal(payload.backend, 'insightface', 'selfie identification cannot silently fall back to Haar');
    temporaryPaths.push(payload.imagePath);
    if (detectorFails) throw new Error('synthetic detector failure');
    return { data: { modelName: 'buffalo_l', modelVersion: null, faces: [{ normalizedEmbedding: queryVector }] } };
  } },
};

const { findMe } = require(path.join(ROOT, 'lib/find_me'));

async function main() {
  rows.forEach((row) => Object.assign(row, { modelName: 'buffalo_l', modelVersion: null }));
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#ffffff' } }).png().toBuffer();
  const result = await findMe(image, { projectId: 86, orgId: 2 });
  assert.strictEqual(result.person.personId, 10);
  assert.deepStrictEqual(result.matches.map((m) => m.photoId).sort((a, b) => a - b), [1, 3, 4],
    'known person must not pull in another co-occurring person by raw similarity');
  separationPairs = [{ person_low_id: 10, person_high_id: 20 }];
  rows[1].ne = rows[2].ne = JSON.stringify([0.99, Math.sqrt(1 - 0.99 ** 2)]);
  const ambiguous = await findMe(image, { projectId: 86, orgId: 2 });
  assert.strictEqual(ambiguous.ambiguous, true);
  assert.deepStrictEqual(ambiguous.matches, [], 'ambiguous separated people must not fall back to raw similarity');
  assert.strictEqual(ambiguous.person, null);
  rows[1].ne = rows[2].ne = JSON.stringify(otherFace);
  feedbackRows = [{ person_id: 999, normalized_embedding: [1, 0], sample_kind: 'explicit' }];
  const scoped = await findMe(image, { projectId: 86, orgId: 2 });
  assert.strictEqual(scoped.person.personId, 10, 'feedback cannot introduce out-of-scope people');

  const face = (photoId, personId, score, modelName = 'buffalo_l', modelVersion = null) => ({
    photoId, personId, ne: [score, Math.sqrt(1 - score ** 2)], url: 'fixture.jpg', modelName, modelVersion,
  });
  separationPairs = [];
  rows = [face(1, 10, 1), face(2, 20, 0.8)];
  feedbackRows = [{ person_id: 10, normalized_embedding: [0, 1], sample_kind: 'explicit' }];
  const conflict = await findMe(image, { projectId: 86, orgId: 2 });
  assert.notStrictEqual(conflict.person?.personId, 10, 'reviewed references must veto automatic profile pollution');

  feedbackRows = [];
  rows = [face(1, 10, 0.8), face(2, 20, 0.79)];
  const tie = await findMe(image, { projectId: 86, orgId: 2 });
  assert.strictEqual(tie.ambiguous, true, 'ordinary near ties must abstain without a prior manual split');
  assert.deepStrictEqual(tie.matches, []);

  rows = [face(1, 10, 0.9), face(2, 10, -0.8)];
  const polluted = await findMe(image, { projectId: 86, orgId: 2 });
  assert(!polluted.matches.some((match) => match.photoId === 2), 'unreviewed cluster members need their own similarity evidence');

  for (const incompatible of [face(1, 10, 1, 'other-model'), face(1, 10, 1, 'buffalo_l', 'other-version')]) {
    rows = [incompatible];
    const isolated = await findMe(image, { projectId: 86, orgId: 2 });
    assert.strictEqual(isolated.person, null, 'models and weight versions must be isolated even at the same dimension');
    assert.deepStrictEqual(isolated.matches, []);
  }
  rows = [face(1, 10, 1)];
  rows[0].ne = [1, 0, 0];
  const mismatch = await findMe(image, { projectId: 86, orgId: 2 });
  assert.strictEqual(mismatch.person, null);
  assert.deepStrictEqual(mismatch.matches, []);
  rows = Array.from({ length: 201 }, (_, index) => face(index + 1, 10, 1));
  const limited = await findMe(image, { photoIds: rows.map((row) => row.photoId), orgId: 2 });
  assert.equal(limited.matches.length, 200);
  assert.equal(limited.totalMatches, 201);
  assert.equal(limited.truncated, true);
  queryVector = [1, NaN, 0];
  await assert.rejects(findMe(image, { projectId: 86, orgId: 2 }), (error) => error.code === 'NO_EMBEDDING');
  detectorFails = true;
  await assert.rejects(findMe(image, { projectId: 86, orgId: 2 }), (error) => error.code === 'FACE_SERVICE_UNAVAILABLE');
  for (const temporaryPath of temporaryPaths) {
    await assert.rejects(require('fs/promises').access(temporaryPath), (error) => error.code === 'ENOENT');
  }
  console.log('find me precision: scope, reference veto, ambiguity, per-face checks and model isolation passed');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
