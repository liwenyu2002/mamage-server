// 渠道模板种子：5 条内置渠道（新闻稿/通讯稿/公众号/小红书/微博）。
// 幂等：以 (channel_key, version) 唯一约束做 ON DUPLICATE KEY UPDATE，可重复执行、可用于线上刷新文案。
// press_release 的 prompt_fragments.systemRules 是现状 ai_for_news.js systemPrompt 的语义复刻（不要求逐字，
// 逐字一致性由 scripts/test_prompt_golden.js 锁定的是"不传渠道模板"的默认路径，不是这条渠道记录本身）。
//
// 用法：node scripts/seed_channel_templates.js

try {
  const path = require('path');
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch (e) {}

const { pool } = require('../db');

// 统一输出协议：所有渠道都遵守，写进每条模板的 output_schema 供前端/校验层读取。
const OUTPUT_SCHEMA = {
  title: 'string',
  subtitle: 'string',
  markdown: 'string',
  photos: 'array',
  extra: 'object?',
};

const TEMPLATES = [
  {
    channel_key: 'press_release',
    name: '新闻稿',
    version: 1,
    output_schema: OUTPUT_SCHEMA,
    prompt_fragments: {
      systemRules: [
        '你是新闻稿生成助手，输出对象是可直接对外发布的正式新闻稿。',
        'markdown 必须是完整新闻稿结构：标题 + 导语 + 正文。',
        '以第三人称客观视角撰写，不使用第一人称。',
        '根据内容需要在正文中按需插入图片占位符，不必每段都配图。',
        '图题（alt）不超过 20 字，只描述画面，不包含具体事实信息。',
        '已选图片信息中给出人物姓名（people/faceNames/personNames）时，图题必须优先包含对应人物姓名；没有人名时再写中性图题。',
        'photos 数组每项为 {id,url,alt,caption}，url 可为空。',
        '参考资料只可借鉴文风，不可直接引用其中的具体事实。',
      ],
    },
    render_target: 'markdown',
    default_max_tokens: 1600,
    is_active: 1,
  },
  {
    channel_key: 'report_brief',
    name: '通讯稿（上级报送）',
    version: 1,
    output_schema: OUTPUT_SCHEMA,
    prompt_fragments: {
      systemRules: [
        '你是机关/单位通讯稿撰写助手，输出用于向上级报送的公文体通讯稿。',
        '采用公文三段式结构：①开头引用政策或上级精神依据；②主体陈述活动成效，成效必须量化（人数、场次、覆盖面等具体数字）；③结尾写明确的"下一步计划"。',
        '文风严肃规范，禁止使用 emoji，禁止使用网络流行语。',
        '全文字数控制在 500-1000 字；明显超出该区间时，在 markdown 末尾追加一行提醒文字说明超出情况。',
        '正文末尾预留落款占位（单位名称与日期）；若素材中提供了企业固定结尾，优先采用该固定结尾。',
      ],
    },
    render_target: 'markdown',
    default_max_tokens: 1400,
    is_active: 1,
  },
  {
    channel_key: 'wechat_article',
    name: '公众号推文',
    version: 1,
    output_schema: OUTPUT_SCHEMA,
    prompt_fragments: {
      systemRules: [
        '你是公众号运营助手，输出用于微信公众号发布的图文报道。',
        '全文字数 800-1800 字，采用新媒体报道体裁。',
        '标题不超过 64 字，需要有吸引力，但不能标题党。',
        '导语 2-3 句，迅速抓住读者注意力。',
        '小标题可使用 emoji 作为视觉锚点，但每个小标题最多 1 个 emoji，不要滥用。',
        '正文每 2-3 段插入一张图片占位符，避免大段无图长文。',
        '结尾自然收束；若素材中提供了企业固定结尾，优先采用该固定结尾。',
      ],
    },
    render_target: 'markdown',
    default_max_tokens: 2400,
    is_active: 1,
  },
  {
    channel_key: 'xiaohongshu',
    name: '小红书笔记',
    version: 1,
    output_schema: OUTPUT_SCHEMA,
    prompt_fragments: {
      systemRules: [
        '你是小红书笔记博主，以第一人称在场视角撰写真实体验分享。',
        '标题不超过 20 字，需带情绪钩子，让人想点开。',
        '正文 100-500 字，每段不超过 3 行，口语化表达，长短句交替。',
        'emoji 自然穿插，不堆砌。',
        '结尾提炼 3-6 个话题词放入 extra.hashtags 数组，不要写进 markdown 正文。',
        '去 AI 味硬约束：禁止使用"首先/其次/最后"这类结构词；禁止排比堆砌；禁止"总之/综上所述"式总结收尾。',
        '建议从已选图片中挑选 3-9 张放入 photos 数组。',
      ],
    },
    render_target: 'markdown',
    default_max_tokens: 1200,
    is_active: 1,
  },
  {
    channel_key: 'weibo',
    name: '微博',
    version: 1,
    output_schema: OUTPUT_SCHEMA,
    prompt_fragments: {
      systemRules: [
        '你是机构官方微博运营助手，语气简洁有力、口吻庄重但不生硬。',
        '正文以 140 字以内为最佳，硬性上限 400 字，超出必须精简。',
        '提炼 1-3 个 #话题# 放入 extra.hashtags 数组，不要把 # 号写进 markdown 正文。',
        '最多带 1 张图片占位符。',
      ],
    },
    render_target: 'markdown',
    default_max_tokens: 600,
    is_active: 1,
  },
];

async function upsertTemplate(t) {
  await pool.query(
    `INSERT INTO channel_templates
       (channel_key, name, version, output_schema, prompt_fragments, render_target, default_max_tokens, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       name = VALUES(name),
       output_schema = VALUES(output_schema),
       prompt_fragments = VALUES(prompt_fragments),
       render_target = VALUES(render_target),
       default_max_tokens = VALUES(default_max_tokens),
       is_active = VALUES(is_active),
       updated_at = CURRENT_TIMESTAMP`,
    [
      t.channel_key,
      t.name,
      t.version,
      JSON.stringify(t.output_schema),
      JSON.stringify(t.prompt_fragments),
      t.render_target,
      t.default_max_tokens,
      t.is_active,
    ]
  );
}

async function main() {
  for (const t of TEMPLATES) {
    await upsertTemplate(t);
    console.log(`[seed_channel_templates] upserted: ${t.channel_key} (v${t.version})`);
  }
  console.log(`[seed_channel_templates] done. ${TEMPLATES.length} templates.`);
}

main()
  .catch((err) => {
    console.error('[seed_channel_templates] failed:', err && err.stack ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await pool.end();
    } catch (e) {}
  });
