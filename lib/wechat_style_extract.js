// lib/wechat_style_extract.js
// 纯函数解析器：把公众号文章 HTML 里的顶层排版结构启发式识别为样式块（h2/h3/quote/divider/imageCard）。
// 不做任何网络请求、不落库 —— 便于 scripts/test_style_extract.js 用固定样本直接调用断言。
// 约束（与契约第 1/4 节一致）：
// - 只信任 #js_content 容器内的顶层子元素；容器不存在直接 throw，调用方（路由）据此判断"不是有效的公众号文章页"。
// - 输出模板只保留 style 属性（id/class/data-* 一律剥离），img 的 src 一律替换为 {{src}} 占位。
// - 输出模板若含 position/flex/grid/transform 等公众号编辑器粘贴会丢失的样式，直接跳过该候选块，
//   因为这类模板一旦被我们复用为渲染模板，用户粘贴回公众号后布局必然损坏，属于契约"存活硬规则"的延伸校验。
// - 最多返回 30 块，模板 md5 相同的只保留第一个。

const cheerio = require('cheerio');
const crypto = require('crypto');

const MAX_BLOCKS = 30;
const TYPE_LABELS = { h2: '标题', h3: '小标题', quote: '引用', divider: '分隔线', imageCard: '图文', signoff: '落款' };

// 公众号存活硬规则里明确禁止的 CSS：position/flex 系/grid 系/transform。
// 用于否决"看起来是样式块但拿去当模板会在粘贴回公众号编辑器时布局损坏"的候选。
const FORBIDDEN_STYLE_RE = /(^|[;"\s])(position|display\s*:\s*(inline-)?flex|display\s*:\s*(inline-)?grid|flex(-[a-z]+)?|grid(-[a-z]+)?|transform(-[a-z]+)?|align-items|align-content|align-self|justify-content|justify-items|justify-self|place-items|place-content)\s*:/i;

function md5(text) {
  return crypto.createHash('md5').update(String(text || ''), 'utf8').digest('hex');
}

// 收集元素自身 + 所有后代的 style 属性值拼成一个字符串，供关键字启发式判定用。
function collectStyles($el, $) {
  const parts = [];
  const own = $el.attr('style');
  if (own) parts.push(own);
  $el.find('[style]').each((_, n) => {
    const s = $(n).attribs && $(n).attribs.style;
    if (s) parts.push(s);
  });
  return parts.join(';');
}

// 移除 id/class/data-* 等属性，只保留 style；img 的其它属性也一并剥掉（src 由调用方另行处理）。
function stripAttrs($root, $) {
  $root.find('*').addBack().each((_, node) => {
    if (!node.attribs) return;
    Object.keys(node.attribs).forEach((name) => {
      if (name.toLowerCase() === 'style') return;
      delete node.attribs[name];
    });
  });
}

// 把某个 cheerio 节点内"唯一贯穿到底"的文本折叠替换为占位符 token（{{content}} 或 {{caption}}）。
// 算法：从 root 往下找"其 .text() 与 root 全文完全相同"的唯一子元素，逐层下钻，直到找不到这样的
// 单一路径为止 —— 这样能穿过多层纯装饰包裹（<section><section>文字</section></section>），
// 同时天然跳过与文字同级但不含文字的装饰兄弟节点（如竖线/图标 section，其 text() 为空不会被选中）。
function collapseTextToPlaceholder($root, $, token) {
  const fullText = $root.text().trim();
  if (!fullText) return false;
  let cursor = $root;
  // 防御死循环：最多下钻 20 层
  for (let i = 0; i < 20; i += 1) {
    const children = cursor.children().toArray();
    const matches = children.filter((c) => $(c).text().trim() === fullText);
    if (matches.length !== 1) break;
    cursor = $(matches[0]);
  }
  cursor.empty();
  cursor.text(token);
  return true;
}

function isTemplateStyleSafe(htmlTemplate) {
  const re = /style\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(htmlTemplate))) {
    if (FORBIDDEN_STYLE_RE.test(`;${m[1]};`)) return false;
  }
  return true;
}

function classify($el, $) {
  if ($el.is('script') || $el.find('script').length) return null;

  const tag = (($el.get(0) && $el.get(0).tagName) || '').toLowerCase();
  const text = $el.text().trim();
  const imgs = $el.is('img') ? [$el.get(0)] : $el.find('img').toArray();
  const styles = collectStyles($el, $);

  // 含图：主图 + 可选短文本图注；元素内除主图外还有其它 <img>（多为 mmbiz 装饰/推广图）
  // 一律跳过整块 —— 无法安全剥离且存在防盗链 403 与版权风险。
  if (imgs.length >= 1) {
    if (imgs.length > 1) return { skip: true };
    return { type: 'imageCard' };
  }

  if (tag === 'blockquote' || (/border-left/i.test(styles) && /padding/i.test(styles))) {
    return { type: 'quote' };
  }

  if ((text.length === 0 || text.length < 3) && (tag === 'hr' || /border|background/i.test(styles))) {
    return { type: 'divider' };
  }

  if (text.length >= 3 && text.length <= 40) {
    const significant = /background|border/i.test(styles)
      || /text-align\s*:\s*center/i.test(styles)
      || $el.find('section,div,p').length >= 1;
    if (significant) {
      // "嵌套浅的为 h3"：完全没有内层包裹（纯文本直挂）判 h3，有额外包裹层（装饰更重）判 h2
      const nested = $el.find('section,div,p').length;
      return { type: nested >= 1 ? 'h2' : 'h3' };
    }
  }

  return null;
}

function buildContentBlock($el, $, type) {
  const $clone = $el.clone();
  stripAttrs($clone, $);
  collapseTextToPlaceholder($clone, $, '{{content}}');
  const html = $.html($clone);
  return { type, html };
}

function buildDividerBlock($el, $) {
  const $clone = $el.clone();
  stripAttrs($clone, $);
  // 分隔线无槽位，清空文本节点即可（若混入了空白文本）
  const html = $.html($clone);
  return { type: 'divider', html };
}

// 图文块：优先处理"图与短文图注在同一顶层元素内"的情况；若图注在下一个兄弟顶层元素里
// （公众号常见写法：一段放图，紧跟一段居中小字图注），由调用方传入 $nextEl 合并。
function buildImageCardBlock($el, $, $nextEl) {
  const $clone = $el.clone();
  stripAttrs($clone, $);
  const $img = $clone.is('img') ? $clone : $clone.find('img').first();
  if (!$img || $img.length === 0) return null;
  $img.attr('src', '{{src}}');

  // 同元素内图注（img 之外还有文本）
  const ownTextClone = $el.clone();
  ownTextClone.find('img').remove();
  const ownText = ownTextClone.text().trim();

  let consumedNext = false;
  if (ownText) {
    collapseTextToPlaceholder($clone, $, '{{caption}}');
  } else if ($nextEl) {
    const nextHasImg = $nextEl.is('img') || $nextEl.find('img').length > 0;
    const nextText = $nextEl.text().trim();
    if (!nextHasImg && nextText && nextText.length <= 40) {
      const $capClone = $nextEl.clone();
      stripAttrs($capClone, $);
      collapseTextToPlaceholder($capClone, $, '{{caption}}');
      const merged = `<section>${$.html($clone)}${$.html($capClone)}</section>`;
      return { type: 'imageCard', html: merged, consumedNext: true };
    }
  }

  const html = $.html($clone);
  return { type: 'imageCard', html, consumedNext };
}

/**
 * extractStyleBlocksFromHtml(html) -> { blocks, count }
 * blocks: [{ type, name, htmlTemplate, accentEditable:false, sourceUrl:null }]
 * 不做网络请求，sourceUrl 恒为 null，由路由层在拿到真实 URL 后回填。
 */
function extractStyleBlocksFromHtml(html) {
  if (!html || typeof html !== 'string') {
    throw new Error('不是有效的公众号文章页');
  }
  const $ = cheerio.load(html);
  const $container = $('#js_content').first();
  if (!$container.length) {
    throw new Error('不是有效的公众号文章页');
  }

  // 递归下钻收集候选：秀米/135 排版常把全文包进一个巨型外层 section
  // （实测有文章 js_content 只有 1 个有效顶层子元素、内含 415 个嵌套 section），
  // 只扫一层会颗粒无收。规则：classify 命中即收（命中不再下钻，避免祖先/后代重复入选）；
  // 未命中或多图 skip 的容器继续下钻找内部块；限深 8 层、候选 120 个封顶防巨型页。
  const MAX_DEPTH = 8;
  const MAX_CANDIDATES = 120;
  const candidates = [];
  const walk = ($el, depth) => {
    if (depth > MAX_DEPTH || candidates.length >= MAX_CANDIDATES) return;
    const verdict = classify($el, $);
    if (verdict && !verdict.skip) {
      candidates.push({ $el, verdict });
      return;
    }
    const tag = (($el.get(0) && $el.get(0).tagName) || '').toLowerCase();
    if (tag === 'section' || tag === 'div' || tag === 'p' || tag === 'blockquote') {
      $el.children().toArray().forEach((n) => walk($(n), depth + 1));
    }
  };
  $container.children().toArray().forEach((n) => walk($(n), 0));

  const raw = [];
  for (const { $el, verdict } of candidates) {
    let built = null;
    if (verdict.type === 'divider') {
      built = buildDividerBlock($el, $);
    } else if (verdict.type === 'imageCard') {
      // 图注合并按 DOM 相邻兄弟判断（递归后候选序列不再保证相邻语义）
      const $next = $el.next();
      built = buildImageCardBlock($el, $, $next && $next.length ? $next : null);
    } else {
      built = buildContentBlock($el, $, verdict.type);
    }
    if (!built || !built.html) continue;
    if (/<script/i.test(built.html) || /\son[a-z]+\s*=/i.test(built.html)) continue;
    if (!isTemplateStyleSafe(built.html)) continue;

    raw.push({ type: built.type, html: built.html });
  }

  // 去重：模板 md5 相同只留第一个
  const seen = new Set();
  const deduped = [];
  for (const b of raw) {
    const key = md5(b.html);
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(b);
    if (deduped.length >= MAX_BLOCKS) break;
  }

  const typeCounters = {};
  const blocks = deduped.map((b) => {
    typeCounters[b.type] = (typeCounters[b.type] || 0) + 1;
    const label = TYPE_LABELS[b.type] || b.type;
    return {
      type: b.type,
      name: `提取·${label} ${typeCounters[b.type]}`,
      htmlTemplate: b.html,
      accentEditable: false,
      sourceUrl: null,
    };
  });

  return { blocks, count: blocks.length };
}

module.exports = { extractStyleBlocksFromHtml };
