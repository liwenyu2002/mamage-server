const fs = require('fs');

let playwrightLib;
let browserPromise = null;

function clamp(n, min, max) {
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  if (v < min) return min;
  if (v > max) return max;
  return Math.floor(v);
}

function sanitizeHtmlInput(html) {
  const src = String(html || '');
  if (!src) return '';
  // Keep simple and safe: remove script tags.
  return src.replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '');
}

function sanitizeBaseHref(input, fallback) {
  const raw = String(input || '').trim();
  if (!raw) return fallback;
  try {
    const u = new URL(raw);
    if (!/^https?:$/i.test(u.protocol)) return fallback;
    return u.toString();
  } catch (e) {
    return fallback;
  }
}

function escAttr(v) {
  return String(v || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function ensurePlaywrightLib() {
  if (playwrightLib !== undefined) return playwrightLib;
  try {
    // Prefer full playwright package.
    // eslint-disable-next-line global-require
    playwrightLib = require('playwright');
  } catch (e1) {
    try {
      // Optional fallback.
      // eslint-disable-next-line global-require
      playwrightLib = require('playwright-core');
    } catch (e2) {
      playwrightLib = null;
    }
  }
  return playwrightLib;
}

async function ensureBrowser() {
  const pw = await ensurePlaywrightLib();
  if (!pw || !pw.chromium) {
    const err = new Error('Playwright is not installed');
    err.code = 'PREVIEW_RENDERER_NOT_INSTALLED';
    throw err;
  }

  const launchBaseOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  };

  function pickSystemChromiumPath() {
    const byEnv = [
      process.env.PREVIEW_RENDERER_CHROMIUM_PATH,
      process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
      process.env.CHROME_BIN,
    ].filter(Boolean);
    const candidates = [
      ...byEnv,
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
    ];
    for (const p of candidates) {
      try {
        if (p && fs.existsSync(p)) return p;
      } catch (e) {
        // ignore
      }
    }
    return '';
  }

  async function launchWithFallback() {
    try {
      return await pw.chromium.launch(launchBaseOptions);
    } catch (err) {
      const msg = String((err && (err.message || err.stack)) || '');
      const missingBundled = /Executable doesn't exist/i.test(msg) || /playwright install/i.test(msg);
      if (!missingBundled) throw err;

      const systemPath = pickSystemChromiumPath();
      if (!systemPath) {
        const e = new Error('Playwright browser executable is missing');
        e.code = 'PREVIEW_RENDERER_BROWSER_MISSING';
        throw e;
      }

      try {
        return await pw.chromium.launch({
          ...launchBaseOptions,
          executablePath: systemPath,
        });
      } catch (sysErr) {
        const e = new Error(`System Chromium launch failed at ${systemPath}: ${sysErr && sysErr.message ? sysErr.message : sysErr}`);
        e.code = 'PREVIEW_RENDERER_SYSTEM_BROWSER_FAILED';
        throw e;
      }
    }
  }

  if (!browserPromise) {
    browserPromise = launchWithFallback().catch((err) => {
      browserPromise = null;
      throw err;
    });
  }
  return browserPromise;
}

async function waitForPageAssets(page, timeoutMs) {
  await page.evaluate(async ({ timeout }) => {
    const waitImage = (img) => new Promise((resolve) => {
      if (!img) return resolve();
      if (img.complete) return resolve();
      const done = () => resolve();
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
      setTimeout(resolve, timeout);
    });

    const imgs = Array.from(document.images || []);
    await Promise.all(imgs.map(waitImage));

    if (document.fonts && document.fonts.ready) {
      await Promise.race([
        document.fonts.ready.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, timeout)),
      ]);
    }
  }, { timeout: Math.max(1000, Math.min(8000, timeoutMs || 4000)) });
}

async function renderNewsPreviewPng({
  html,
  width,
  height,
  baseHref,
  authHeader,
  timeoutMs = 25000,
} = {}) {
  const cleanedHtml = sanitizeHtmlInput(html);
  if (!cleanedHtml) {
    const err = new Error('html is required');
    err.code = 'PREVIEW_RENDERER_BAD_INPUT';
    throw err;
  }

  const safeWidth = clamp(width, 480, 1800);
  const safeHeight = clamp(height, 420, 2400);
  const safeBaseHref = sanitizeBaseHref(baseHref, 'http://localhost/');
  const browser = await ensureBrowser();

  const context = await browser.newContext({
    viewport: { width: safeWidth, height: safeHeight },
    deviceScaleFactor: 1.5,
    ignoreHTTPSErrors: true,
  });

  try {
    if (authHeader) {
      await context.setExtraHTTPHeaders({ authorization: String(authHeader) });
    }
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);

    const shell = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <base href="${escAttr(safeBaseHref)}" />
    <style>
      html, body { margin: 0; padding: 0; background: #ffffff; color: #111827; }
      #capture-root {
        box-sizing: border-box;
        width: ${safeWidth}px;
        min-height: ${safeHeight}px;
        padding: 20px 24px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei",
          "Noto Sans CJK SC", "Noto Sans SC", "Source Han Sans SC",
          "WenQuanYi Micro Hei", "WenQuanYi Zen Hei", "Droid Sans Fallback",
          "Arial Unicode MS", sans-serif;
        overflow: hidden;
      }
      img { max-width: 100%; height: auto; display: block; margin: 12px auto; }
    </style>
  </head>
  <body>
    <div id="capture-root"></div>
  </body>
</html>`;

    await page.setContent(shell, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    await page.$eval('#capture-root', (el, inner) => {
      el.innerHTML = inner;
    }, cleanedHtml);

    await waitForPageAssets(page, timeoutMs);

    const contentHeight = await page.$eval('#capture-root', (el) => {
      const h = Math.ceil(el.scrollHeight || el.clientHeight || 0);
      return Number.isFinite(h) ? h : 0;
    });
    const finalViewportHeight = clamp(contentHeight || safeHeight, 420, 12000);
    await page.setViewportSize({ width: safeWidth, height: Math.min(finalViewportHeight, 4000) });

    const png = await page.screenshot({
      type: 'png',
      fullPage: true,
      timeout: timeoutMs,
    });
    return png;
  } finally {
    await context.close().catch(() => null);
  }
}

module.exports = {
  renderNewsPreviewPng,
};
