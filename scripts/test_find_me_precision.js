const assert = require('assert');
const path = require('path');
const sharp = require('sharp');

const ROOT = path.join(__dirname, '..');
let separationPairs = [];
let feedbackRows = [];
process.env.FACE_DETECTOR_SERVICE_URL = 'http://127.0.0.1:8009';

const otherFace = [0.4, Math.sqrt(1 - (0.4 * 0.4))];
const rows = [
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
          assert.deepStrictEqual(params[3].slice().sort((a, b) => a - b), [1, 2, 3, 4], 'memory must be scoped to authorized photos');
          return [feedbackRows];
        }
        if (sql.includes('FROM face_person_separations')) return [separationPairs];
        if (sql.includes('FROM photo_faces')) return [rows];
        if (sql.includes('FROM face_persons')) return [[{ id: 10, name: 'query person' }]];
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
  exports: { post: async () => ({ data: { faces: [{ normalizedEmbedding: [1, 0] }] } }) },
};

const { findMe } = require(path.join(ROOT, 'lib/find_me'));

async function main() {
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
  console.log('find me precision: unrelated co-occurring person is excluded');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
