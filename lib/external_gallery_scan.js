const { chromium } = require('playwright');

const PHOTO_PLUS_HOST = 'live.photoplus.cn';
const ALLOWED_BROWSER_HOSTS = new Set([
  PHOTO_PLUS_HOST,
  'q.plusx.cn',
  'pb.plusx.cn',
  'at.alicdn.com',
  'cdn.bootcss.com',
]);
const DEFAULT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;

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
  const previewUrl = normalizePhotoPlusAsset(photo.middle_img || photo.small_img);
  // Only transfer the watermarked version offered by the public viewer.
  const transferUrl = normalizePhotoPlusAsset(photo.watermark_origin_img || photo.watermark_big_img);
  if (!previewUrl || !transferUrl) return null;
  const capturedSeconds = Number(photo.exif_timestamp);
  const captureTime = Number.isSafeInteger(capturedSeconds)
    && capturedSeconds > 631152000 && capturedSeconds < Date.now() / 1000 + 366 * 86400
    ? new Date(capturedSeconds * 1000).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }) : null;
  return {
    id,
    filename: String(photo.pic_name || `${id}.jpg`).replace(/[\\/\r\n]/g, '_').slice(0, 180),
    previewUrl,
    transferUrl,
    width: Number(photo.width) || null,
    height: Number(photo.height) || null,
    watermarked: true,
    sectionName: null,
    captureTime,
    sourceOrder: captureTime ? capturedSeconds : null,
  };
}

function collectPhotoPlusPage(entries, activityNo, seen) {
  const batch = [];
  for (const entry of entries) {
    const photo = mapPhotoPlusPhoto(entry, activityNo);
    if (!photo || seen.has(photo.id)) continue;
    seen.add(photo.id);
    batch.push(photo);
  }
  return batch;
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
  const seen = new Set();
  const photos = options.onBatch ? null : [];
  let reportedTotal = 0;
  let title = '';
  let lastResponseAt = Date.now();
  let responseTask = Promise.resolve();
  let responseError = null;
  let metadataReadyResolve;
  const metadataReady = new Promise((resolve) => { metadataReadyResolve = resolve; });
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
    page.on('response', (response) => {
      let url;
      try { url = new URL(response.url()); } catch (_) { return; }
      if (url.hostname !== PHOTO_PLUS_HOST || url.pathname !== '/pic/list') return;
      if (response.status() === 429) {
        responseError = Object.assign(new Error('Source rate limited'), { code: 'SOURCE_RATE_LIMIT' });
        return;
      }
      if (!response.ok()) return;
      responseTask = responseTask.then(async () => {
        if (responseError) return;
        let result;
        try { result = (await response.json()).result; } catch (_) { return; }
        if (!result || !Array.isArray(result.pics_array)) return;
        await metadataReady;
        reportedTotal = Number(result.pics_total) || reportedTotal;
        const batch = collectPhotoPlusPage(result.pics_array, parsed.activityNo, seen);
        if (batch.length) {
          if (photos) photos.push(...batch);
          if (options.onBatch) await options.onBatch(batch, { reportedTotal, title });
        }
        lastResponseAt = Date.now();
      }).catch((err) => { responseError = err; });
    });
    await page.goto(parsed.canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('h1').first().waitFor({ timeout: 8000 }).catch(() => null);
    title = String(await page.locator('h1').first().textContent().catch(() => '') || await page.title())
      .trim().slice(0, 255) || `PhotoPlus ${parsed.activityNo}`;
    if (options.onMetadata) await options.onMetadata({ title, reportedTotal });
    metadataReadyResolve();
    const deadline = Date.now() + (options.timeoutMs || DEFAULT_SCAN_TIMEOUT_MS);
    while (seen.size === 0 && Date.now() < deadline) {
      if (options.shouldStop?.()) throw Object.assign(new Error('Import stopped'), { code: 'IMPORT_STOPPED' });
      await responseTask;
      if (responseError) throw responseError;
      await page.waitForTimeout(400);
    }
    let unchanged = 0;
    let previousCount = -1;
    while (Date.now() < deadline) {
      if (options.shouldStop?.()) throw Object.assign(new Error('Import stopped'), { code: 'IMPORT_STOPPED' });
      await responseTask;
      if (responseError) throw responseError;
      if (reportedTotal && seen.size >= reportedTotal) break;
      const scrolled = await page.locator('.photo-content.container').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return { top: el.scrollTop, height: el.scrollHeight };
      }).catch(() => null);
      await page.waitForTimeout(850);
      await responseTask;
      if (responseError) throw responseError;
      unchanged = seen.size === previousCount ? unchanged + 1 : 0;
      previousCount = seen.size;
      if (unchanged >= 3 && Date.now() - lastResponseAt > 1800) break;
      if (!scrolled && unchanged >= 2) break;
    }
    await responseTask;
    if (responseError) throw responseError;
    if (!seen.size) throw Object.assign(new Error('没有找到可查看的照片，请检查链接是否公开可访问'), { code: 'SOURCE_EMPTY' });
    const finalPage = parsePhotoPlusUrl(page.url());
    if (!finalPage || finalPage.activityNo !== parsed.activityNo) throw Object.assign(new Error('相册跳转到了不受支持的页面'), { code: 'SOURCE_REDIRECT' });
    if (reportedTotal && seen.size < reportedTotal) {
      throw Object.assign(new Error(`扫描未完成：发现 ${seen.size} / ${reportedTotal} 张`), { code: 'SCAN_INCOMPLETE' });
    }
    return {
      provider: 'photoplus',
      sourceUrl: parsed.canonicalUrl,
      title,
      suggestedAlbumTitle: title,
      suggestedSections: [],
      reportedTotal: reportedTotal || seen.size,
      scannedCount: seen.size,
      complete: true,
      quality: 'watermarked_original_view',
      templateSource: 'builtin',
      photos: photos || [],
    };
  } finally {
    metadataReadyResolve();
    await responseTask.catch(() => null);
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

module.exports = { parsePhotoPlusUrl, normalizePhotoPlusAsset, mapPhotoPlusPhoto, collectPhotoPlusPage, scanPhotoPlus };
