// scripts/test_style_extract.js
// 公众号样式块提取器冒烟测试：不起 HTTP、不联网，用写死的公众号文章 HTML 样本直接调用
// lib/wechat_style_extract.js 的纯函数，断言：
// 1) 识别出 >=4 块且类型分布正确（h2/h3/quote/divider/imageCard 都至少出现一次）
// 2) 文本类块 {{content}} 替换成功；图文块 {{src}}/{{caption}} 替换成功
// 3) 输出模板已剥离 id/class/data-*，只保留 style
//
// 用法：node scripts/test_style_extract.js

const assert = require('assert');
const { extractStyleBlocksFromHtml } = require('../lib/wechat_style_extract');

// 样本覆盖：黑竖条标题(h2,双层嵌套)、简约小标题(h3,单层)、左边框引用(quote)、
// 装饰分隔线(divider,hr)、同元素图注(imageCard)、图与图注分两段(imageCard, 兄弟合并)。
const SAMPLE_HTML = `
<html><body>
<div id="js_content">
  <section id="s1" class="rich_media_content" style="text-align:center;background:#f5f5f5;border-radius:4px;padding:12px 0;">
    <section class="inner" data-role="deco" style="font-size:18px;font-weight:bold;color:#c0392b;">公众号运营的五个关键动作</section>
  </section>
  <p>这是一段正文内容，用来验证纯正文段落不会被误判为样式块，长度需要超过阈值避免被当成标题候选。这里再补一些字数。</p>
  <section id="h3-1" style="font-size:16px;font-weight:600;border-left:0px;">小标题：数据复盘</section>
  <blockquote id="q1" class="wx-quote" style="border-left:3px solid #c0392b;padding:8px 12px;color:#666;">
    好的内容运营，本质上是长期主义与用户信任的复利。
  </blockquote>
  <hr id="hr1" class="deco-hr" style="border:none;border-top:1px dashed #ccc;margin:20px 0;" />
  <section id="img1" data-tool="mp" style="text-align:center;">
    <img class="rich_pages wxw-100" data-src="https://mmbiz.qpic.cn/mmbiz_jpg/fake/0" src="data:image/gif;base64,AA==" style="width:100%;border-radius:6px;" />
    <section class="cap" style="font-size:12px;color:#999;margin-top:6px;">图1：活动现场</section>
  </section>
  <p style="text-align:center;">
    <img class="rich_pages wxw-200" data-src="https://mmbiz.qpic.cn/mmbiz_jpg/fake/1" src="data:image/gif;base64,AA==" style="width:100%;" />
  </p>
  <p style="text-align:center;font-size:12px;color:#999;">图2：嘉宾合影</p>
  <section id="badflex" style="display:flex;align-items:center;background:#eee;">
    <section style="width:6px;height:16px;background:#c0392b;"></section>
    <section style="font-size:16px;">这个标题因为用了 flex 必须被过滤掉</section>
  </section>
</div>
</body></html>
`;

function main() {
  const { blocks, count } = extractStyleBlocksFromHtml(SAMPLE_HTML);

  assert.ok(count >= 4, `期望识别出 >=4 块，实际 ${count}`);
  assert.strictEqual(blocks.length, count, 'count 应与 blocks.length 一致');

  const byType = {};
  blocks.forEach((b) => {
    byType[b.type] = byType[b.type] || [];
    byType[b.type].push(b);
  });

  // 类型分布：h2/h3/quote/divider/imageCard 均应至少出现一次
  ['h2', 'h3', 'quote', 'divider', 'imageCard'].forEach((t) => {
    assert.ok(byType[t] && byType[t].length >= 1, `缺少类型 ${t}`);
  });

  // flex 块必须被过滤：不应出现任何模板包含"这个标题因为用了 flex"
  blocks.forEach((b) => {
    assert.ok(!b.htmlTemplate.includes('这个标题因为用了 flex'), 'flex 样式块应被存活规则过滤，未过滤成功');
  });

  // h2 块：{{content}} 替换成功，且原文本"公众号运营的五个关键动作"已被占位符取代
  const h2 = byType.h2[0];
  assert.ok(h2.htmlTemplate.includes('{{content}}'), 'h2 模板应含 {{content}}');
  assert.ok(!h2.htmlTemplate.includes('公众号运营的五个关键动作'), 'h2 模板不应残留原文本');
  assert.ok(!/\bid="/.test(h2.htmlTemplate) && !/\bclass="/.test(h2.htmlTemplate) && !/\bdata-[a-z-]+="/.test(h2.htmlTemplate), 'h2 模板应剥离 id/class/data-*');
  assert.ok(/style="/.test(h2.htmlTemplate), 'h2 模板应保留 style');

  // h3 块：同上
  const h3 = byType.h3[0];
  assert.ok(h3.htmlTemplate.includes('{{content}}'), 'h3 模板应含 {{content}}');
  assert.ok(!h3.htmlTemplate.includes('数据复盘'), 'h3 模板不应残留原文本');

  // quote 块：blockquote 标签 + {{content}}，id/class 已剥
  const quote = byType.quote[0];
  assert.ok(quote.htmlTemplate.includes('{{content}}'), 'quote 模板应含 {{content}}');
  assert.ok(!/\bid="/.test(quote.htmlTemplate) && !/\bclass="/.test(quote.htmlTemplate), 'quote 模板应剥离 id/class');
  assert.ok(!quote.htmlTemplate.includes('长期主义'), 'quote 模板不应残留原文本');

  // divider 块：来自 hr，id/class 已剥
  const divider = byType.divider[0];
  assert.ok(!/\bid="/.test(divider.htmlTemplate) && !/\bclass="/.test(divider.htmlTemplate), 'divider 模板应剥离 id/class');

  // imageCard 块：至少一块含 {{src}}，且同元素图注场景下 {{caption}} 替换成功、原图注文本消失
  const imageCards = byType.imageCard;
  imageCards.forEach((b) => {
    assert.ok(b.htmlTemplate.includes('{{src}}'), 'imageCard 模板应含 {{src}}');
    assert.ok(!/\bid="/.test(b.htmlTemplate) && !/\bdata-src="/.test(b.htmlTemplate), 'imageCard 模板应剥离 id/data-src（真实图源不应残留，防盗链+版权）');
  });
  const withCaption = imageCards.filter((b) => b.htmlTemplate.includes('{{caption}}'));
  assert.ok(withCaption.length >= 1, '至少一个 imageCard 应识别出图注并替换为 {{caption}}');
  const captionBlock = withCaption.find((b) => b.htmlTemplate.includes('图1') === false);
  assert.ok(captionBlock, '图注块不应残留原始图注文本');

  // 命名规范：提取块名形如"提取·标题 1"
  assert.ok(/^提取·/.test(h2.name), `h2 命名应以"提取·"开头，实际 ${h2.name}`);

  // accentEditable / sourceUrl 契约默认值
  blocks.forEach((b) => {
    assert.strictEqual(b.accentEditable, false, '提取块 accentEditable 应为 false');
    assert.strictEqual(b.sourceUrl, null, '纯函数不联网，sourceUrl 应为 null，由路由层回填');
  });

  console.log(`[test_style_extract] OK: ${count} 块，类型分布 = ${JSON.stringify(Object.fromEntries(Object.entries(byType).map(([k, v]) => [k, v.length])))}`);
}

main();
