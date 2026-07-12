// lib/wechat_article_import.js
// 纯函数解析器：把公众号文章整篇内容+排版原样保留地解析成内容块序列（HTML 字符串数组），
// 供前端画布"整文复现"导入。与 lib/wechat_style_extract.js（剥文字留模板）是姊妹但相反的目标：
// 这里要保留内联样式与真实图片，不做任何启发式分类、不占位替换。
// 不做任何网络请求、不落库 —— 便于 scripts/test_article_import.js 用固定样本直接调用断言。
// 约束：
// - 只信任 #js_content 容器；容器不存在直接 throw，调用方（路由）据此判断"不是有效的公众号文章页"。
// - 属性白名单只保留排版必需的 style/src/href/alt/title/width/height/colspan/rowspan，
//   其余（id/class/data-*/on* 等）一律剥离，防止携带追踪标记或事件脚本。
// - 图片一律转为真实 src（懒加载 data-src 优先）并加 referrerpolicy="no-referrer"，
//   因为 mmbiz 图片有 Referer 防盗链，不加这个前端 <img> 直接显示会 403。
// - 微信编辑器常见的“隐形”样式（visibility:hidden / opacity:0）会让内容在预览里凭空消失，
//   只删这两条声明，其余样式原样保留以还原排版。

const cheerio = require('cheerio');

const MAX_BLOCKS = 200;
const MAX_DRILL_DEPTH = 6;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

const ATTR_WHITELIST = new Set(['style', 'src', 'href', 'alt', 'title', 'width', 'height', 'colspan', 'rowspan']);
const REMOVE_TAGS_SELECTOR = 'script, style, link, meta, iframe, form, input, button, video, audio, object, embed';

// HTML 注释在 cheerio/domhandler 里是普通 contents()，不会被 find('*') 选中，需单独遍历每个
// 元素（含容器自身）的直接子内容逐个判定 type === 'comment' 后 remove()。
function stripComments($, $root) {
  $root.find('*').addBack().each((_, el) => {
    $(el).contents().each((_, c) => {
      if (c.type === 'comment') $(c).remove();
    });
  });
}

// 顺序早于属性白名单：data-src 属于会被白名单删除的属性，必须先读出来覆盖 src。
// 原本无 src 也无 data-src 的 img（多为占位/广告位失败态）直接丢弃，不留下无效 <img>。
function normalizeImages($, $root) {
  $root.find('img').each((_, img) => {
    const $img = $(img);
    const dataSrc = $img.attr('data-src');
    const src = $img.attr('src');
    if (dataSrc) {
      $img.attr('src', dataSrc);
    } else if (!src) {
      $img.remove();
    }
  });
}

// href 只信任 http/https；javascript:/weixin:// 等伪协议或空 href 直接剥掉属性本身
// （保留 <a> 标签结构，只是它不再是可点击链接）。
function sanitizeLinks($, $root) {
  $root.find('a').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href');
    if (!href || !/^https?:\/\//i.test(href.trim())) {
      $a.removeAttr('href');
    }
  });
}

// 只摘除 visibility:hidden 与 opacity:0 这两条声明，同 style 里的其它排版声明原样保留。
function stripHiddenDeclarations(styleValue) {
  const decls = String(styleValue || '').split(';').map((s) => s.trim()).filter(Boolean);
  const kept = decls.filter((decl) => {
    const idx = decl.indexOf(':');
    if (idx === -1) return true;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim().toLowerCase();
    if (prop === 'visibility' && val === 'hidden') return false;
    if (prop === 'opacity' && /^0(\.0+)?$/.test(val)) return false;
    return true;
  });
  return kept.join('; ');
}

function cleanHiddenStyles($, $root) {
  $root.find('[style]').addBack('[style]').each((_, el) => {
    const $el = $(el);
    const cleaned = stripHiddenDeclarations($el.attr('style'));
    if (cleaned) {
      $el.attr('style', cleaned);
    } else {
      $el.removeAttr('style');
    }
  });
}

// 与 wechat_style_extract.js 的 stripAttrs 同思路，但白名单更宽（要保留排版必需的
// src/href/width/height/colspan/rowspan，不止 style）。
function stripAttrsToWhitelist($, $root) {
  $root.find('*').addBack().each((_, node) => {
    if (!node.attribs) return;
    Object.keys(node.attribs).forEach((name) => {
      if (!ATTR_WHITELIST.has(name.toLowerCase())) delete node.attribs[name];
    });
  });
}

// 必须在属性白名单剥离之后再加，否则 referrerpolicy 自己也会被当作非白名单属性删掉。
function addReferrerPolicy($, $root) {
  $root.find('img').each((_, img) => {
    $(img).attr('referrerpolicy', 'no-referrer');
  });
}

function cleanContainer($, $container) {
  const $clone = $container.clone();
  stripComments($, $clone);
  $clone.find(REMOVE_TAGS_SELECTOR).remove();
  normalizeImages($, $clone);
  sanitizeLinks($, $clone);
  cleanHiddenStyles($, $clone);
  stripAttrsToWhitelist($, $clone);
  addReferrerPolicy($, $clone);
  return $clone;
}

// "有效"判定同时用于两处：(1) 巨型单容器下钻时判断当前层是否只有 1 个实体子元素；
// (2) 分块后丢弃纯空白块。两处口径必须一致，否则会出现"因为只看文本判定要下钻，
// 但下钻后又因为图片被当空块丢弃"的自相矛盾。
function isEffectiveNode($el, $) {
  const text = $el.text().replace(/[\s ]+/g, '');
  if (text.length > 0) return true;
  if ($el.is('img') || $el.find('img').length > 0) return true;
  let hasBackgroundImage = false;
  $el.find('*').addBack().each((_, n) => {
    if (hasBackgroundImage) return;
    if (/url\(/i.test($(n).attr('style') || '')) hasBackgroundImage = true;
  });
  return hasBackgroundImage;
}

// 单一包裹层若自带"视觉背景"（背景色/背景图/可见边框/阴影/圆角），一旦钻穿它就会把
// 整篇的底色/底图丢掉——秀米/135 常把全文放在一个米色底或带纹理背景的外层 section 里。
// 判定命中则停止下钻，把这一层原样保留为内容块，背景才能随排版一起复现。
// 判定一条 CSS 值是否"等效于无背景/无阴影"（秀米/135 导出常见的重置写法）
const EMPTY_VISUAL_RE = /^(transparent|none|inherit|initial|unset|0|0px|rgba\(0,\s*0,\s*0,\s*0\)|0\s+0\s+0(\s+0)?(px)?(\s+(transparent|rgba\(0,\s*0,\s*0,\s*0\)))?)$/;

function hasVisualWrapperStyle(styleValue) {
  const st = String(styleValue || '').toLowerCase();
  // ⚠️ 必须遍历 style 里"所有" background/-color/-image 声明,而不是只看第一条——
  // "background-color: transparent; background-image: url(bg.jpg)" 这种先重置再覆盖的写法很常见,
  // 只看第一条会命中 transparent 而漏判真实背景,把带背景的包裹层钻穿丢弃（正是本函数要防的 bug）。
  const bgDecls = st.match(/background(-color|-image)?\s*:\s*[^;]+/g) || [];
  const hasRealBackground = bgDecls.some((decl) => {
    const val = decl.replace(/^background(-color|-image)?\s*:\s*/, '').trim();
    return val && !EMPTY_VISUAL_RE.test(val);
  });
  if (hasRealBackground) return true;
  if (/border(-[a-z]+)?\s*:\s*[^;]*\b[1-9]\d*px/.test(st)) return true; // 可见边框
  // box-shadow 只在数值上确有阴影时才算（排除 0 0 0 transparent 这类全零重置）
  const shadow = st.match(/box-shadow\s*:\s*([^;]+)/);
  if (shadow && !EMPTY_VISUAL_RE.test(shadow[1].trim())) return true;
  if (/border-radius\s*:\s*[^;]*\b[1-9]/.test(st)) return true; // 圆角卡片
  return false;
}

// 秀米/135 排版常把全文包进单一巨型外层 section/div（参考 wechat_style_extract.js 同类注释），
// 只取顶层一次会颗粒无收；限深 6 层防止异常嵌套导致的无意义递归。
// 关键：遇到自带视觉背景的包裹层就停手（否则背景丢失）。
function drillToContentLevel($container, $) {
  let current = $container;
  for (let depth = 0; depth < MAX_DRILL_DEPTH; depth += 1) {
    const children = current.children().toArray();
    const effective = children.filter((n) => isEffectiveNode($(n), $));
    if (effective.length !== 1) break;
    const tag = ((effective[0].tagName) || '').toLowerCase();
    if (tag !== 'section' && tag !== 'div') break;
    if (hasVisualWrapperStyle($(effective[0]).attr('style'))) break; // 带背景/边框的容器保留,不钻穿
    current = $(effective[0]);
  }
  return current;
}

/**
 * extractFullArticleFromHtml(html) -> { title, author, blocks, imageCount, blockCount }
 * blocks: string[]，每个元素是一个顶层内容块的 outerHTML；不做网络请求。
 */
function extractFullArticleFromHtml(html) {
  if (!html || typeof html !== 'string') {
    throw new Error('不是有效的公众号文章页');
  }
  const $ = cheerio.load(html);
  const $container = $('#js_content').first();
  if (!$container.length) {
    throw new Error('不是有效的公众号文章页');
  }

  const title = ($container && $('#activity-name').first().text().trim())
    || ($('meta[property="og:title"]').attr('content') || '').trim();
  const author = ($('#js_name').first().text().trim())
    || ($('meta[name="author"]').attr('content') || '').trim();

  const $cleaned = cleanContainer($, $container);
  const imageCount = $cleaned.find('img').length;

  const $contentRoot = drillToContentLevel($cleaned, $);
  const blockNodes = $contentRoot.children().toArray().filter((n) => isEffectiveNode($(n), $));

  let blocks;
  if (blockNodes.length <= MAX_BLOCKS) {
    blocks = blockNodes.map((n) => $.html(n));
  } else {
    // 超出上限不静默丢弃：剩余节点原样合并序列化成最后一块，内容仍完整保留。
    const head = blockNodes.slice(0, MAX_BLOCKS);
    const tail = blockNodes.slice(MAX_BLOCKS);
    blocks = head.map((n) => $.html(n));
    blocks.push(tail.map((n) => $.html(n)).join(''));
  }

  const totalBytes = Buffer.byteLength(blocks.join(''), 'utf8');
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('文章过大，无法导入');
  }

  return { title, author, blocks, imageCount, blockCount: blocks.length };
}

module.exports = { extractFullArticleFromHtml };
