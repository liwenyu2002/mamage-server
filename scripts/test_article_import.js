// scripts/test_article_import.js
// "整文复现"解析器冒烟测试：不起 HTTP、不联网，用写死的公众号文章 HTML 样本直接调用
// lib/wechat_article_import.js 的纯函数，断言：
// 1) data-src 覆盖 src；无 src 无 data-src 的 img 被删除；保留下来的 img 加 referrerpolicy
// 2) 单一巨型容器（section 套 section）被下钻穿透，不会颗粒无收
// 3) script/iframe/id/class/data-*/on* 被剥离，a 标签伪协议 href 被剥掉但标签本身保留
// 4) visibility:hidden / opacity:0 声明被删除，同一 style 里的其它声明原样保留
// 5) 纯空白块（无文本/无 img/无背景图）被丢弃，不进入 blocks
// 6) 找不到 #js_content 时 throw
// 7) 块数超过 200 时，第 201 块合并剩余节点，不静默丢弃内容
//
// 用法：node scripts/test_article_import.js

const assert = require('assert');
const { extractFullArticleFromHtml } = require('../lib/wechat_article_import');

const SAMPLE_HTML = `
<html>
<head>
  <meta property="og:title" content="Meta标题Fallback" />
  <meta name="author" content="Meta作者Fallback" />
</head>
<body>
<div id="activity-name"> 真实标题 </div>
<div id="js_name"> 真实作者 </div>
<div id="js_content">
  <section id="outer-wrap" class="rich_media_content" data-tool="mp">
    <section>
      <p id="p1" class="text" data-foo="bar" onclick="alert(1)" style="font-size:16px; color:#333; visibility:hidden;">这是第一段正文，测试隐藏声明会被剥离但字体颜色保留。</p>
      <script>alert('xss')</script>
      <iframe src="https://evil.example.com"></iframe>
      <p style="opacity: 0; color:red;">这段全透明，测试透明度声明会被剥离但颜色声明保留。</p>
      <section style="text-align:center;">
        <img class="rich_pages" data-src="https://mmbiz.qpic.cn/real1.jpg" src="data:image/gif;base64,AA==" style="width:100%;" />
      </section>
      <img alt="broken" />
      <a href="https://example.com/good" onmouseover="steal()">好链接</a>
      <a href="javascript:alert(1)">坏链接</a>
      <section style="  "> </section>
      <section><!-- 只有注释，清洗后应为纯空白块 --></section>
    </section>
  </section>
</div>
</body></html>
`;

const NO_CONTAINER_HTML = '<html><body><div id="not-js-content">没有正确容器</div></body></html>';

function buildManyBlocksHtml(n) {
  const items = [];
  for (let i = 1; i <= n; i += 1) {
    items.push(`<p id="p${i}">content-${i}</p>`);
  }
  return `<html><body><div id="js_content">${items.join('\n')}</div></body></html>`;
}

function testMainFixture() {
  const result = extractFullArticleFromHtml(SAMPLE_HTML);
  const { title, author, blocks, imageCount, blockCount } = result;

  assert.strictEqual(title, '真实标题', `title 应优先取 #activity-name，实际 ${title}`);
  assert.strictEqual(author, '真实作者', `author 应优先取 #js_name，实际 ${author}`);
  assert.strictEqual(blockCount, blocks.length, 'blockCount 应与 blocks.length 一致');

  // 单容器下钻两层（js_content -> outer-wrap -> inner section）后应拿到 5 个有效块：
  // p1 / opacity 段 / 图片 section / 好链接 / 坏链接；两个纯空白 section 应被丢弃。
  assert.strictEqual(blocks.length, 5, `期望下钻后得到 5 个有效块，实际 ${blocks.length}`);

  const joined = blocks.join('\n');

  // id/class/data-*/on* 全部剥离，script/iframe 整体消失
  assert.ok(!/id="/.test(joined), 'blocks 不应残留 id 属性');
  assert.ok(!/class="/.test(joined), 'blocks 不应残留 class 属性');
  assert.ok(!/data-[a-z-]+="/.test(joined), 'blocks 不应残留 data-* 属性');
  assert.ok(!/\son[a-z]+\s*=/i.test(joined), 'blocks 不应残留 on* 事件属性');
  assert.ok(!/<script/i.test(joined), 'blocks 不应残留 <script>');
  assert.ok(!/<iframe/i.test(joined), 'blocks 不应残留 <iframe>');
  assert.ok(!joined.includes('evil.example.com'), 'iframe 内容应被整体删除');
  assert.ok(!joined.includes("alert('xss')"), 'script 内容应被整体删除');

  // visibility:hidden / opacity:0 被删，其它声明保留
  const p1Block = blocks.find((b) => b.includes('这是第一段正文'));
  assert.ok(p1Block, '应找到 p1 对应的块');
  assert.ok(!/visibility\s*:\s*hidden/i.test(p1Block), 'visibility:hidden 声明应被剥离');
  assert.ok(/color\s*:\s*#333/i.test(p1Block), 'font-size 之外的其它声明（color）应原样保留');
  assert.ok(/font-size\s*:\s*16px/i.test(p1Block), 'font-size 声明应原样保留');

  const opacityBlock = blocks.find((b) => b.includes('这段全透明'));
  assert.ok(opacityBlock, '应找到 opacity 段对应的块');
  assert.ok(!/opacity\s*:\s*0\b/i.test(opacityBlock), 'opacity:0 声明应被剥离');
  assert.ok(/color\s*:\s*red/i.test(opacityBlock), 'opacity:0 之外的 color 声明应原样保留');

  // 图片：data-src 覆盖 src，referrerpolicy 添加；无 src 无 data-src 的 img 被整体删除
  const imgBlock = blocks.find((b) => b.includes('<img'));
  assert.ok(imgBlock, '应找到含 img 的块');
  assert.ok(imgBlock.includes('src="https://mmbiz.qpic.cn/real1.jpg"'), 'data-src 应覆盖到 src');
  assert.ok(!imgBlock.includes('data-src'), 'data-src 属性本身不应残留（非白名单）');
  assert.ok(imgBlock.includes('referrerpolicy="no-referrer"'), '保留下来的 img 应加 referrerpolicy=no-referrer');
  assert.ok(!joined.includes('alt="broken"'), '无 src 无 data-src 的 img 应被整体删除');
  assert.strictEqual(imageCount, 1, `imageCount 应为 1（只有一张图存活），实际 ${imageCount}`);

  // a 标签：好链接保留 href，坏链接（伪协议）href 被剥掉但标签与文本保留
  const goodLinkBlock = blocks.find((b) => b.includes('好链接'));
  assert.ok(goodLinkBlock, '应找到好链接对应的块');
  assert.ok(goodLinkBlock.includes('href="https://example.com/good"'), '合法 http/https href 应保留');
  assert.ok(!/onmouseover/i.test(goodLinkBlock), 'a 标签的 on* 属性应剥离');

  const badLinkBlock = blocks.find((b) => b.includes('坏链接'));
  assert.ok(badLinkBlock, '应找到坏链接对应的块（标签本身保留，只剥 href）');
  assert.ok(!/href\s*=/.test(badLinkBlock), 'javascript: 伪协议 href 应被整体剥掉');

  console.log(`[test_article_import] fixture OK: blockCount=${blockCount} imageCount=${imageCount} title=${title} author=${author}`);
}

function testMetaFallback() {
  const html = SAMPLE_HTML
    .replace('<div id="activity-name"> 真实标题 </div>', '')
    .replace('<div id="js_name"> 真实作者 </div>', '');
  const { title, author } = extractFullArticleFromHtml(html);
  assert.strictEqual(title, 'Meta标题Fallback', `无 #activity-name 时应回退 og:title，实际 ${title}`);
  assert.strictEqual(author, 'Meta作者Fallback', `无 #js_name 时应回退 meta[name=author]，实际 ${author}`);
  console.log('[test_article_import] meta fallback OK');
}

function testNoContainerThrows() {
  assert.throws(
    () => extractFullArticleFromHtml(NO_CONTAINER_HTML),
    /不是有效的公众号文章页/,
    '找不到 #js_content 应 throw 约定错误信息'
  );
  console.log('[test_article_import] no-container throw OK');
}

function testOverMaxBlocksMerged() {
  const html = buildManyBlocksHtml(250);
  const { blocks, blockCount } = extractFullArticleFromHtml(html);
  assert.strictEqual(blockCount, 201, `250 个顶层块应压成 200+1=201 个，实际 ${blockCount}`);
  assert.strictEqual(blocks.length, 201, 'blocks.length 应与 blockCount 一致');

  // 前 200 块逐个对应 content-1..content-200
  assert.ok(blocks[0].includes('content-1<') || blocks[0].includes('content-1'), '第 1 块应含 content-1');
  assert.ok(blocks[199].includes('content-200'), '第 200 块应含 content-200');

  // 第 201 块是合并块，必须完整包含 content-201 到 content-250，不能静默丢弃
  const mergedBlock = blocks[200];
  for (let i = 201; i <= 250; i += 1) {
    assert.ok(mergedBlock.includes(`content-${i}`), `合并块应包含 content-${i}，不能丢内容`);
  }
  console.log(`[test_article_import] over-max-blocks merge OK: total=${blockCount}, merged block length=${mergedBlock.length}`);
}

function main() {
  testMainFixture();
  testMetaFallback();
  testNoContainerThrows();
  testOverMaxBlocksMerged();
  console.log('[test_article_import] ALL PASS');
}

main();
