// 推文模板 AI 填充：把"结构化模板的占位符清单 + 用户简报"交给文本模型，
// 返回 { title, digest, values } 严格 JSON，前端据此把 {{占位符}} 替换成成稿文案。
// 模型配置与搜索解析同源（AI_TEXT_API_KEY / AI_TEXT_BASE_URL，分销商优先）。
const OpenAI = require('openai').default || require('openai');

const REQUEST_TIMEOUT_MS = Math.max(5000, Number(process.env.WECHAT_AI_FILL_TIMEOUT_MS || 45000));
const MAX_SLOTS = 24;

function getClientConfig() {
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseURL = process.env.AI_TEXT_BASE_URL || process.env.DASHSCOPE_BASE_URL || undefined;
  const model = process.env.WECHAT_AI_FILL_MODEL || process.env.AI_TEXT_MODEL || 'deepseek-chat';
  return { apiKey, baseURL, model };
}

function parseJsonObject(content) {
  const text = String(content || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { /* continue */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch (e) { return null; }
}

/**
 * @param {Array<{key:string,label:string,hint?:string}>} slots 占位符清单
 * @param {string} brief 用户简报（活动名称/时间/亮点等，自由文本）
 * @param {object} [opts] { titleHint }
 */
async function aiFillArticleTemplate(slots, brief, opts = {}) {
  const cfg = getClientConfig();
  if (!cfg.apiKey) {
    const err = new Error('AI_TEXT_API_KEY_NOT_CONFIGURED');
    err.status = 503;
    throw err;
  }
  const safeSlots = (Array.isArray(slots) ? slots : [])
    .slice(0, MAX_SLOTS)
    .map((s) => ({ key: String(s.key || '').slice(0, 40), label: String(s.label || s.key || '').slice(0, 60), hint: s.hint ? String(s.hint).slice(0, 120) : undefined }))
    .filter((s) => s.key);
  if (!safeSlots.length) {
    const err = new Error('NO_SLOTS');
    err.status = 400;
    throw err;
  }

  const client = cfg.baseURL ? new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseURL }) : new OpenAI({ apiKey: cfg.apiKey });
  const system = [
    '你是高校公众号的资深推文创作者。用户给出一篇推文模板的占位符清单和活动简报，你负责为每个占位符撰写成稿文案。',
    '只输出一个 JSON 对象，不要解释，不要 markdown 代码块。结构固定为：',
    '{"title": "推文标题（20字内，可带主副题分隔）", "digest": "摘要（54字内，概括亮点）", "values": {"占位符键": "该处文案"}}',
    '写作要求：',
    '- 文风：庄重里有温度，符合高校官方公众号调性；杜绝空话套话堆砌，多用具体细节。',
    '- 每个 value 是纯文本，不要 markdown 标记（#、*、>），段落间用 \\n 分隔；长度按占位符语义判断（一句话/一段话/多段）。同名占位符只输出一次。',
    '- 不编造简报里没有的事实（人名、数字、荣誉）；简报缺信息时写通用但自然的过渡文案，不要留"待补充"。',
    '- title 里的占位符也要替换进 title 值里（如"{{活动名称}}圆满结束"→"XX晚会圆满结束"风格的具体标题）。',
    `- 今天是 ${new Date().toISOString().slice(0, 10)}，简报里的相对日期要换算成具体日期。`,
  ].join('\n');

  const user = [
    `活动简报：${String(brief || '').slice(0, 2000) || '（未提供，按通用校园活动撰写）'}`,
    opts.titleHint ? `标题方向参考：${String(opts.titleHint).slice(0, 200)}` : '',
    '占位符清单：',
    ...safeSlots.map((s) => `- key: ${s.key} | 用途: ${s.label}${s.hint ? ` | 补充说明: ${s.hint}` : ''}`),
  ].filter(Boolean).join('\n');

  const response = await Promise.race([
    client.chat.completions.create({
      model: cfg.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.6,
      max_tokens: 2200,
    }),
    new Promise((_, reject) => setTimeout(() => { const e = new Error('AI_FILL_TIMEOUT'); e.status = 504; reject(e); }, REQUEST_TIMEOUT_MS)),
  ]);

  const parsed = parseJsonObject(response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '');
  if (!parsed || typeof parsed !== 'object' || !parsed.values) {
    const err = new Error('AI_FILL_INVALID_JSON');
    err.status = 502;
    throw err;
  }

  const values = {};
  for (const s of safeSlots) {
    if (parsed.values[s.key] != null) values[s.key] = String(parsed.values[s.key]);
  }
  return {
    title: parsed.title ? String(parsed.title).slice(0, 64) : null,
    digest: parsed.digest ? String(parsed.digest).slice(0, 120) : null,
    values,
    model: cfg.model,
  };
}

module.exports = { aiFillArticleTemplate };
