// 微信公众号图片外链代理：解决 mmbiz 防盗链——带非微信域名 Referer 的请求会被换成
// "未经允许不得转载" 140x140 水印图。CSS background-image 无法设置 referrerpolicy，
// 故由服务端无 Referer 拉真图、同源回流。仅代理微信图片 CDN（白名单防 SSRF）。
const express = require('express');

const router = express.Router();

const CACHE_CONTROL = process.env.WX_IMG_CACHE_CONTROL || 'public, max-age=2592000, immutable';
const FETCH_TIMEOUT_MS = Number(process.env.WX_IMG_TIMEOUT_MS || 15000);
const MAX_BYTES = Number(process.env.WX_IMG_MAX_BYTES || 30 * 1024 * 1024);
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// 只允许微信图片 CDN 域（qpic.cn / qlogo.cn）。杜绝任意外链被当代理（SSRF）。
function isAllowedWeChatImageHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return /(?:^|\.)qpic\.cn$/.test(h) || /(?:^|\.)qlogo\.cn$/.test(h);
}

function parseTarget(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isAllowedWeChatImageHost(u.hostname)) return null;
  return u;
}

router.get('/', async (req, res) => {
  const target = parseTarget(req.query.url);
  if (!req.query.url) return res.status(400).json({ error: 'MISSING_URL' });
  if (!target) return res.status(403).json({ error: 'HOST_NOT_ALLOWED' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // 关键：服务端 fetch 不带 Referer（避免防盗链降级），仅给常规 UA/Accept。
    const upstream = await fetch(target.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'image/avif,image/webp,image/png,image/*,*/*' },
    });
    if (!upstream.ok) {
      clearTimeout(timer);
      return res.status(502).json({ error: `UPSTREAM_${upstream.status}` });
    }
    const ct = String(upstream.headers.get('content-type') || '').toLowerCase() || 'image/png';
    if (!/^image\//.test(ct)) {
      clearTimeout(timer);
      return res.status(415).json({ error: 'NOT_IMAGE', contentType: ct });
    }
    const declaredLen = Number(upstream.headers.get('content-length') || 0);
    if (declaredLen && declaredLen > MAX_BYTES) {
      clearTimeout(timer);
      return res.status(413).json({ error: 'TOO_LARGE' });
    }
    const buf = Buffer.from(await upstream.arrayBuffer());
    clearTimeout(timer);
    if (buf.length > MAX_BYTES) return res.status(413).json({ error: 'TOO_LARGE' });

    res.setHeader('Content-Type', ct);
    res.setHeader('Content-Length', String(buf.length));
    res.setHeader('Cache-Control', CACHE_CONTROL);
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.end(buf);
  } catch (err) {
    clearTimeout(timer);
    const aborted = err && (err.name === 'AbortError');
    return res.status(aborted ? 504 : 502).json({ error: aborted ? 'TIMEOUT' : 'FETCH_FAILED' });
  }
});

module.exports = router;
