const { chromium } = require('playwright');

const ALBUM_HOST = 'm.alltuu.com';
const API_HOST = 'v4c.alltuu.com';
const BROWSER_HOSTS = new Set([
  ALBUM_HOST, API_HOST, 'fa.alltuu.site', 'cdn.alltuu.site',
  'pnc.alltuu.com', 'spu.alltuu.com', 'st.alltuu.com', 'at.alicdn.com',
]);
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SCAN_TIMEOUT_MS = 10 * 60 * 1000;

function scanError(message, code) {
  return Object.assign(new Error(message), { code });
}

function parseAlltuuUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { return null; }
  if (url.protocol !== 'https:' || url.hostname !== ALBUM_HOST || url.username || url.password || url.port) return null;
  const match = url.pathname.match(/^\/album\/([a-f0-9]{32})\/?$/i);
  if (!match) return null;
  return { albumId: match[1].toLowerCase(), canonicalUrl: `https://${ALBUM_HOST}/album/${match[1].toLowerCase()}` };
}

function normalizeAlltuuAsset(value, host) {
  try {
    const url = new URL(String(value || ''));
    if (url.protocol !== 'https:' || url.hostname !== host || url.username || url.password || url.port
      || !/\.(?:jpe?g|png|webp|heic|heif)$/i.test(url.pathname)) return null;
    return url.href;
  } catch (_) { return null; }
}

function mapAlltuuPhoto(photo, sections, sourceOrder) {
  const id = String(photo?.id || '');
  if (!/^\d+$/.test(id) || !sections.has(String(photo.sepIdN || ''))) return null;
  const transferUrl = normalizeAlltuuAsset(photo.ol, 'uio.alltuu.com');
  if (!transferUrl) return null;
  const previewUrl = normalizeAlltuuAsset(photo.sl, 'uis.alltuu.com') || transferUrl;
  const filename = String(photo.n || `${id}.jpg`).replace(/[\\/\r\n]/g, '_').slice(0, 180);
  const capturedMs = Number(photo.time);
  const captureTime = Number.isSafeInteger(capturedMs)
    && capturedMs > 946684800000 && capturedMs < Date.now() + 366 * 86400000
    ? new Date(capturedMs).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai', hour12: false }) : null;
  return {
    id, filename, previewUrl, transferUrl,
    width: Number(photo.w) || null, height: Number(photo.h) || null,
    watermarked: false, sectionName: sections.get(String(photo.sepIdN)),
    captureTime, sourceOrder,
  };
}

function collectAlltuuPage(entries, sections, seen, observed) {
  const batch = [];
  for (const entry of entries) {
    const id = String(entry?.id || '');
    if (!/^\d+$/.test(id) || !sections.has(String(entry.sepIdN || ''))) continue;
    observed.add(id);
    if (seen.has(id)) continue;
    const photo = mapAlltuuPhoto(entry, sections, seen.size + 1);
    if (!photo) continue;
    seen.add(id);
    batch.push(photo);
  }
  return batch;
}

async function scanAlltuu(rawUrl, options = {}) {
  const parsed = parseAlltuuUrl(rawUrl);
  if (!parsed) throw Object.assign(new Error('目前仅支持 Alltuu 的公开 HTTPS 相册链接'), { status: 400 });

  const browser = await chromium.launch({
    headless: true,
    ...(process.env.EXTERNAL_IMPORT_CHROMIUM_PATH ? { executablePath: process.env.EXTERNAL_IMPORT_CHROMIUM_PATH } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 }, serviceWorkers: 'block',
    acceptDownloads: false, userAgent: USER_AGENT,
  });
  const seen = new Set();
  const observed = new Set();
  const sections = new Map();
  const photos = options.onBatch ? null : [];
  let title = '';
  let reportedTotal = null;
  let responseTask = Promise.resolve();
  let responseError = null;
  let metadataReadyResolve;
  const metadataReady = new Promise((resolve) => { metadataReadyResolve = resolve; });
  try {
    await context.route('**/*', (route) => {
      const request = route.request();
      let url;
      try { url = new URL(request.url()); } catch (_) { return route.abort(); }
      if (url.protocol !== 'https:' || !BROWSER_HOSTS.has(url.hostname)) return route.abort();
      if (request.resourceType() === 'image' || request.resourceType() === 'font') return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    page.on('response', (response) => {
      let url;
      try { url = new URL(response.url()); } catch (_) { return; }
      if (url.hostname !== API_HOST) return;
      const path = url.pathname;
      const isConfig = path.includes(`/rest/v4c/fa/a${parsed.albumId}/`);
      const isStats = path.includes(`/rest/v4o/us/a${parsed.albumId}/`);
      const isList = path.includes('/rest/v4c/fplN/');
      if (!isConfig && !isStats && !isList) return;
      if (response.status() === 429) {
        responseError = scanError('来源网站限制访问', 'SOURCE_RATE_LIMIT');
        return;
      }
      if (response.status() === 403) {
        responseError = scanError('来源相册拒绝访问', 'SOURCE_FORBIDDEN');
        return;
      }
      if (!response.ok()) return;
      if (isConfig || isStats) {
        response.json().then((payload) => {
          if (payload?.e !== 0) return;
          if (isConfig) {
            title = String(payload.d?.albumDTO?.title || '').replace(/\s+/g, ' ').trim().slice(0, 255);
            for (const section of payload.d?.seperateDTOList || []) {
              if (section.idEnc && section.name && Number(section.sepPrivacy || 0) === 0) {
                sections.set(String(section.idEnc), String(section.name).replace(/\s+/g, ' ').trim().slice(0, 80));
              }
            }
          } else {
            const count = Number(payload.d?.photoCount);
            if (Number.isSafeInteger(count) && count >= 0) reportedTotal = count;
          }
        }).catch((err) => { responseError = err; });
        return;
      }
      responseTask = responseTask.then(async () => {
        if (responseError) return;
        const payload = await response.json();
        if (payload?.e !== 0) return;
        if (Array.isArray(payload.d)) {
          await metadataReady;
          if (!sections.size || ![...sections.keys()].some((id) => path.split('/').includes(`s${id}`))) return;
          const batch = collectAlltuuPage(payload.d, sections, seen, observed);
          if (batch.length) {
            if (photos) photos.push(...batch);
            if (options.onBatch) await options.onBatch(batch, { reportedTotal, title });
          }
        }
      }).catch((err) => { responseError = err; });
    });

    const navigation = await page.goto(parsed.canonicalUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!navigation?.ok()) throw scanError('来源相册无法打开', 'SOURCE_FORBIDDEN');
    const deadline = Date.now() + (options.timeoutMs || SCAN_TIMEOUT_MS);
    const metadataDeadline = Math.min(deadline, Date.now() + 25000);
    while ((!title || reportedTotal === null || !sections.size) && Date.now() < metadataDeadline) {
      if (options.shouldStop?.()) throw scanError('Import stopped', 'IMPORT_STOPPED');
      if (responseError) throw responseError;
      await page.waitForTimeout(300);
    }
    if (!title || reportedTotal === null || !sections.size) {
      throw scanError('未能读取来源相册的标题、分组或照片总数', 'SOURCE_METADATA');
    }
    if (options.onMetadata) await options.onMetadata({ title, reportedTotal });
    metadataReadyResolve();

    let unchanged = 0;
    let previousCount = -1;
    while (observed.size < reportedTotal && Date.now() < deadline) {
      if (options.shouldStop?.()) throw scanError('Import stopped', 'IMPORT_STOPPED');
      await responseTask;
      if (responseError) throw responseError;
      const scrolled = await page.locator('.album-component-scroll').evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return true;
      }).catch(() => false);
      await page.waitForTimeout(2200);
      await responseTask;
      if (responseError) throw responseError;
      unchanged = observed.size === previousCount ? unchanged + 1 : 0;
      previousCount = observed.size;
      if (!scrolled || unchanged >= 4) break;
    }
    await responseTask;
    if (responseError) throw responseError;
    if (!seen.size && !reportedTotal) throw scanError('相册中没有可转存的照片', 'SOURCE_EMPTY');
    const finalPage = parseAlltuuUrl(page.url());
    if (!finalPage || finalPage.albumId !== parsed.albumId) throw scanError('相册跳转到了其他页面', 'SOURCE_REDIRECT');
    if (observed.size < reportedTotal || seen.size < observed.size) {
      throw scanError(`扫描未完成：找到 ${seen.size} / ${reportedTotal} 张可转存原图`, 'SCAN_INCOMPLETE');
    }
    return {
      provider: 'alltuu', sourceUrl: parsed.canonicalUrl, title,
      suggestedAlbumTitle: title, suggestedSections: [...new Set([...sections.values()])],
      reportedTotal, scannedCount: seen.size, complete: true,
      quality: 'vendor_original', templateSource: 'builtin', photos: photos || [],
    };
  } finally {
    metadataReadyResolve();
    await responseTask.catch(() => null);
    await context.close().catch(() => null);
    await browser.close().catch(() => null);
  }
}

module.exports = { parseAlltuuUrl, normalizeAlltuuAsset, mapAlltuuPhoto, collectAlltuuPage, scanAlltuu };
