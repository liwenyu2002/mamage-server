const { OpenAI } = require('openai');

const CACHE_TTL_MS = Math.max(60 * 1000, Number(process.env.AI_SEARCH_CACHE_TTL_MS || 10 * 60 * 1000));
const CACHE_MAX = Math.max(20, Number(process.env.AI_SEARCH_CACHE_MAX || 300));
const REQUEST_TIMEOUT_MS = Math.max(1500, Number(process.env.AI_SEARCH_TIMEOUT_MS || 7000));
const cache = new Map();
const inflight = new Map();

const MEDIA_TYPES = new Set(['all', 'image', 'video']);
const QUALITY_TYPES = new Set(['any', 'recommended', 'medium', 'rejected']);
const SORT_TYPES = new Set(['relevance', 'newest', 'quality']);
const PEOPLE_MODES = new Set(['any', 'all']);

function uniqueStrings(input, limit = 8, maxLen = 32) {
  const values = Array.isArray(input) ? input : (input ? [input] : []);
  const seen = new Set();
  const result = [];
  values.forEach((value) => {
    const normalized = String(value || '').replace(/\s+/g, ' ').trim().slice(0, maxLen);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key) || result.length >= limit) return;
    seen.add(key);
    result.push(normalized);
  });
  return result;
}

function normalizeDate(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== raw) return null;
  return raw;
}

function normalizePhotoSearchPlan(input, originalQuery = '') {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const query = String(originalQuery || '').trim().slice(0, 160);
  const mediaType = MEDIA_TYPES.has(String(raw.mediaType || '').toLowerCase())
    ? String(raw.mediaType).toLowerCase()
    : 'all';
  const quality = QUALITY_TYPES.has(String(raw.quality || '').toLowerCase())
    ? String(raw.quality).toLowerCase()
    : 'any';
  const sort = SORT_TYPES.has(String(raw.sort || '').toLowerCase())
    ? String(raw.sort).toLowerCase()
    : 'relevance';
  const peopleMode = PEOPLE_MODES.has(String(raw.peopleMode || '').toLowerCase())
    ? String(raw.peopleMode).toLowerCase()
    : 'any';

  return {
    query,
    mustTerms: uniqueStrings(raw.mustTerms, 8),
    shouldTerms: uniqueStrings(raw.shouldTerms, 12),
    excludeTerms: uniqueStrings(raw.excludeTerms, 6),
    people: uniqueStrings(raw.people, 6, 40),
    peopleMode,
    photographers: uniqueStrings(raw.photographers, 4, 40),
    projects: uniqueStrings(raw.projects, 4, 60),
    timelineSections: uniqueStrings(raw.timelineSections, 4, 60),
    mediaType,
    quality,
    dateFrom: normalizeDate(raw.dateFrom),
    dateTo: normalizeDate(raw.dateTo),
    sort,
  };
}

function heuristicPhotoSearchPlan(query) {
  const original = String(query || '').replace(/^\s*(?:ai|智能)\s*[:：]\s*/i, '').trim().slice(0, 160);
  let mediaType = 'all';
  if (/(?:只要|只看|仅看|搜索|找).{0,4}(?:视频|录像)|\bvideo\b/i.test(original)) mediaType = 'video';
  else if (/(?:只要|只看|仅看).{0,4}(?:照片|图片|相片)|\bimage\b|\bphoto\b/i.test(original)) mediaType = 'image';

  let quality = 'any';
  if (/(?:不推荐|废片|淘汰|拒绝|较差)/.test(original)) quality = 'rejected';
  else if (/(?:中等|普通|一般|尚可)/.test(original)) quality = 'medium';
  else if (/(?:推荐|精选|最好|最佳|高质量|适合.{0,3}(?:头图|封面))/.test(original)) quality = 'recommended';

  let sort = 'relevance';
  if (/(?:最新|最近|刚上传)/.test(original)) sort = 'newest';
  else if (/(?:质量最高|最好看|最佳|精选)/.test(original)) sort = 'quality';

  const peopleMode = /(?:一起|同框|同时出现|和|与|跟)/.test(original) ? 'all' : 'any';
  const excludeTerms = [];
  original.replace(/(?:不要|排除|不含|去掉)([\u4e00-\u9fffA-Za-z0-9_-]{1,12})/g, (_, term) => {
    excludeTerms.push(term.replace(/(?:的)?(?:照片|图片|视频)$/g, ''));
    return _;
  });
  const cleaned = original
    .replace(/(?:帮我|请|麻烦)?(?:找|搜索|检索|查找|看看|看一下|给我)/g, ' ')
    .replace(/(?:只要|只看|仅看|一些|一张|几张|所有|相关|里面|画面中|照片|图片|相片|视频|录像)/g, ' ')
    .replace(/(?:推荐|精选|最好|最佳|高质量|中等|普通|一般|尚可|不推荐|废片|淘汰|拒绝|较差|最新|最近|刚上传)/g, ' ')
    .replace(/(?:不要|排除|不含|去掉)[\u4e00-\u9fffA-Za-z0-9_-]{1,12}/g, ' ')
    .replace(/[，。！？；、,!?;|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const terms = uniqueStrings(cleaned.split(' '), 8);
  const hasStructuredConstraint = mediaType !== 'all' || quality !== 'any' || sort !== 'relevance' || excludeTerms.length > 0;
  if (!terms.length && original && !hasStructuredConstraint) terms.push(original);

  return normalizePhotoSearchPlan({ mustTerms: terms, excludeTerms, mediaType, quality, sort, peopleMode }, original);
}

function shouldUseAiPhotoSearch(query, enabled = true) {
  if (!enabled) return false;
  const raw = String(query || '').trim();
  if (!raw || /^\s*(?:快速|普通)\s*[:：]/.test(raw)) return false;
  if (/^\s*(?:ai|智能)\s*[:：]/i.test(raw)) return true;
  if (raw.length >= 5 && !/^[\w.-]+$/i.test(raw)) return true;
  return /(?:帮我|请找|适合|包含|出现|同时|不要|排除|最好|最新|推荐|中等|不推荐|摄影师|相册|环节|拍摄|人物|同框)/.test(raw);
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

function getClientConfig() {
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY || '';
  const baseURL = process.env.DASHSCOPE_BASE_URL || process.env.AI_TEXT_BASE_URL || undefined;
  const model = process.env.AI_SEARCH_MODEL || process.env.AI_TEXT_MODEL || 'deepseek-chat';
  return { apiKey, baseURL, model };
}

function cacheGet(key) {
  const row = cache.get(key);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    cache.delete(key);
    return null;
  }
  cache.delete(key);
  cache.set(key, row);
  return row.value;
}

function cacheSet(key, value) {
  cache.delete(key);
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function callSearchModel(query) {
  const { apiKey, baseURL, model } = getClientConfig();
  if (!apiKey) throw new Error('AI_TEXT_API_KEY_NOT_CONFIGURED');
  const client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });
  const system = [
    '你是高校活动图库的搜索查询解析器。只输出一个 JSON 对象，不要解释。',
    `今天是 ${new Date().toISOString().slice(0, 10)}，可据此换算用户明确说出的相对日期。`,
    '不要编造具体人物、相册、日期或摄影师；只抽取用户明确表达的约束。',
    '字段固定为 mustTerms, shouldTerms, excludeTerms, people, peopleMode, photographers, projects, timelineSections, mediaType, quality, dateFrom, dateTo, sort。',
    'mustTerms 是必须在标题、画面描述、AI标签或OCR中命中的核心可见内容，每项应为短词；不要放人物姓名、摄影师、相册或环节。',
    'shouldTerms 是同义词和视觉相关词，用于扩大召回与排序，最多 8 个；例如“发言”可扩展“演讲、讲台、麦克风”。',
    'excludeTerms 是用户明确不要的内容。people 是明确的人名；多人要求同框时 peopleMode=all，否则 any。',
    'mediaType 只能是 all/image/video；quality 只能是 any/recommended/medium/rejected；sort 只能是 relevance/newest/quality。',
    'dateFrom/dateTo 只能是 YYYY-MM-DD 或 null。没有信息的数组给 []，枚举字段使用默认 all/any/relevance。',
  ].join('\n');
  const request = client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(query || '').slice(0, 160) },
    ],
    temperature: 0.1,
    max_tokens: 600,
  });
  const response = await Promise.race([
    request,
    new Promise((_, reject) => setTimeout(() => reject(new Error('AI_SEARCH_TIMEOUT')), REQUEST_TIMEOUT_MS)),
  ]);
  const parsed = parseJsonObject(response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '');
  if (!parsed) throw new Error('AI_SEARCH_INVALID_JSON');
  return { plan: normalizePhotoSearchPlan(parsed, query), model };
}

async function interpretPhotoSearch(query, options = {}) {
  const heuristic = heuristicPhotoSearchPlan(query);
  if (!shouldUseAiPhotoSearch(query, options.enableAi !== false)) {
    return { plan: heuristic, aiUsed: false, cached: false, fallbackReason: null, model: null };
  }

  const cfg = getClientConfig();
  if (!cfg.apiKey) {
    return { plan: heuristic, aiUsed: false, cached: false, fallbackReason: 'not_configured', model: null };
  }
  const key = `${cfg.model}:${String(query || '').trim().toLowerCase()}`;
  const cached = cacheGet(key);
  if (cached) return { ...cached, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const task = callSearchModel(query)
    .then(({ plan, model }) => {
      const value = { plan, aiUsed: true, cached: false, fallbackReason: null, model };
      cacheSet(key, value);
      return value;
    })
    .catch((error) => ({
      plan: heuristic,
      aiUsed: false,
      cached: false,
      fallbackReason: String(error && error.message ? error.message : 'model_failed').slice(0, 80),
      model: null,
    }))
    .finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

function describePhotoSearchPlan(plan, matchedPeople = []) {
  const chips = [];
  const people = uniqueStrings((matchedPeople || []).map((p) => p.name), 6, 40);
  if (people.length) chips.push(`人物：${people.join('、')}`);
  if (plan.mustTerms.length) chips.push(`内容：${plan.mustTerms.join('、')}`);
  if (plan.projects.length) chips.push(`相册：${plan.projects.join('、')}`);
  if (plan.timelineSections.length) chips.push(`环节：${plan.timelineSections.join('、')}`);
  if (plan.photographers.length) chips.push(`摄影师：${plan.photographers.join('、')}`);
  if (plan.mediaType === 'image') chips.push('只看照片');
  if (plan.mediaType === 'video') chips.push('只看视频');
  if (plan.quality === 'recommended') chips.push('AI 推荐');
  if (plan.quality === 'medium') chips.push('中等');
  if (plan.quality === 'rejected') chips.push('不推荐');
  if (plan.dateFrom || plan.dateTo) chips.push(`日期：${plan.dateFrom || '不限'} 至 ${plan.dateTo || '不限'}`);
  if (plan.excludeTerms.length) chips.push(`排除：${plan.excludeTerms.join('、')}`);
  return chips.slice(0, 8);
}

module.exports = {
  describePhotoSearchPlan,
  heuristicPhotoSearchPlan,
  interpretPhotoSearch,
  normalizePhotoSearchPlan,
  shouldUseAiPhotoSearch,
};
