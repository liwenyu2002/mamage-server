const assert = require('node:assert/strict');
const { routeKey, validateRules, stablePhotoKey, applyTemplate } = require('../lib/external_gallery_templates');
const { isPublicIp, parsePublicHttpsUrl } = require('../lib/public_remote_fetch');

assert.equal(routeKey(new URL('https://gallery.example.com/event/92304200')), '/event/:id');
assert.equal(parsePublicHttpsUrl('https://127.0.0.1/gallery'), null);
assert.equal(parsePublicHttpsUrl('http://gallery.example.com/gallery'), null);
assert.equal(parsePublicHttpsUrl('https://gallery.example.com:8443/gallery'), null);
assert.equal(isPublicIp('10.2.3.4'), false);
assert.equal(isPublicIp('169.254.10.1'), false);
assert.equal(isPublicIp('203.0.113.2'), false);
assert.equal(isPublicIp('43.137.73.122'), true);

const rules = validateRules({
  itemSelector: 'figure img',
  sourceMode: 'ancestor_link',
  previewAttr: 'data-src',
  captionSelector: 'figcaption',
  albumTitleSelector: 'h1',
  sectionSelector: 'section',
  sectionTitleSelector: 'h2',
});
assert.ok(rules);
assert.ok(validateRules({ itemSelector: 'img.gallery-image', sourceMode: 'img_attribute' }));
assert.equal(validateRules({ itemSelector: 'img:has(script)' }), null);

const result = applyTemplate(`
  <h1>开幕活动</h1>
  <section><h2>签到</h2><time datetime="2026-09-21 09:00">上午九点</time>
    <figure><a href="/photos/one.jpg"><img data-src="/thumbs/one.jpg" alt="嘉宾签到"></a></figure>
    <figure><a href="/photos/two.jpg"><img data-src="/thumbs/two.jpg" alt="会场全景"></a></figure>
  </section>`, 'https://gallery.example.com/event/92304200', rules);
assert.equal(result.title, '开幕活动');
assert.equal(result.photos.length, 2);
assert.equal(result.photos[0].filename, '嘉宾签到.jpg');
assert.equal(result.photos[0].sectionName, '签到');
assert.equal(result.photos[0].sectionTime, '2026-09-21 09:00');
assert.equal(result.photos[0].transferUrl, 'https://gallery.example.com/photos/one.jpg');
assert.equal(result.photos[0].previewUrl, 'https://gallery.example.com/thumbs/one.jpg');

assert.equal(
  stablePhotoKey('https://gallery.example.com/image?id=42&token=old'),
  stablePhotoKey('https://gallery.example.com/image?token=new&id=42')
);
assert.notEqual(
  stablePhotoKey('https://gallery.example.com/image?id=42'),
  stablePhotoKey('https://gallery.example.com/image?id=43')
);
const largeHtml = `<h1>大型活动</h1>${Array.from({ length: 1205 }, (_, index) =>
  `<figure><a href="/original/${index}.jpg"><img data-src="/thumb/${index}.jpg" alt="照片 ${index}"></a></figure>`).join('')}`;
const large = applyTemplate(largeHtml, 'https://gallery.example.com/event/12345', rules);
assert.equal(large.photos.length, 1205);
assert.equal(large.totalMatched, 1205);

console.log('external import template tests passed');
