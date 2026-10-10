const assert = require('node:assert/strict');
const { createProjectPreviewReader, selectPreviewRepresentatives } = require('../lib/project_previews');
const rows = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, thumbUrl: `/thumb/${i + 1}.jpg` }));
const embeddings = rows.map(row => ({ photo_id: row.id, embedding: Array.from({ length: 30 }, (_, i) => i === Math.floor((row.id - 1) / 2) ? 1 : 0) }));
const result = selectPreviewRepresentatives(rows, embeddings);
assert.equal(result.photos.length, 21);
assert.equal(new Set(result.photos.map(row => Math.floor((row.id - 1) / 2))).size, 21);
assert.equal(selectPreviewRepresentatives(rows, embeddings, 100).photos.length, 21);
assert.equal(result.diversity, 'similarity');
assert.equal(result.photos[0].id, 1);
assert(result.photos.some(row => row.id > 50), 'samples should span the whole album');
const same = selectPreviewRepresentatives(rows, rows.map(row => ({ photo_id: row.id, embedding: '[1,0]' })));
assert.equal(same.photos.length, 1, 'never fill with analyzed near duplicates');
assert.equal(selectPreviewRepresentatives([], []).photos.length, 0);
assert.equal(selectPreviewRepresentatives(rows.slice(0, 3), []).photos.length, 3);
const missing = selectPreviewRepresentatives(rows, [{ photo_id: 1, embedding: [1, 0] }, { photo_id: 2, embedding: 'broken' }]);
assert.equal(missing.photos.length, 21);
assert.equal(missing.diversity, 'mixed');
assert.equal(selectPreviewRepresentatives([{ id: 1, thumbUrl: '/same' }, { id: 2, thumbUrl: '/same' }], []).photos.length, 1);
assert.equal(selectPreviewRepresentatives(rows, [{ photo_id: 1, embedding: [0, 0] }, { photo_id: 2, embedding: [NaN, 1] }]).analyzedCount, 0);

(async () => {
  let time = 0, queries = 0;
  const db = { query: async (sql, params) => {
    queries++;
    if (sql.includes('FROM photos')) {
      assert(sql.includes('LIMIT ?'));
      assert.equal(params.at(-1), 160);
      return [rows];
    }
    assert.deepEqual(params[0], rows.map(row => row.id));
    assert.equal(params[1], 'resnet50');
    return [embeddings];
  } };
  const read = createProjectPreviewReader(db, () => time);
  const [first, second] = await Promise.all([read(1, 2), read(1, 2)]);
  assert.equal(first, second); assert.equal(queries, 2);
  await read(1, 2); assert.equal(queries, 2);
  await read(1, 3); assert.equal(queries, 4, 'organization caches must be isolated');
  time = 30001; await read(1, 2); assert.equal(queries, 6, 'fresh analysis becomes visible after expiry');
  let fail = true;
  const retry = createProjectPreviewReader({ query: async () => { if (fail) throw new Error('database down'); return [[]]; } });
  await assert.rejects(retry(1, 2)); fail = false;
  assert.equal((await retry(1, 2)).photos.length, 0);
  const burst = Array.from({ length: 160 }, (_, i) => ({ id: i, thumbUrl: `/t/${i}` }));
  const large = burst.map(row => ({ photo_id: row.id, embedding: Array.from({ length: 2048 }, (_, i) => i === row.id ? 1 : 0) }));
  const start = performance.now(); selectPreviewRepresentatives(burst, large);
  console.log(`PASS: unique similarity representatives, sampling, missing vectors, bounded queries, coalescing, scoped cache and retry (${Math.round(performance.now() - start)}ms for 160 x 2048D)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
