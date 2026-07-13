// 整文复现「存档固化」：把推文里的微信图片（mmbiz/qpic）下载转存到自有对象存储，
// 改写为自家 /api/image 链接，使存档不依赖 mmbiz 长期可用性（防盗链/清理/改版）。
// 未配置对象存储时整体降级为 no-op（此时仍由 /api/wx-img 外链代理保证渲染）。
// storage 抽象仍沿用项目遗留文件名 cos_storage（内部是 S3 兼容客户端，provider 无关）。
const crypto = require('crypto');
const cosStorage = require('./cos_storage');

function isWeChatImageHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return /(?:^|\.)qpic\.cn$/.test(h) || /(?:^|\.)qlogo\.cn$/.test(h);
}

// /api/wx-img?url=<enc> 还原成原始 mmbiz URL；非代理链原样返回。
function unwrapProxyUrl(u) {
  const s = String(u || '');
  const m = s.match(/^\/api\/wx-img\?url=([^&]+)/);
  if (!m) return s;
  try { return decodeURIComponent(m[1]); } catch { return s; }
}

function isWeChatImageUrl(u) {
  try { return isWeChatImageHost(new URL(unwrapProxyUrl(u)).hostname); } catch { return false; }
}

const EXT_BY_CT = new Map([
  ['image/jpeg', '.jpg'], ['image/png', '.png'], ['image/gif', '.gif'],
  ['image/webp', '.webp'], ['image/bmp', '.bmp'], ['image/svg+xml', '.svg'],
]);

// 收集 doc 中所有原始微信图片 URL（img src/data-src、background-image url()、styled imageCard.src）。
function collectWeChatUrls(doc) {
  const urls = new Set();
  const decodeEntities = (str) => String(str || '')
    .replace(/&quot;/g, '"').replace(/&#0*34;/g, '"')
    .replace(/&#0*39;/g, "'").replace(/&apos;/g, "'");
  const addFromHtml = (html) => {
    // 序列化 html 里 style 内的引号常被转义成 &quot;（url(&quot;...&quot;)），先解码再抽取。
    const s = decodeEntities(html);
    // background-image: url(...) 与 <img src/data-src=...>
    const re = /url\(\s*['"]?([^)'"]+)['"]?\s*\)|(?:src|data-src)\s*=\s*['"]([^'"]+)['"]/gi;
    let m;
    while ((m = re.exec(s))) {
      const raw = m[1] || m[2];
      if (!raw) continue;
      const orig = unwrapProxyUrl(raw.trim());
      if (isWeChatImageUrl(orig)) urls.add(orig);
    }
  };
  for (const b of Array.isArray(doc) ? doc : []) {
    if (!b || typeof b !== 'object') continue;
    if (typeof b.html === 'string') addFromHtml(b.html);
    if (typeof b.src === 'string' && isWeChatImageUrl(b.src)) urls.add(unwrapProxyUrl(b.src));
    if (typeof b.caption === 'string') addFromHtml(b.caption);
  }
  return urls;
}

async function fetchImage(url, { timeoutMs = 15000, maxBytes = 30 * 1024 * 1024 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36', Accept: 'image/*,*/*' },
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    const ct = String(r.headers.get('content-type') || '').toLowerCase();
    if (!/^image\//.test(ct)) throw new Error(`not image: ${ct}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > maxBytes) throw new Error('too large');
    return { buf, ext: EXT_BY_CT.get(ct.split(';')[0]) || '.png' };
  } finally { clearTimeout(timer); }
}

// 下载并上传到对象存储，返回 { origUrl -> ownUrl } 映射（失败的条目不进 map，保留原链由代理兜底）。
async function rehostUrls(urls, { concurrency = 4, logger = console } = {}) {
  const list = [...urls];
  const map = {};
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const url = list[i++];
      try {
        const { buf, ext } = await fetchImage(url);
        const hash = crypto.createHash('sha1').update(url).digest('hex').slice(0, 24);
        const key = `uploads/wechat/${hash}${ext}`;
        await cosStorage.uploadBuffer(key, buf, { contentType: `image/${ext.slice(1) === 'jpg' ? 'jpeg' : ext.slice(1)}` });
        map[url] = cosStorage.objectUrlForKey(key);
      } catch (e) {
        if (logger && logger.warn) logger.warn('[wx_rehost] skip', url.slice(0, 60), e && e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, list.length) }, worker));
  return map;
}

function replaceUrlEverywhere(str, origUrl, ownUrl) {
  let out = String(str || '');
  const enc = encodeURIComponent(origUrl);
  // 1) 代理链 /api/wx-img?url=<enc origUrl>  2) 原始裸链
  out = out.split(`/api/wx-img?url=${enc}`).join(ownUrl);
  out = out.split(origUrl).join(ownUrl);
  return out;
}

function rewriteDoc(doc, map) {
  const entries = Object.entries(map);
  if (!entries.length) return doc;
  return (Array.isArray(doc) ? doc : []).map((b) => {
    if (!b || typeof b !== 'object') return b;
    const nb = { ...b };
    for (const [orig, own] of entries) {
      if (typeof nb.html === 'string') nb.html = replaceUrlEverywhere(nb.html, orig, own);
      if (typeof nb.caption === 'string') nb.caption = replaceUrlEverywhere(nb.caption, orig, own);
      if (typeof nb.src === 'string') nb.src = replaceUrlEverywhere(nb.src, orig, own);
    }
    return nb;
  });
}

// 主入口：给定 doc，返回 { doc（已改写或原样）, total, rehosted, skipped }。全程 best-effort，
// 任何异常都回退为原 doc（此时 /api/wx-img 代理仍保证渲染），绝不阻断存档保存。
async function rehostDocImages(doc, { logger = console } = {}) {
  if (!cosStorage.isConfigured()) return { doc, total: 0, rehosted: 0, skipped: 'cos_not_configured' };
  try {
    const urls = collectWeChatUrls(doc);
    if (!urls.size) return { doc, total: 0, rehosted: 0 };
    const map = await rehostUrls(urls, { logger });
    const newDoc = rewriteDoc(doc, map);
    return { doc: newDoc, total: urls.size, rehosted: Object.keys(map).length };
  } catch (e) {
    if (logger && logger.error) logger.error('[wx_rehost] failed, keep original doc:', e && e.message);
    return { doc, total: 0, rehosted: 0, error: String(e && e.message || e).slice(0, 120) };
  }
}

module.exports = {
  collectWeChatUrls, unwrapProxyUrl, isWeChatImageUrl, rewriteDoc, rehostDocImages,
};
