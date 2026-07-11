// ai_for_tags.js
// Photo vision analysis provider. Production can use local Ollama/Qwen2.5VL
// without changing the upload worker contract.

const { OpenAI } = require('openai');
const http = require('http');
const https = require('https');
const { computeTechAndImage, composeQuality } = require('./photo_quality');

const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:3b';

const QUALITY_TAGS = new Set(['AI rejected', 'AI medium', 'AI recommended']);
const STANDARD_TAGS = [
  '特写', '近景', '中景', '全景', '远景',
  '长焦', '标准焦段', '超广角',
  '室内', '室外', '操场', '教室', '会议室',
  '人物', '无人', '单人', '多人', '动物',
  '演讲', '运动', '鼓掌', '交流',
  '讲座', '运动会', '出游', '办公', '上课', '庆典',
  '正式', '严肃', '庆祝', '动感', '青春', '温馨', '喜悦',
  '白天', '黑夜',
];
const STANDARD_TAG_SET = new Set(STANDARD_TAGS);
const GENERIC_CUSTOM_TAGS = new Set([
  '照片', '图片', '图像', '画面', '场景', '内容', '新闻', '活动',
  '无', '无标签', 'none', 'null', 'undefined', 'unknown', 'reason',
]);
const RECOMMENDED_QUALITY_VALUES = new Set([
  'ai recommended', 'airecommended', 'recommended', 'recommend', 'good', 'selected',
  'ai推荐', '推荐', '建议推荐', '精选', '优质',
]);
const MEDIUM_QUALITY_VALUES = new Set([
  'ai medium', 'aimedium', 'medium', 'neutral', 'normal', 'average', 'ok', 'okay',
  'acceptable', 'ordinary', 'fair', 'middle',
  'ai中等', '中等', '中档', '普通', '一般', '尚可', '可用但普通', '一般可用',
]);
const REJECTED_QUALITY_VALUES = new Set([
  'ai rejected', 'airejected', 'rejected', 'reject', 'bad', 'discard', 'discarded',
  'ai拒绝', '拒绝', '不推荐', '建议不推荐', '淘汰', '废片', '不可用',
]);

const LOCAL_VISION_PROMPT = [
  '你是高校新闻图片审核与打标助手。只根据图片中客观可见内容判断，不要猜测人物身份。',
  '必须只返回一个 JSON 对象，不要 Markdown，不要解释。',
  'JSON 字段固定为：description, qualityTag, standardTags, customTags。',
  'description：20-40 字中文，客观新闻口吻。',
  'qualityTag：必须输出 "AI recommended"、"AI medium" 或 "AI rejected" 三者之一。',
  'AI rejected 优先：严重模糊、明显过曝欠曝、严重歪斜、主体被大面积遮挡、构图极乱、人物闭眼或表情明显不适合严肃新闻。',
  'AI medium 是默认值：画质基本可用、内容清楚，但构图普通、审美一般、信息记录属性强、冲击力不强或只适合留档的照片都归为中等。',
  'AI recommended 必须非常严格：不仅清晰，还要主体突出、背景干净、构图有层次、光线或色彩舒服、瞬间感好，适合作为新闻头图/封面。',
  '不要因为照片清晰就推荐；普通记录照、证件展示、随手拍、主体弱、背景杂、构图平淡的照片，即使可用也必须是 AI medium。',
  `standardTags：只能从这些固定词中选择，总量适中：${STANDARD_TAGS.join('、')}。`,
  'standardTags 至少包含一个景别、一个焦段、一个人物数量或无人/动物判断。',
  '人物数量规则：单人=只有 1 个清晰可见真人；多人=有 2 个或以上清晰可见真人；无人=没有真人；动物=主体是动物。',
  '不要把讲台、麦克风、海报、屏幕、雕像、文字、阴影、模糊背景形状、残缺肢体当作人。只有一位演讲者或发言者时必须写单人，不能写多人。',
  'customTags：0-3 个中文短标签，只写画面中客观可见且固定词未覆盖的具体内容；不要重复固定标签；不要写泛词。',
  '最终标签总数不超过 10 个。'
].join('\n');

// AI 选片 2.0：锐度/曝光已由代码实测（作为提示注入），模型只评主观四维 + 缺陷 + 评语。
// 不再让模型输出 qualityTag——三档标签由服务端按综合分与致命缺陷映射。
function buildScoredVisionPrompt(tech) {
  return [
    '你是高校摄影社的资深选片编辑。只根据图片客观可见内容判断，不要猜测人物身份。',
    '必须只返回一个 JSON 对象，不要 Markdown，不要解释。所有字段都必须给出。',
    'JSON 字段固定为：description, standardTags, customTags, quality, ocrText。',
    'description：20-40 字中文，客观新闻口吻，只描述画面内容，绝不要提及锐度/曝光/技术检测等数值。',
    'ocrText：提取画面中清晰可辨认的文字（横幅、海报、屏幕、证书、号码牌、指示牌等），按重要性排列，用空格分隔，最多 200 字；看不清就不要写，绝不编造；没有文字给空字符串 ""。',
    'quality 是一个对象，字段如下：',
    'quality.composition：构图 1-10。三分法/引导线/层次/画面平衡；歪斜、切头切脚、主体贴边低分。',
    'quality.subject：主体 1-10。主体是否突出醒目、与背景分离；找不到主体或主体被杂物淹没低分。',
    'quality.moment：瞬间 1-10。表情/动作/互动的瞬间价值；呆板站桩合影类给 4-6，抓拍到笑容/掌声/交流高分。',
    'quality.aesthetics：美感 1-10。光线、色彩、氛围的整体观感。',
    '评分务必拉开差距：普通记录照应落在 4-6，明显问题给 2-3，只有确实出色的维度才给 8 以上，10 分极罕见。',
    'quality.flags：0-4 个缺陷，只能从这些词中选：闭眼、表情不佳、背影、主体遮挡、画面歪斜、杂乱背景、无明显主体。没有就给空数组。',
    '闭眼只在能看清人脸且主要人物明显闭眼时才标；背影指主要人物背对镜头。',
    'quality.reason：必填，15-30 字中文选片评语，说清这张照片最突出的优点或最主要的问题，例如"主体人物表情自然，舞台光效出色"或"构图松散，主体不突出"。',
    `参考信息（程序已在原图实测，仅供你写评语参考，不要抄进 description）：锐度 ${tech.sharpness}/10，曝光 ${tech.exposure}/10。你不要评清晰度与曝光。`,
    `standardTags：只能从这些固定词中选择，总量适中：${STANDARD_TAGS.join('、')}。`,
    'standardTags 至少包含一个景别、一个焦段、一个人物数量或无人/动物判断。',
    '人物数量规则：单人=只有 1 个清晰可见真人；多人=有 2 个或以上清晰可见真人；无人=没有真人；动物=主体是动物。',
    '不要把讲台、麦克风、海报、屏幕、雕像、文字、阴影、模糊背景形状、残缺肢体当作人。',
    'customTags：0-3 个中文短标签，只写画面中客观可见且固定词未覆盖的具体内容；不要写泛词。',
  ].join('\n');
}

const DASHSCOPE_SYSTEM_PROMPT = [
  '你是高校新闻中心的图片审核与打标助手。只输出两行，不要解释。',
  '第1行：description=20-40字中文客观描述。',
  '第2行：tags=[标签1,标签2,...]，总数不超过10。',
  'AI rejected 优先：严重模糊、过曝欠曝、歪斜、主体遮挡、构图极乱、闭眼或表情不适合新闻。',
  'AI medium 是默认值：画质基本可用、内容清楚，但构图普通、审美一般、信息记录属性强、冲击力不强或只适合留档的照片都归为中等。',
  'AI recommended 必须非常严格：不仅清晰，还要主体突出、背景干净、构图有层次、光线或色彩舒服、瞬间感好，适合作为新闻头图/封面。',
  '不要因为照片清晰就推荐；普通记录照、证件展示、随手拍、主体弱、背景杂、构图平淡的照片，即使可用也必须是 AI medium。',
  `固定标签优先：${STANDARD_TAGS.join('、')}。`,
  '人物数量：单人=1 个清晰可见真人；多人=2 个或以上清晰可见真人；不要把讲台、麦克风、海报、屏幕、阴影、背景形状当作人。',
  '可以额外生成 0-3 个客观可见的中文短标签，不要写泛词。'
].join('\n');

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'dashscope';
  if (raw === 'local' || raw === 'ollama' || raw === 'qwen' || raw === 'qwen-local') return 'ollama';
  if (raw === 'dashscope' || raw === 'aliyun' || raw === 'cloud') return 'dashscope';
  if (raw === 'off' || raw === 'disabled' || raw === 'none') return 'off';
  return raw;
}

function getVisionProvider() {
  return normalizeProvider(process.env.AI_VISION_PROVIDER || process.env.VISION_PROVIDER || 'dashscope');
}

function getFallbackProvider(primary) {
  const raw = String(process.env.AI_VISION_FALLBACK_PROVIDER || '').trim();
  if (!raw) return null;
  const fallback = normalizeProvider(raw);
  if (!fallback || fallback === primary || fallback === 'off') return null;
  return fallback;
}

function getDashScopeClient() {
  const key = process.env.AI_VISION_API_KEY || process.env.DASHSCOPE_API_KEY;
  if (!key) {
    throw new Error('Missing AI_VISION_API_KEY or DASHSCOPE_API_KEY in environment');
  }
  return new OpenAI({
    apiKey: key,
    baseURL: process.env.DASHSCOPE_BASE_URL || DEFAULT_DASHSCOPE_BASE_URL,
  });
}

function getOllamaBaseUrl() {
  return String(process.env.OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, '');
}

function getOllamaModel() {
  return process.env.OLLAMA_VISION_MODEL || process.env.LOCAL_VISION_MODEL || DEFAULT_OLLAMA_MODEL;
}

function getRequestTimeoutMs() {
  const raw = Number(process.env.OLLAMA_REQUEST_TIMEOUT_MS || process.env.AI_REQUEST_TIMEOUT_MS || 120000);
  return Number.isFinite(raw) && raw > 0 ? raw : 120000;
}

function getOllamaKeepAlive() {
  const raw = process.env.OLLAMA_KEEP_ALIVE;
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value || null;
}

function inferMime(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return 'image/jpeg';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return 'image/jpeg';
}

async function headRequest(url) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.request(u, { method: 'HEAD' }, (res) => {
        resolve({ statusCode: res.statusCode, headers: res.headers || {} });
      });
      req.on('error', reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

async function fetchBinary(url, opts = {}) {
  const maxRedirects = opts.maxRedirects || 5;
  const timeoutMs = opts.timeoutMs || 15000;
  const maxBytes = opts.maxBytes || Number(process.env.AI_VISION_IMAGE_MAX_BYTES || 5 * 1024 * 1024);

  return new Promise((resolve, reject) => {
    let redirects = 0;

    function get(u) {
      try {
        const lib = u.protocol === 'https:' ? https : http;
        const req = lib.get(u, { timeout: timeoutMs }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirects >= maxRedirects) {
              res.resume();
              reject(new Error('Too many redirects'));
              return;
            }
            redirects += 1;
            const next = new URL(res.headers.location, u);
            res.resume();
            get(next);
            return;
          }

          if (res.statusCode !== 200) {
            const err = new Error('HTTP status ' + res.statusCode);
            err.statusCode = res.statusCode;
            res.resume();
            reject(err);
            return;
          }

          const chunks = [];
          let total = 0;
          res.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
              req.destroy(new Error('Image exceeds max bytes'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => req.destroy(new Error('Request timeout')));
      } catch (e) {
        reject(e);
      }
    }

    try {
      get(new URL(url));
    } catch (e) {
      reject(e);
    }
  });
}

async function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const lib = u.protocol === 'https:' ? https : http;
      const body = Buffer.from(JSON.stringify(payload));
      const req = lib.request(u, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': body.length,
        },
        timeout: timeoutMs,
      }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 1000)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(new Error('Invalid JSON response: ' + text.slice(0, 1000)));
          }
        });
      });
      req.on('timeout', () => req.destroy(new Error('Request timeout')));
      req.on('error', reject);
      req.write(body);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

function stripCodeFence(raw) {
  return String(raw || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function tryParseJsonObject(raw) {
  const cleaned = stripCodeFence(raw);
  try {
    const parsed = JSON.parse(cleaned);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch (e) {
    // try substring below
  }
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const slice = cleaned.slice(start, end + 1);
    try {
      const parsed = JSON.parse(slice);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch (e) {
      return null;
    }
  }
  return null;
}

function parseLegacyLines(raw) {
  const lines = String(raw || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  let description = null;
  let tags = [];

  for (const line of lines) {
    const descMatch = line.match(/^description\s*=\s*(.*)$/i);
    if (descMatch && !description) {
      description = descMatch[1].trim();
      continue;
    }
    const tagMatch = line.match(/^tags\s*=\s*\[(.*)\]\s*$/i);
    if (tagMatch) {
      tags = tagMatch[1].split(',').map((s) => s.trim()).filter(Boolean);
    }
  }

  return { description, tags };
}

function normalizeArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed;
    } catch (e) {
      // fall through
    }
    return trimmed.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function cleanTag(value) {
  const tag = String(value || '')
    .replace(/[\[\]{}"']/g, '')
    .replace(/[，,。；;：:]/g, '')
    .trim();
  if (!tag) return '';
  return tag.slice(0, 24);
}

function normalizeQualityTag(value) {
  const tag = cleanTag(value);
  if (!tag) return '';
  if (QUALITY_TAGS.has(tag)) return tag;
  const normalized = tag.toLowerCase().replace(/\s+/g, '');
  const spaced = tag.toLowerCase().replace(/\s+/g, ' ').trim();
  if (RECOMMENDED_QUALITY_VALUES.has(normalized) || RECOMMENDED_QUALITY_VALUES.has(spaced)) return 'AI recommended';
  if (MEDIUM_QUALITY_VALUES.has(normalized) || MEDIUM_QUALITY_VALUES.has(spaced)) return 'AI medium';
  if (REJECTED_QUALITY_VALUES.has(normalized) || REJECTED_QUALITY_VALUES.has(spaced)) return 'AI rejected';
  return '';
}

function isUsefulCustomTag(tag) {
  if (!tag) return false;
  const lower = tag.toLowerCase();
  if (GENERIC_CUSTOM_TAGS.has(lower) || GENERIC_CUSTOM_TAGS.has(tag)) return false;
  if (QUALITY_TAGS.has(tag) || STANDARD_TAG_SET.has(tag)) return false;
  if (normalizeQualityTag(tag)) return false;
  if (!/[\u4e00-\u9fa5]/.test(tag)) return false;
  if (tag.length > 12) return false;
  return true;
}

function pushUnique(target, value, max) {
  const tag = cleanTag(value);
  if (!tag || target.includes(tag)) return;
  if (target.length >= max) return;
  target.push(tag);
}

function buildTagsFromStructured(parsed) {
  const tags = [];
  const qualityTag = normalizeQualityTag(parsed.qualityTag || parsed.quality || parsed.aiLabel || '');
  if (qualityTag) pushUnique(tags, qualityTag, 10);

  const standard = [
    ...normalizeArray(parsed.standardTags),
    ...normalizeArray(parsed.fixedTags),
  ];
  for (const item of standard) {
    const tag = cleanTag(item);
    if (STANDARD_TAG_SET.has(tag)) pushUnique(tags, tag, 10);
  }

  // Accept tags from models that do not split fixed/custom fields.
  for (const item of normalizeArray(parsed.tags)) {
    const tag = cleanTag(item);
    const quality = normalizeQualityTag(tag);
    if (quality) {
      pushUnique(tags, quality, 10);
    } else if (STANDARD_TAG_SET.has(tag) || isUsefulCustomTag(tag)) {
      pushUnique(tags, tag, 10);
    }
  }

  let customCount = 0;
  for (const item of normalizeArray(parsed.customTags)) {
    const tag = cleanTag(item);
    if (!isUsefulCustomTag(tag)) continue;
    pushUnique(tags, tag, 10);
    customCount += 1;
    if (customCount >= 3) break;
  }

  return normalizePersonCountTags(tags.slice(0, 10), parsed.description || parsed.caption || parsed.summary || '');
}

function descriptionLooksSinglePerson(description) {
  const text = String(description || '');
  if (!text) return false;
  if (/(多人|多位|多名|两位|两名|二人|三人|观众|听众|人群|合影|师生|学生们|大家|集体)/.test(text)) {
    return false;
  }
  return /(一位|一名|一个|1位|1名).{0,16}(男性|女性|男子|女子|男士|女士|老师|教师|学生|嘉宾|专家|院士|演讲者|发言者|人员|人)/.test(text);
}

function normalizePersonCountTags(tags, description) {
  let next = Array.isArray(tags) ? tags.slice() : [];
  if (next.includes('动物')) {
    return next.filter((tag) => !['人物', '无人', '单人', '多人'].includes(tag));
  }
  if (next.includes('无人')) {
    return next.filter((tag) => !['人物', '单人', '多人'].includes(tag));
  }
  if (descriptionLooksSinglePerson(description) && next.includes('多人')) {
    next = next.map((tag) => tag === '多人' ? '单人' : tag);
  }
  if (next.includes('单人') && next.includes('多人')) {
    next = next.filter((tag) => tag !== '多人');
  }
  return Array.from(new Set(next)).slice(0, 10);
}

function parseVisionResponse(raw) {
  const parsed = tryParseJsonObject(raw);
  if (parsed) {
    const description = cleanDescription(parsed.description || parsed.caption || parsed.summary || '');
    const tags = buildTagsFromStructured(parsed);
    return { description, tags };
  }

  const legacy = parseLegacyLines(raw);
  return {
    description: cleanDescription(legacy.description || ''),
    tags: buildTagsFromStructured({ description: legacy.description, tags: legacy.tags }),
  };
}

function cleanDescription(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.slice(0, 160);
}

async function toModelDataUrl(imageUrl) {
  if (!/^https?:\/\//i.test(imageUrl)) return imageUrl;
  const buf = await fetchBinary(imageUrl);
  const mime = inferMime(buf);
  return `data:${mime};base64,${buf.toString('base64')}`;
}

async function analyzeWithDashScope(imageUrl) {
  let imageUrlForModel = imageUrl;
  try {
    imageUrlForModel = await toModelDataUrl(imageUrl);
  } catch (e) {
    console.error('[ai_for_tags] failed to fetch image for DashScope, fallback to raw url:', e && e.message ? e.message : e);
  }

  const openai = getDashScopeClient();
  const model = process.env.AI_VISION_MODEL || 'qwen-vl-max';
  const resp = await openai.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: DASHSCOPE_SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: imageUrlForModel } },
          { type: 'text', text: '请严格按要求只输出两行：description=... 和 tags=[...]。' },
        ],
      },
    ],
  });

  const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
  const raw = extractOpenAIMessageText(msg);
  const parsed = parseVisionResponse(raw);
  return { raw, ...parsed, provider: 'dashscope', model };
}

function extractOpenAIMessageText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content.trim();
  if (Array.isArray(msg.content)) {
    return msg.content.map((p) => {
      if (typeof p === 'string') return p;
      if (p && typeof p.text === 'string') return p.text;
      if (p && typeof p.output_text === 'string') return p.output_text;
      return '';
    }).join('').trim();
  }
  return String(msg.content || '').trim();
}

async function callOllamaGenerate(prompt, imageBase64) {
  const model = getOllamaModel();
  const payload = {
    model,
    stream: false,
    format: 'json',
    prompt,
    images: [imageBase64],
    options: {
      temperature: Number(process.env.OLLAMA_VISION_TEMPERATURE || 0.1),
      num_predict: Number(process.env.OLLAMA_VISION_NUM_PREDICT || 512),
    },
  };
  const keepAlive = getOllamaKeepAlive();
  if (keepAlive) payload.keep_alive = keepAlive;

  const resp = await postJson(`${getOllamaBaseUrl()}/api/generate`, payload, getRequestTimeoutMs());
  if (resp && resp.error) throw new Error(resp.error);
  // qwen3-vl 等思考型模型会把输出写进 thinking 而 response 为空——兜底读取
  const primary = String((resp && resp.response) || '').trim();
  if (primary) return primary;
  return String((resp && resp.thinking) || '').trim();
}

async function analyzeWithOllama(imageUrl) {
  const buf = /^https?:\/\//i.test(imageUrl) ? await fetchBinary(imageUrl) : null;
  if (!buf) throw new Error('Ollama provider requires an http(s) image URL');

  const raw = await callOllamaGenerate(LOCAL_VISION_PROMPT, buf.toString('base64'));
  const parsed = parseVisionResponse(raw);
  return { raw, ...parsed, provider: 'ollama', model: getOllamaModel() };
}

function extractModelQuality(raw) {
  const parsed = tryParseJsonObject(raw);
  if (!parsed || typeof parsed.quality !== 'object' || !parsed.quality) return null;
  return parsed.quality;
}

// AI 选片 2.0 入口：原图 → 技术实测（sharp）→ 模型主观四维 → 综合分/三档。
// 与旧 analyze() 的差异：分析用图是原图 resize 1280（而非缩略图），
// 三档标签由 composeQuality 计算并注入 tags 首位，另返回 score/quality 供持久化。
async function analyzePhoto(imageUrl) {
  if (getVisionProvider() !== 'ollama') {
    // 非本地视觉通道退回旧管线（无评分）
    const legacy = await analyze(imageUrl);
    return { ...legacy, score: null, quality: null };
  }

  // 原图上限用独立环境变量：AI_VISION_IMAGE_MAX_BYTES 是缩略图/DashScope 载荷的 5MB 档，
  // 共用会在运维收紧后者时静默掐死大原图的评分管线
  const buf = await fetchBinary(imageUrl, { maxBytes: Number(process.env.AI_VISION_ORIGINAL_MAX_BYTES || 40 * 1024 * 1024) });
  const { tech, modelJpeg } = await computeTechAndImage(buf);

  const raw = await callOllamaGenerate(buildScoredVisionPrompt(tech), modelJpeg.toString('base64'));
  const parsed = parseVisionResponse(raw);
  const modelQuality = extractModelQuality(raw);
  const { score, label, quality } = composeQuality(tech, modelQuality);
  const parsedObj = tryParseJsonObject(raw);
  const ocrText = parsedObj && typeof parsedObj.ocrText === 'string'
    ? parsedObj.ocrText.replace(/\s+/g, ' ').trim().slice(0, 500) || null
    : null;

  // 三档标签由服务端算出，替换/前插进 tags（旧数据里的质量标签词表兼容不变）
  const tags = [label, ...(parsed.tags || []).filter((t) => !QUALITY_TAGS.has(t))].slice(0, 10);

  return {
    raw,
    description: parsed.description,
    tags,
    score,
    quality,
    ocrText,
    provider: 'ollama',
    model: getOllamaModel(),
  };
}

async function analyzeWithProvider(provider, imageUrl) {
  if (provider === 'off') return { raw: '', description: null, tags: [], provider: 'off', model: null };
  if (provider === 'ollama') return analyzeWithOllama(imageUrl);
  if (provider === 'dashscope') return analyzeWithDashScope(imageUrl);
  throw new Error(`Unsupported AI_VISION_PROVIDER: ${provider}`);
}

async function analyze(imageUrl) {
  const provider = getVisionProvider();
  try {
    return await analyzeWithProvider(provider, imageUrl);
  } catch (err) {
    const fallback = getFallbackProvider(provider);
    if (!fallback) throw err;
    console.error(`[ai_for_tags] ${provider} failed, fallback to ${fallback}:`, err && err.message ? err.message : err);
    return analyzeWithProvider(fallback, imageUrl);
  }
}

module.exports = {
  analyze,
  analyzePhoto,
  headRequest,
  fetchBinary,
  parseVisionResponse,
  analyzeWithOllama,
  analyzeWithDashScope,
  callOllamaGenerate,
};
