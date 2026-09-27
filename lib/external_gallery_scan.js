const { chromium } = require('playwright');

const PHOTO_PLUS_HOST = 'live.photoplus.cn';
const ALLOWED_BROWSER_HOSTS = new Set([
  PHOTO_PLUS_HOST,
  'q.plusx.cn',
  'pb.plusx.cn',
  'at.alicdn.com',
  'cdn.bootcss.com',
]);
const MAX_PHOTOS = 1000;

function parsePhotoPlusUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.hostname !== PHOTO_PLUS_HOST || url.username || url.password) return null;
  const match = url.pathname.match(/^\/live\/(?:pc\/)?(\d{5,12})\/?$/);
  if (!match) return null;
  return {
    activityNo: match[1],
    canonicalUrl: `https://${PHOTO_PLUS_HOST}/live/${match[1]}#/live`,
  };
}

function normalizePhotoPlusAsset(value) {
  try {
    const url = new URL(String(value || '').startsWith('//') ? `https:${value}` : String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== 'pb.plusx.cn' || url.username || url.password) return null;
    return url.href;
  } catch (_) {
    return null;
  }
}

function mapPhotoPlusPhoto(photo, activityNo) {
  if (String(photo?.activity_no || '') !== String(activityNo)) return null;
  const id = String(photo.id || '');
  if (!/^\d+$/.test(id)) return null;
  const previewUrl = normalizePhotoPlusAsset(photo.small_img || photo.middle_img);
  // Only transfer the watermarked version offered by the public viewer.
  const transferUrl = normalizePhotoPlusAsset(photo.watermark_origin_img || photo.watermark_big_img);
  if (!previewUrl || !transferUrl) return null;
  return {
    id,
    filename: String(photo.pic_name || `${id}.jpg`).replace(/[\\/\r\n]/g, '_').slice(0, 180),
    previewUrl,
    transferUrl,
    width: Number(photo.width) || null,
    height: Number(photo.height) || null,
    watermarked: true,
    sectionName: null,
  };
}

async function scanPhotoPlus(rawUrl, options = {}) {
  const parsed = parsePhotoPlusUrl(rawUrl);
  if (!parsed) throw Object.assign(new Error('目前仅支持 PhotoPlus 的 HTTPS 相册链接'), { status: 400 });

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.EXTERNAL_IMPORT_CHROMIUM_PATH ? { executablePath: process.env.EXTERNAL_IMPORT_CHROMIUM_PATH } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    serviceWorkers: 'block',
    acceptDownloads: false,
  });
  const photos = new Map();
  let reportedTotal = 0;
  let title = '';
  let lastResponseAt = Date.now();
  try {
    await context.route('**/*', (route) => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch (_) { return route.abort(); }
      if (url.protocol !== 'https:' || !ALLOWED_BROWSER_HOSTS.has(url.hostname)) return route.abort();
      if (request.resourceType() === 'image' || request.resourceType() === 'font') return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on('response', async (response) => {
      let url;
      try { url = new URL(response.url()); } catch (_) { return; }
      if (url.hostname !== PHOTO_PLUS_HOST || url.pathname !== '/pic/list' || !response.ok()) return;
      try {
        const result = (await response.json()).result;
        if (!result || !Array.isArray(result.pics_array)) return;
        reportedTotal = Number(result.pics_total) || reportedTotal;
        for (const entry of result.pics_array) {
          const photo = mapPhotoPlusPhoto(entry, parsed.activityNo);
          if (photo && photos.size < MAX_PHOTOS) photos.set(photo.id, photo);
        }
        lastResponseAt = Date.now();
      } catch (_) { /* malformed page data is ignored */ }
    });
    await page.goto(parsed.canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!parsePhotoPlusUrl(page.url()) || parsePhotoPlusUrl(page.url()).activityNo !== parsed.activityNo) {
      throw new Error('相册跳转到了不受支持的页面');
    }
    await page.waitForFunction(() => document.title && document.title !== 'PhotoPlus', null, { timeout: 15000 }).catch(() => null);
    title = (await page.title()).trim().slice(0, 255) || `PhotoPlus ${parsed.activityNo}`;
    const deadline = Date.now() + (options.timeoutMs || 30000);
    let unchanged = 0;
    let previousCount = -1;
    while (Date.now() < deadline && photos.size < MAX_PHOTOS) {
      if (reportedTotal && photos.size >= reportedTotal) break;
      const scrolled = await page.locator('.photo-content.container').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return { top: el.scrollTop, height: el.scrollHeight };
      }).catch(() => null);
      await page.waitForTimeout(850);
      unchanged = photos.size === previousCount ? unchanged + 1 : 0;
      previousCount = photos.size;
      if (unchanged >= 3 && Date.now() - lastResponseAt > 1800) break;
      if (!scrolled && unchanged >= 2) break;
    }
    if (!photos.size) throw new Error('没有找到可查看的照片，请检查链接是否公开可访问');
    return {
      provider: 'photoplus',
      sourceUrl: parsed.canonicalUrl,
      title,
      suggestedAlbumTitle: title,
      suggestedSections: [],
      reportedTotal: reportedTotal || photos.size,
      scannedCount: photos.size,
      complete: (!reportedTotal || photos.size >= reportedTotal) && reportedTotal <= MAX_PHOTOS,
      quality: 'watermarked_original_view',
      templateSource: 'builtin',
      photos: [...photos.values()],
    };
  } finally {
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

module.exports = { parsePhotoPlusUrl, normalizePhotoPlusAsset, mapPhotoPlusPhoto, scanPhotoPlus };
