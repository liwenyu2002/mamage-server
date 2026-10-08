const assert = require('node:assert/strict');
const playwrightPath = require.resolve('playwright');
let loseViewerSign = false;
let navigatedUrl;
const entries = [{ id: 791030761, activity_no: 75137386, pic_name: '5016158.JPG',
  origin_img: '//pb.plusx.cn/photo.JPG~tplv-9lv23dm2t1-image.JPG?sign=fixture',
  watermark_origin_img: '//pb.plusx.cn/photo.JPG~tplv-9lv23dm2t1-exif-rotate-wm-size:0:watermark/1/image/logo.JPG?sign=fixture',
  middle_img: '//pb.plusx.cn/preview.avif?sign=fixture' }];
const page = {
  handler: null,
  on(_event, handler) { this.handler = handler; },
  async goto(url) {
    navigatedUrl = url;
    this.handler({
      url: () => `https://live.photoplus.cn/pic/list?activityNo=75137386${loseViewerSign ? '' : '&ppSign=6925272230967'}`,
      status: () => 200, ok: () => true,
      json: async () => ({ result: { pics_total: 1, pics_array: entries } }),
    });
  },
  locator: () => ({ first: () => ({ waitFor: async () => {}, textContent: async () => '星海共赴 无界启航' }) }),
  title: async () => 'Source album',
  waitForTimeout: async () => {},
  url: () => navigatedUrl,
};
require.cache[playwrightPath] = { id: playwrightPath, filename: playwrightPath, loaded: true,
  exports: { chromium: { launch: async () => ({
    newContext: async () => ({ route: async () => {}, newPage: async () => page, close: async () => {} }),
    close: async () => {},
  }) } } };
const { scanPhotoPlus } = require('../lib/external_gallery_scan');

async function main() {
  const source = 'https://live.photoplus.cn/live/pc/75137386/#/6925272230967';
  const imported = [];
  const result = await scanPhotoPlus(source, { onBatch: async (batch) => imported.push(...batch) });
  assert.equal(navigatedUrl, source, 'browser must navigate to the actual authorized viewer route');
  assert.equal(result.sourceUrl, source);
  assert.equal(imported[0].transferUrl, 'https://pb.plusx.cn/photo.JPG~tplv-9lv23dm2t1-image.JPG?sign=fixture');
  assert.equal(imported[0].watermarked, false);
  assert.equal(result.quality, 'original_view');
  const original = entries[0].origin_img;
  entries[0].origin_img = null;
  await assert.rejects(scanPhotoPlus(source), { code: 'SOURCE_ORIGINAL_UNAVAILABLE' },
    'authorized clean viewer cannot silently fall back to watermarked originals');
  entries[0].origin_img = original;
  loseViewerSign = true;
  await assert.rejects(scanPhotoPlus(source), { code: 'SOURCE_LINK_CONTEXT_LOST' },
    'lost access context must fail rather than silently import watermarked images');
  console.log('PhotoPlus browser chain: viewer access route and original selection preserved; missing signature rejected');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
