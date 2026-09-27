const { createHash } = require('crypto');
const cheerio = require('cheerio');
const OpenAI = require('openai');
const { pool } = require('../db');
const { parsePublicHttpsUrl, openPublicHttps, readLimitedText } = require('./public_remote_fetch');

const MAX_PHOTOS = 500;
const SAFE_SELECTOR = /^[\w.#\[\]="' >_-]{1,160}$/;
const IMAGE_ATTRS = new Set(['src', 'data-src', 'data-original', 'data-url', 'data-lazy-src', 'data-image']);

function routeKey(url) {
  return url.pathname.replace(/\b\d{4,}\b/g, ':id').replace(/[a-f0-9]{16,}/gi, ':id').slice(0, 255) || '/';
}

function safeSelector(value, fallback = '') {
  const selector = String(value || '').trim();
  return SAFE_SELECTOR.test(selector) && !selector.includes('[') ? selector : fallback;
}

function validateRules(value) {
  if (!value || typeof value !== 'object') return null;
  const itemSelector = safeSelector(value.itemSelector);
  const sourceMode = ['ancestor_link', 'anchor_link', 'link'].includes(value.sourceMode) ? 'ancestor_link' : 'img_attribute';
  const sourceAttr = IMAGE_ATTRS.has(value.sourceAttr) ? value.sourceAttr : 'src';
  const previewAttr = IMAGE_ATTRS.has(value.previewAttr) ? value.previewAttr : 'src';
  if (!itemSelector || !/(^|[ >])img(?:[.#][\w-]+)*$/.test(itemSelector)) return null;
  return {
    itemSelector,
    sourceMode,
    sourceAttr,
    previewAttr,
    captionSelector: safeSelector(value.captionSelector),
    albumTitleSelector: safeSelector(value.albumTitleSelector, 'h1'),
    sectionSelector: safeSelector(value.sectionSelector),
    sectionTitleSelector: safeSelector(value.sectionTitleSelector),
  };
}

function structuralSummary($) {
  const classNames = (value) => String(value || '').split(/\s+/)
    .filter((token) => /^[a-zA-Z][\w-]{0,40}$/.test(token))
    .slice(0, 6).join(' ');
  const assetHint = (value) => {
    const raw = String(value || '');
    if (!raw) return 'empty';
    if (raw.startsWith('data:')) return 'data-uri';
    const pathname = raw.split('?')[0].toLowerCase();
    const extension = pathname.match(/\.(jpe?g|png|webp|avif|gif)$/)?.[1];
    return extension ? `url-${extension}` : 'url-unknown';
  };
  return $('img').slice(0, 32).map((_index, node) => {
    const el = $(node);
    const parent = el.parent();
    const ancestorLink = el.closest('a[href]');
    return {
      tag: 'img',
      class: classNames(el.attr('class')),
      attrs: Object.keys(node.attribs || {}).filter((key) => !key.startsWith('on')).slice(0, 16),
      imageAttrHints: Object.fromEntries([...IMAGE_ATTRS].filter((key) => el.attr(key) !== undefined).map((key) => [key, assetHint(el.attr(key))])),
      parentTag: parent[0]?.tagName || '',
      parentClass: classNames(parent.attr('class')),
      ancestorLink: Boolean(ancestorLink.length),
      ancestorLinkHint: assetHint(ancestorLink.attr('href')),
      ancestorClass: classNames(ancestorLink.attr('class')),
    };
  }).get();
}

function cleanText(value, max = 180) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function resolveAsset(raw, pageUrl) {
  if (!raw) return null;
  try {
    const url = new URL(String(raw), pageUrl);
    return parsePublicHttpsUrl(url.href) ? url.href : null;
  } catch (_) { return null; }
}

function applyTemplate(html, pageUrl, rules) {
  const $ = cheerio.load(html);
  const title = cleanText($(rules.albumTitleSelector).first().text() || $('title').first().text(), 255);
  const allNodes = $(rules.itemSelector);
  const nodes = allNodes.slice(0, MAX_PHOTOS);
  const photos = new Map();
  nodes.each((_index, node) => {
    const element = $(node);
    const sourceRaw = rules.sourceMode === 'ancestor_link'
      ? element.closest('a[href]').attr('href')
      : element.attr(rules.sourceAttr);
    const source = resolveAsset(sourceRaw, pageUrl);
    const preview = resolveAsset(element.attr(rules.previewAttr), pageUrl) || source;
    if (!source || !preview) return;
    let filename = cleanText(element.attr('alt') || element.attr('data-filename'));
    if (!filename && rules.captionSelector) filename = cleanText(element.parent().find(rules.captionSelector).first().text());
    if (!filename) {
      const basename = new URL(source).pathname.split('/').pop() || 'photo';
      try { filename = decodeURIComponent(basename); } catch (_) { filename = basename; }
    }
    filename = filename.replace(/[\\/\r\n]/g, '_').slice(0, 180);
    let sectionName = '';
    if (rules.sectionSelector) {
      const section = element.closest(rules.sectionSelector);
      sectionName = cleanText((rules.sectionTitleSelector && section.find(rules.sectionTitleSelector).first().text()) || section.attr('data-section'), 80);
    }
    const stableKey = `${new URL(source).hostname}${new URL(source).pathname}`;
    const id = createHash('sha256').update(stableKey).digest('hex').slice(0, 32);
    photos.set(id, { id, filename, previewUrl: preview, transferUrl: source, sectionName: sectionName || null, width: null, height: null, watermarked: null });
  });
  return { title: title || new URL(pageUrl).hostname, photos: [...photos.values()], matchedCount: nodes.length, totalMatched: allNodes.length };
}

function parseModelJson(value) {
  const raw = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try { return JSON.parse(raw); } catch (_) { return null; }
}

async function proposeTemplate(summary) {
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) throw Object.assign(new Error('AI 解析尚未配置'), { status: 503 });
  const baseURL = process.env.AI_TEXT_BASE_URL || process.env.DASHSCOPE_BASE_URL || undefined;
  const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}), timeout: 20000, maxRetries: 0 });
  let response;
  try {
    response = await client.chat.completions.create({
      model: process.env.EXTERNAL_IMPORT_AI_MODEL || process.env.AI_SEARCH_MODEL || process.env.AI_TEXT_MODEL || 'deepseek-chat',
      temperature: 0,
      max_tokens: 500,
      messages: [
        { role: 'system', content: [
          '你是网页相册结构解析器，只输出 JSON。输入仅包含去敏的标签、class 和属性名，没有网址或用户内容。',
          '输出字段: itemSelector, sourceMode, sourceAttr, previewAttr, captionSelector, albumTitleSelector, sectionSelector, sectionTitleSelector。',
          'itemSelector 必须选择 img 元素；sourceMode 只能是 ancestor_link 或 img_attribute。',
          '如果 ancestorLink 为 true 且 ancestorLinkHint 表示图片 URL，优先使用 ancestor_link 取得大图。',
          'sourceAttr/previewAttr 只能为 src、data-src、data-original、data-url、data-lazy-src、data-image。',
          '其他 selector 只使用简单 CSS 标签/class/id；不确定填空字符串。不要输出代码或解释。',
        ].join('\n') },
        { role: 'user', content: JSON.stringify(summary).slice(0, 6500) },
      ],
    });
  } catch (err) {
    console.warn('[external-import] AI template request failed:', err?.status || err?.code || err?.name);
    throw Object.assign(new Error('AI 解析暂不可用，请稍后再试'), { status: 503 });
  }
  const rules = validateRules(parseModelJson(response.choices?.[0]?.message?.content));
  if (!rules) throw Object.assign(new Error('AI 未生成有效的解析规则'), { status: 422 });
  return rules;
}

async function validateCandidates(result) {
  if (result.photos.length < 2 || result.matchedCount < 2 || result.photos.length / result.matchedCount < 0.6) return false;
  for (const photo of result.photos.slice(0, 2)) {
    try {
      let { response } = await openPublicHttps(photo.transferUrl, { method: 'HEAD', timeoutMs: 8000 });
      if (response.statusCode === 403 || response.statusCode === 405) {
        response.resume();
        ({ response } = await openPublicHttps(photo.transferUrl, { method: 'GET', timeoutMs: 8000 }));
      }
      const type = String(response.headers['content-type'] || '').toLowerCase();
      response.destroy();
      if (response.statusCode !== 200 || !['image/jpeg', 'image/png', 'image/webp'].some((mime) => type.startsWith(mime))) return false;
    } catch (_) { return false; }
  }
  return true;
}

async function scanFromTemplate(rawUrl) {
  const input = parsePublicHttpsUrl(rawUrl);
  if (!input) throw Object.assign(new Error('仅支持公开的 HTTPS 相册链接'), { status: 400 });
  const { response, url } = await openPublicHttps(input.href, { accept: 'text/html', timeoutMs: 20000 });
  if (response.statusCode !== 200 || !String(response.headers['content-type'] || '').includes('text/html')) {
    response.resume();
    throw Object.assign(new Error('网页无法直接读取，请确认链接可公开访问'), { status: 400 });
  }
  const html = await readLimitedText(response);
  const pageUrl = new URL(url);
  const $ = cheerio.load(html);
  const summary = structuralSummary($);
  if (summary.length < 2) throw Object.assign(new Error('这个网页的照片由动态接口加载，暂时需要专门适配'), { status: 422 });
  const fingerprint = createHash('sha256').update(JSON.stringify(summary)).digest('hex');
  const key = routeKey(pageUrl);
  const [cached] = await pool.query('SELECT id, rules_json AS rules FROM external_import_templates WHERE hostname = ? AND route_key = ? LIMIT 1', [pageUrl.hostname, key]);
  if (cached.length) {
    let saved;
    try { saved = typeof cached[0].rules === 'string' ? JSON.parse(cached[0].rules) : cached[0].rules; } catch (_) { saved = null; }
    const rules = validateRules(saved);
    if (rules) {
      const result = applyTemplate(html, url, rules);
      if (await validateCandidates(result)) {
        await pool.query('UPDATE external_import_templates SET hit_count = hit_count + 1, fingerprint = ? WHERE id = ?', [fingerprint, cached[0].id]);
        return buildResult(pageUrl, result, 'cache');
      }
    }
  }
  const rules = await proposeTemplate(summary);
  const result = applyTemplate(html, url, rules);
  if (!await validateCandidates(result)) throw Object.assign(new Error('AI 提取的照片地址未通过验证，没有保存模板'), { status: 422 });
  await pool.query(
    `INSERT INTO external_import_templates (hostname, route_key, fingerprint, rules_json)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE fingerprint = VALUES(fingerprint), rules_json = VALUES(rules_json), updated_at = NOW()`,
    [pageUrl.hostname, key, fingerprint, JSON.stringify(rules)]
  );
  return buildResult(pageUrl, result, 'ai');
}

function buildResult(pageUrl, result, templateSource) {
  return {
    provider: 'generic',
    sourceUrl: `${pageUrl.origin}${pageUrl.pathname}`,
    title: result.title,
    suggestedAlbumTitle: result.title,
    suggestedSections: [...new Set(result.photos.map((photo) => photo.sectionName).filter(Boolean))],
    reportedTotal: result.totalMatched,
    scannedCount: result.photos.length,
    complete: result.photos.length >= result.totalMatched && result.totalMatched <= MAX_PHOTOS,
    quality: 'source_link_unverified',
    templateSource,
    photos: result.photos,
  };
}

module.exports = { routeKey, validateRules, structuralSummary, applyTemplate, proposeTemplate, scanFromTemplate };
