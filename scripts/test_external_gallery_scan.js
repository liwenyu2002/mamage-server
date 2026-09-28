const assert = require('node:assert/strict');
const { parsePhotoPlusUrl, normalizePhotoPlusAsset, mapPhotoPlusPhoto, collectPhotoPlusPage } = require('../lib/external_gallery_scan');

assert.deepEqual(parsePhotoPlusUrl('https://live.photoplus.cn/live/92304200?accessFrom=qrcode#/live'), {
  activityNo: '92304200',
  canonicalUrl: 'https://live.photoplus.cn/live/92304200#/live',
});
assert.equal(parsePhotoPlusUrl('http://live.photoplus.cn/live/92304200'), null);
assert.equal(parsePhotoPlusUrl('https://live.photoplus.cn.evil.test/live/92304200'), null);
assert.equal(parsePhotoPlusUrl('https://live.photoplus.cn@127.0.0.1/live/92304200'), null);
assert.equal(parsePhotoPlusUrl('https://live.photoplus.cn/private/92304200'), null);

assert.equal(normalizePhotoPlusAsset('//pb.plusx.cn/photo.jpg?sign=abc'), 'https://pb.plusx.cn/photo.jpg?sign=abc');
assert.equal(normalizePhotoPlusAsset('https://127.0.0.1/photo.jpg'), null);
assert.equal(normalizePhotoPlusAsset('http://pb.plusx.cn/photo.jpg'), null);

const photo = mapPhotoPlusPhoto({
  id: 123,
  activity_no: '92304200',
  pic_name: 'event.jpg',
  small_img: '//pb.plusx.cn/preview.jpg',
  watermark_origin_img: '//pb.plusx.cn/watermarked.jpg',
  origin_img: '//pb.plusx.cn/unwatermarked.jpg',
  width: 4800,
  height: 3200,
}, '92304200');
assert.equal(photo.transferUrl, 'https://pb.plusx.cn/watermarked.jpg');
assert.equal(photo.watermarked, true);
assert.equal(mapPhotoPlusPhoto({ ...photo, activity_no: 'other' }, '92304200'), null);

const seen = new Set();
const pages = Array.from({ length: 13 }, (_, page) => Array.from({ length: 100 }, (_, index) => ({
  id: page * 100 + index + 1,
  activity_no: '92304200',
  pic_name: `photo-${page * 100 + index + 1}.jpg`,
  small_img: '//pb.plusx.cn/preview.jpg',
  watermark_origin_img: '//pb.plusx.cn/original.jpg',
})));
const collected = pages.flatMap((page) => collectPhotoPlusPage(page, '92304200', seen));
assert.equal(collected.length, 1300);
assert.equal(collectPhotoPlusPage(pages[0], '92304200', seen).length, 0);

console.log('external gallery scan tests passed');
