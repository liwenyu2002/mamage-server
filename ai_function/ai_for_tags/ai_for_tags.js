// ai_for_tags.js
// Photo vision analysis provider. Production can use local Ollama/Qwen2.5VL
// without changing the upload worker contract.

const { OpenAI } = require('openai');
const http = require('http');
const https = require('https');

const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:3b';

const QUALITY_TAGS = new Set(['AI rejected', 'AI recommended']);
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

const LOCAL_VISION_PROMPT = [
  '你是高校新闻图片审核与打标助手。只根据图片中客观可见内容判断，不要猜测人物身份。',
  '必须只返回一个 JSON 对象，不要 Markdown，不要解释。',
  'JSON 字段固定为：description, qualityTag, standardTags, customTags。',
  'description：20-40 字中文，客观新闻口吻。',
  'qualityTag：只能是 "AI rejected"、"AI recommended" 或空字符串。',
  'AI rejected 优先：严重模糊、明显过曝欠曝、严重歪斜、主体被大面积遮挡、构图极乱、人物闭眼或表情明显不适合严肃新闻。',
  'AI recommended 仅用于主体清晰、主题明确、构图稳、无遮挡、适合新闻展示的照片。',
  `standardTags：只能从这些固定词中选择，总量适中：${STANDARD_TAGS.join('、')}。`,
  'standardTags 至少包含一个景别、一个焦段、一个人物数量或无人/动物判断。',
  '人物数量规则：单人=只有 1 个清晰可见真人；多人=有 2 个或以上清晰可见真人；无人=没有真人；动物=主体是动物。',
  '不要把讲台、麦克风、海报、屏幕、雕像、文字、阴影、模糊背景形状、残缺肢体当作人。只有一位演讲者或发言者时必须写单人，不能写多人。',
  'customTags：0-3 个中文短标签，只写画面中客观可见且固定词未覆盖的具体内容；不要重复固定标签；不要写泛词。',
  '最终标签总数不超过 10 个。'
].join('\n');

const DASHSCOPE_SYSTEM_PROMPT = [
  '你是高校新闻中心的图片审核与打标助手。只输出两行，不要解释。',
  '第1行：description=20-40字中文客观描述。',
  '第2行：tags=[标签1,标签2,...]，总数不超过10。',
  'AI rejected 优先：严重模糊、过曝欠曝、歪斜、主体遮挡、构图极乱、闭眼或表情不适合新闻。',
  'AI recommended 仅用于清晰、主题明确、构图稳、无遮挡、适合新闻展示的照片。',
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

function isUsefulCustomTag(tag) {
  if (!tag) return false;
  const lower = tag.toLowerCase();
  if (GENERIC_CUSTOM_TAGS.has(lower) || GENERIC_CUSTOM_TAGS.has(tag)) return false;
  if (QUALITY_TAGS.has(tag) || STANDARD_TAG_SET.has(tag)) return false;
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
  const qualityTag = cleanTag(parsed.qualityTag || parsed.quality || parsed.aiLabel || '');
  if (QUALITY_TAGS.has(qualityTag)) pushUnique(tags, qualityTag, 10);

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
    if (QUALITY_TAGS.has(tag) || STANDARD_TAG_SET.has(tag) || isUsefulCustomTag(tag)) {
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

async function analyzeWithOllama(imageUrl) {
  const buf = /^https?:\/\//i.test(imageUrl) ? await fetchBinary(imageUrl) : null;
  if (!buf) throw new Error('Ollama provider requires an http(s) image URL');

  const model = getOllamaModel();
  const payload = {
    model,
    stream: false,
    format: 'json',
    prompt: LOCAL_VISION_PROMPT,
    images: [buf.toString('base64')],
    options: {
      temperature: Number(process.env.OLLAMA_VISION_TEMPERATURE || 0.1),
      num_predict: Number(process.env.OLLAMA_VISION_NUM_PREDICT || 512),
    },
  };
  const keepAlive = getOllamaKeepAlive();
  if (keepAlive) payload.keep_alive = keepAlive;

  const resp = await postJson(`${getOllamaBaseUrl()}/api/generate`, payload, getRequestTimeoutMs());
  if (resp && resp.error) throw new Error(resp.error);

  const raw = String((resp && resp.response) || '').trim();
  const parsed = parseVisionResponse(raw);
  return { raw, ...parsed, provider: 'ollama', model };
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
  headRequest,
  fetchBinary,
  parseVisionResponse,
  analyzeWithOllama,
  analyzeWithDashScope,
};
