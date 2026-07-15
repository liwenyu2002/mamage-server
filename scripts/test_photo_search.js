const assert = require('assert');
const {
  heuristicPhotoSearchPlan,
  normalizePhotoSearchPlan,
  shouldUseAiPhotoSearch,
} = require('../lib/ai_photo_search');
const { escapeLikeToken, textMatch, tokenizeLiteralQuery } = require('../lib/photo_search');

function run() {
  const video = heuristicPhotoSearchPlan('只看最新视频');
  assert.strictEqual(video.mediaType, 'video');
  assert.strictEqual(video.sort, 'newest');
  assert.deepStrictEqual(video.mustTerms, []);

  const quality = heuristicPhotoSearchPlan('给我推荐照片');
  assert.strictEqual(quality.quality, 'recommended');
  assert.deepStrictEqual(quality.mustTerms, []);

  const exclude = heuristicPhotoSearchPlan('演讲照片，不要合影');
  assert.ok(exclude.mustTerms.includes('演讲'));
  assert.ok(exclude.excludeTerms.includes('合影'));

  const personOnly = heuristicPhotoSearchPlan('画面里只有王婧琦的照片');
  assert.strictEqual(personOnly.peopleOnly, true);
  assert.deepStrictEqual(personOnly.mustTerms, ['王婧琦']);

  const normalized = normalizePhotoSearchPlan({
    mustTerms: ['演讲', '演讲', ' 讲台 '],
    people: ['田心原'],
    peopleMode: 'all',
    peopleOnly: true,
    mediaType: 'INVALID',
    quality: 'recommended',
    dateFrom: '2026-02-30',
  }, '测试');
  assert.deepStrictEqual(normalized.mustTerms, ['演讲', '讲台']);
  assert.deepStrictEqual(normalized.people, ['田心原']);
  assert.strictEqual(normalized.peopleMode, 'all');
  assert.strictEqual(normalized.peopleOnly, true);
  assert.strictEqual(normalized.mediaType, 'all');
  assert.strictEqual(normalized.quality, 'recommended');
  assert.strictEqual(normalized.dateFrom, null);

  assert.strictEqual(shouldUseAiPhotoSearch('团代会', true), false);
  assert.strictEqual(shouldUseAiPhotoSearch('田心原在讲台演讲', true), true);
  assert.strictEqual(shouldUseAiPhotoSearch('快速：田心原在讲台演讲', true), false);
  assert.strictEqual(escapeLikeToken('a%b_c#d'), 'a#%b#_c##d');
  assert.deepStrictEqual(tokenizeLiteralQuery('田心原，演讲  推荐'), ['田心原', '演讲', '推荐']);
  assert.strictEqual(textMatch('演讲').params.length, 10);

  console.log('photo search selfcheck: passed');
}

run();
