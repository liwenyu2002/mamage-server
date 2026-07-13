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
// SVG 子树扩展白名单：秀米/135 大量用 <svg viewbox="0 0 W H"> 做纵横比占位/分隔线——svg 无宽高
// 属性时默认 300×150，viewbox 一旦被剥离，1px 分隔线会撑成 150px 高，flex 标题行整个散架
// （"✦快车道✦大字底纹"式表头就是这样被洗坏的）。其余是内联矢量装饰的常见绘图属性，
// 全部为纯呈现属性，无脚本/外联能力；只在 svg 子树内生效，不放宽 HTML 元素。
const SVG_ATTR_WHITELIST = new Set([
  'viewbox', 'preserveaspectratio', 'xmlns', 'xmlns:xlink', 'd', 'fill', 'stroke',
  'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'points',
  'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'transform',
  'opacity', 'fill-rule', 'clip-rule', 'fill-opacity', 'stroke-opacity',
  'width', 'height', 'pointer-events',
  // SMIL 声明式动画（<animate>/<set>/<animateTransform>）——135「多区域点击显示图片」等
  // 交互插件靠 begin="click" 触发，纯 CSS/SVG 无脚本即可在浏览器/微信里点击互动。缺了这些
  // 时序属性，动画元素虽在但没触发器，交互全失效（图能显示但点不动）。均为声明式呈现属性，无脚本能力。
  'begin', 'end', 'dur', 'min', 'max', 'restart', 'repeatcount', 'repeatdur',
  'values', 'keytimes', 'keysplines', 'calcmode', 'attributename', 'attributetype',
  'to', 'from', 'by', 'additive', 'accumulate', 'href', 'xlink:href',
]);

function isInSvgSubtree(node) {
  let cur = node;
  while (cur) {
    if (String(cur.tagName || cur.name || '').toLowerCase() === 'svg') return true;
    cur = cur.parent;
  }
  return false;
}
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
// 圆形头像等"背景图裁切控件"识别：祖先节点带 background-image:url(...)。
// 这类控件真正显示的是祖先的背景图（自带正确的裁切位置 background-position / 缩放 background-size），
// 里面的 <img> 在微信里是 opacity:0 的占位符。识别后要保持 img 不可见、让背景图原样呈现。
function hasBgImageAncestor(el) {
  let p = el.parent;
  let depth = 0;
  while (p && depth < 6) {
    const st = (p.attribs && p.attribs.style) || '';
    if (/background-image\s*:\s*url\(/i.test(st)) return true;
    p = p.parent;
    depth += 1;
  }
  return false;
}

// <img> 自身是否被刻意隐藏（opacity:0 / visibility:hidden）——背景裁切占位符的判定信号。
function isSelfHiddenImg(el) {
  const st = (el.attribs && el.attribs.style) || '';
  if (/(?:^|;)\s*opacity\s*:\s*0(?:\.0+)?\s*(?:;|$)/i.test(st)) return true;
  if (/(?:^|;)\s*visibility\s*:\s*hidden\s*(?:;|$)/i.test(st)) return true;
  return false;
}

// 真正的"背景图裁切占位 <img>"：必须自身 opacity:0/visibility:hidden（微信里刻意隐形），
// 且存在 background-image 框架祖先。二者缺一不可——只凭"祖先有背景图"会误伤真实前景图：
// 很多正文图碰巧嵌在带装饰背景的 section 里（甚至 6 层之外），那类图自身可见，
// 必须正常提升 data-src，否则会被当占位符跳过、整张图凭空丢失。
function isBgCropPlaceholderImg(el) {
  return isSelfHiddenImg(el) && hasBgImageAncestor(el);
}

function normalizeImages($, $root) {
  $root.find('img').each((_, img) => {
    const $img = $(img);
    // 背景裁切控件里的占位 <img>：不提升 data-src（不加载）、不加 object-fit，保持隐藏，
    // 由 cleanHiddenStyles 特判保留其 opacity:0——最终显示的是祖先 background-image（裁切位置/缩放与原文一致）。
    if (isBgCropPlaceholderImg(img)) return;
    const dataSrc = $img.attr('data-src');
    const src = $img.attr('src');
    if (dataSrc) {
      $img.attr('src', dataSrc);
    } else if (!src) {
      $img.remove();
      return;
    }
    // 填充容器型图片（style 里 height 非 auto，且非背景裁切控件）默认 object-fit:fill 会拉伸变形。
    // 补 object-fit:cover 改为等比裁切填充保比例；普通 height:auto 全宽图不动（object-fit 对其无操作）。
    const style = $img.attr('style') || '';
    const hm = style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i);
    const hasFixedHeight = hm && !/^\s*auto\s*$/i.test(hm[1]);
    if (hasFixedHeight && !/object-fit\s*:/i.test(style)) {
      $img.attr('style', `${style.replace(/;\s*$/, '')};object-fit:cover`);
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
    // 背景裁切控件里的占位 <img> 是刻意 opacity:0 的，保留其隐藏样式——可见内容是祖先的背景图，
    // 若在此把 opacity:0 去掉，占位图会显形并盖住正确裁切的背景（正是"裁切位置不对"的成因）。
    if ((el.tagName || el.name) === 'img' && isBgCropPlaceholderImg(el)) return;
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
    const svgScope = isInSvgSubtree(node);
    Object.keys(node.attribs).forEach((name) => {
      const key = name.toLowerCase();
      if (ATTR_WHITELIST.has(key)) return;
      if (svgScope && SVG_ATTR_WHITELIST.has(key)) return;
      delete node.attribs[name];
    });
  });
}

// 必须在属性白名单剥离之后再加，否则 referrerpolicy 自己也会被当作非白名单属性删掉。
function addReferrerPolicy($, $root) {
  $root.find('img').each((_, img) => {
    $(img).attr('referrerpolicy', 'no-referrer');
  });
}

// 微信图片 CDN 域判定（与 routes/wx_image_proxy.js 的白名单保持一致）。
function isWeChatImageHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return /(?:^|\.)qpic\.cn$/.test(h) || /(?:^|\.)qlogo\.cn$/.test(h);
}

// 把微信图片 URL 改写为同源外链代理；非微信 CDN / 相对路径 / 已代理 一律原样返回。
function proxifyWeChatImageUrl(rawUrl) {
  const raw = String(rawUrl || '').trim();
  if (!raw || /^\/api\/wx-img\b/.test(raw)) return raw;
  let u;
  try { u = new URL(raw); } catch { return raw; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return raw;
  if (!isWeChatImageHost(u.hostname)) return raw;
  return `/api/wx-img?url=${encodeURIComponent(u.href)}`;
}

// CSS background-image 带不了 referrerpolicy，浏览器会带 Referer 请求 → 命中 mmbiz 防盗链、
// 被换成 “未经允许不得转载” 水印占位图。把 background-image 里的微信图片 URL 改写为同源代理
// （服务端无 Referer 取真图、同源回流），海报型推文（大量背景图铺版）才能真正复现。
// <img> 走 referrerpolicy=no-referrer 已能拿真图，这里不动，避免给普通推文的图片加代理压力。
function proxifyBackgroundImages($, $root) {
  $root.find('[style]').addBack('[style]').each((_, el) => {
    const $el = $(el);
    const st = $el.attr('style') || '';
    if (!/background-image\s*:/i.test(st) || !/url\(/i.test(st)) return;
    const next = st.replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q, url) => {
      const p = proxifyWeChatImageUrl(url);
      return p === url ? m : `url(${q}${p}${q})`;
    });
    if (next !== st) $el.attr('style', next);
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
  proxifyBackgroundImages($, $clone);
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

// 解析 inline style 的垂直外边距（px 数值，解析不出按 0）。秀米/135 的"大字底纹压标题"层叠
// 全靠负外边距实现（如 margin: 10px 0px -28px 让下一节上移 28px 盖住本节），cheerio 无 CSSOM，
// 需手动展开 margin 简写（1/2/3/4 值形位：全部 / 上下+左右 / 上+左右+下 / 上右下左）。
function getVerticalMargins(styleValue) {
  const st = String(styleValue || '').toLowerCase();
  const out = { top: 0, bottom: 0 };
  const px = (v) => {
    const m = String(v || '').trim().match(/^(-?\d+(?:\.\d+)?)px$/);
    return m ? parseFloat(m[1]) : 0;
  };
  const shorthand = st.match(/(?:^|;)\s*margin\s*:\s*([^;]+)/);
  if (shorthand) {
    const parts = shorthand[1].trim().split(/\s+/);
    if (parts.length === 1) { out.top = px(parts[0]); out.bottom = px(parts[0]); }
    else if (parts.length === 2) { out.top = px(parts[0]); out.bottom = px(parts[0]); }
    else if (parts.length === 3) { out.top = px(parts[0]); out.bottom = px(parts[2]); }
    else if (parts.length >= 4) { out.top = px(parts[0]); out.bottom = px(parts[2]); }
  }
  const mt = st.match(/(?:^|;)\s*margin-top\s*:\s*([^;]+)/);
  if (mt) out.top = px(mt[1]);
  const mb = st.match(/(?:^|;)\s*margin-bottom\s*:\s*([^;]+)/);
  if (mb) out.bottom = px(mb[1]);
  return out;
}

// 把顶层节点序列按"负边距层叠关系"归并成组：节点带负底边距 → 与后一个节点同组（下一节会
// 上移盖住它），节点带负顶边距 → 与前一个节点同组。层叠装饰（大字底纹+标题）是一个视觉单元，
// 拆进不同块会断掉覆盖关系（画布逐块渲染,块间层叠不成立），必须整组进同一个 raw 块。
function groupOverlappingNodes(blockNodes, $) {
  const groups = [];
  let prevHadNegBottom = false;
  blockNodes.forEach((n) => {
    const { top, bottom } = getVerticalMargins($(n).attr('style'));
    if (groups.length && (top < 0 || prevHadNegBottom)) {
      groups[groups.length - 1].push(n);
    } else {
      groups.push([n]);
    }
    prevHadNegBottom = bottom < 0;
  });
  return groups;
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
  // 负边距层叠组（大字底纹压标题等）归并后再计块：一组=一个 raw 块，保住覆盖关系
  const nodeGroups = groupOverlappingNodes(blockNodes, $);

  let blocks;
  if (nodeGroups.length <= MAX_BLOCKS) {
    blocks = nodeGroups.map((g) => g.map((n) => $.html(n)).join(''));
  } else {
    // 超出上限不静默丢弃：剩余节点原样合并序列化成最后一块，内容仍完整保留。
    const head = nodeGroups.slice(0, MAX_BLOCKS);
    const tail = nodeGroups.slice(MAX_BLOCKS);
    blocks = head.map((g) => g.map((n) => $.html(n)).join(''));
    blocks.push(tail.map((g) => g.map((n) => $.html(n)).join('')).join(''));
  }

  const totalBytes = Buffer.byteLength(blocks.join(''), 'utf8');
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new Error('文章过大，无法导入');
  }

  return { title, author, blocks, imageCount, blockCount: blocks.length };
}

module.exports = { extractFullArticleFromHtml };
