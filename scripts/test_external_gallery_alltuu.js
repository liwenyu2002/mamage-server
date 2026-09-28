const assert = require('node:assert/strict');
const {
  parseAlltuuUrl, normalizeAlltuuAsset, mapAlltuuPhoto, collectAlltuuPage,
} = require('../lib/external_gallery_alltuu');
const { sourceFromUrl } = require('../lib/external_import_jobs');

const albumId = 'b459f6a4593270328bff138c37df610e';
assert.deepEqual(parseAlltuuUrl(`https://m.alltuu.com/album/${albumId}?menu=photo`), {
  albumId, canonicalUrl: `https://m.alltuu.com/album/${albumId}`,
});
assert.equal(parseAlltuuUrl(`http://m.alltuu.com/album/${albumId}`), null);
assert.equal(parseAlltuuUrl(`https://m.alltuu.com.evil.test/album/${albumId}`), null);
assert.equal(parseAlltuuUrl(`https://m.alltuu.com@127.0.0.1/album/${albumId}`), null);
assert.equal(parseAlltuuUrl(`https://m.alltuu.com/private/${albumId}`), null);
assert.deepEqual(sourceFromUrl(`https://m.alltuu.com/album/${albumId}?menu=photo`), {
  provider: 'alltuu', sourceUrl: `https://m.alltuu.com/album/${albumId}`, title: 'Alltuu 相册',
});

const original = 'https://uio.alltuu.com/photo.jpg?Expires=123&Signature=signed';
assert.equal(normalizeAlltuuAsset(original, 'uio.alltuu.com'), original);
assert.equal(normalizeAlltuuAsset('https://uis.alltuu.com/photo.jpg', 'uio.alltuu.com'), null);
assert.equal(normalizeAlltuuAsset('http://uio.alltuu.com/photo.jpg', 'uio.alltuu.com'), null);

const sections = new Map([['4432577608', '图片直播']]);
const entry = {
  id: 123, sepIdN: '4432577608', n: 'event.jpg',
  sl: 'https://uis.alltuu.com/sl/photo.jpg?Expires=123', ol: original,
  w: 4000, h: 2666, time: 1757507822000,
};
const photo = mapAlltuuPhoto(entry, sections, 1);
assert.equal(photo.transferUrl, original);
assert.equal(photo.sectionName, '图片直播');
assert.equal(photo.filename, 'event.jpg');
assert.equal(photo.watermarked, false);
assert.equal(photo.captureTime, '2025-09-10 20:37:02');
assert.equal(mapAlltuuPhoto({ ...entry, ol: undefined }, sections, 1), null);
assert.equal(mapAlltuuPhoto({ ...entry, sepIdN: 'other' }, sections, 1), null);

const seen = new Set();
const observed = new Set();
const pages = Array.from({ length: 13 }, (_, page) => Array.from({ length: 100 }, (_, index) => ({
  ...entry, id: page * 100 + index + 1,
})));
const collected = pages.flatMap((page) => collectAlltuuPage(page, sections, seen, observed));
assert.equal(collected.length, 1300);
assert.equal(collectAlltuuPage(pages[0], sections, seen, observed).length, 0);
assert.equal(observed.size, 1300);
assert.deepEqual(collected.map((item) => item.sourceOrder), Array.from({ length: 1300 }, (_, index) => index + 1));

console.log('Alltuu gallery scan tests passed');
