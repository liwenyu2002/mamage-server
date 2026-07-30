const { OpenAI } = require('openai');
const { callOllamaGenerate, parseVisionResponse } = require('../ai_for_tags/ai_for_tags');

const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:3b';

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return 'dashscope';
  if (raw === 'local' || raw === 'ollama' || raw === 'qwen' || raw === 'qwen-local') return 'ollama';
  if (raw === 'dashscope' || raw === 'aliyun' || raw === 'cloud') return 'dashscope';
  if (raw === 'off' || raw === 'disabled' || raw === 'none') return 'off';
  return raw;
}

function visionProvider() {
  return normalizeProvider(process.env.VIDEO_SEMANTIC_VISION_PROVIDER || process.env.AI_VISION_PROVIDER || process.env.VISION_PROVIDER || 'dashscope');
}

function fallbackProvider(primary) {
  const fallback = normalizeProvider(process.env.VIDEO_SEMANTIC_VISION_FALLBACK_PROVIDER || process.env.AI_VISION_FALLBACK_PROVIDER || '');
  return fallback && fallback !== primary && fallback !== 'off' ? fallback : null;
}

function visionModel(provider) {
  if (provider === 'ollama') {
    return process.env.OLLAMA_VISION_MODEL || process.env.LOCAL_VISION_MODEL || DEFAULT_OLLAMA_MODEL;
  }
  return process.env.VIDEO_SEMANTIC_VISION_MODEL || process.env.AI_VISION_MODEL || 'qwen-vl-max';
}

function extractJson(raw) {
  const source = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  if (!source) return null;
  try {
    const parsed = JSON.parse(source);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {}
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(source.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function normalizedList(value, max = 8, itemLimit = 32) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[，,、]/) : [];
  return Array.from(new Set(values
    .map((item) => {
      const raw = item && typeof item === 'object'
        ? (item.name || item.label || item.text || item.value || '')
        : item;
      return cleanText(raw, itemLimit).replace(/[\[\]{}"']/g, '');
    })
    .filter(Boolean))).slice(0, max);
}

function normalizeSegmentResult(raw) {
  const structured = extractJson(raw) || {};
  const legacy = parseVisionResponse(raw);
  const summary = cleanText(structured.summary || structured.description || structured.caption || legacy.description, 220);
  const keyObjects = normalizedList(structured.keyObjects || structured.objects || structured.entities, 8, 64);
  const visibleText = normalizedList(structured.visibleText || structured.ocrText || structured.textOnScreen || structured.ocr, 8, 120);
  const tags = Array.from(new Set([
    ...(legacy.tags || []),
    ...normalizedList(structured.tags, 10),
    ...normalizedList(structured.standardTags, 10),
    ...normalizedList(structured.customTags, 4),
    ...keyObjects,
  ])).slice(0, 12);
  const peopleCount = Number.isFinite(Number(structured.peopleCount))
    ? clamp(Math.round(Number(structured.peopleCount)), 0, 99)
    : null;
  return {
    summary: summary || null,
    scene: cleanText(structured.scene || structured.sceneContext || structured.setting, 120) || null,
    eventStage: cleanText(structured.eventStage || structured.stage || structured.event, 120) || null,
    tags,
    keyObjects,
    visibleText,
    actions: normalizedList(structured.actions || structured.events || structured.keyActions, 5, 48),
    evidence: normalizedList(structured.evidence || structured.reasoningEvidence || structured.visualEvidence, 4, 140),
    peopleCount,
    keyMoment: Boolean(structured.keyMoment || structured.highlight || structured.eventMoment),
    confidence: Number.isFinite(Number(structured.confidence))
      ? Number(clamp(Number(structured.confidence), 0, 1).toFixed(2))
      : null,
  };
}

function formatTime(value) {
  const seconds = Math.max(0, Math.floor(Number(value) || 0));
  const hour = Math.floor(seconds / 3600);
  const minute = Math.floor((seconds % 3600) / 60);
  const second = seconds % 60;
  return hour > 0
    ? `${hour}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`
    : `${minute}:${String(second).padStart(2, '0')}`;
}

function temporalPrompt(context = {}) {
  const start = formatTime(context.start);
  const end = formatTime(context.end);
  const sampleTimes = (Array.isArray(context.sampleTimes) ? context.sampleTimes : []).map(formatTime).join('、');
  return [
    '你是高校融媒体视频语义分析助手。图片是同一条视频同一时间段内按时间从左到右排列的连续画面，不是一张静态照片。',
    `本段覆盖 ${start} 至 ${end}，抽样时间为 ${sampleTimes || '段内连续时刻'}。必须结合三帧之间的变化判断正在发生的动作、人物关系和事件进展；不要只描述其中一帧。`,
    '只根据可见内容判断，不猜测人物身份、学校或未展示的事实。看得清的屏幕、横幅、物体文字必须如实抄录；看不清就不要补全。',
    '后续要用于视频检索和剪辑：物体必须尽可能写具体名称。只有存在清晰文字或明确画面证据时，才能把“红色箱子”等泛称写成具体物品；否则保留客观泛称。',
    '动作只写本时间段内实际发生的动作，不得把上一段或下一段的动作、标签复制进来。',
    '必须只返回一个 JSON 对象，不要 Markdown，不要解释。',
    '字段固定为：summary, scene, eventStage, standardTags, customTags, keyObjects, visibleText, actions, evidence, peopleCount, keyMoment, confidence。',
    'summary：35-100 字中文，完整描述这一时间段的连续事件或画面变化。',
    'scene：0-1 条场景事实，如“团代会正式会议会场”；无法判断时为空字符串。',
    'eventStage：0-1 条可见的会议或活动环节，如“讲台发言”“展示空投票箱”；无法判断时为空字符串。',
    'standardTags：从常用客观标签中选 0-8 个，例如 室内、室外、人物、单人、多人、演讲、交流、鼓掌、讲座、庆典、运动、合影、白天、黑夜、中景、全景。',
    'customTags：0-3 个具体且客观可见的中文短标签，不能写泛词。',
    'keyObjects：0-6 个关键物体或场景实体。物体上有清晰标识时使用该名称，如“投票箱”；不要写猜测。',
    'visibleText：0-6 个画面中可辨认的文字短语，按原文抄录，不能凭语境补全。',
    'actions：0-4 个简短动作或事件词，如 发言、上台、颁奖、互动、合影、行走；没有明显变化给空数组。',
    'evidence：0-3 条支撑结论的可见证据短句，例如“箱体侧面可见‘投票箱’字样”。',
    'peopleCount：可见真人大致数量；完全无法判断时写 null。不要把屏幕、海报、麦克风、影子或局部肢体当作人。',
    'keyMoment：只有信息量、动作或情绪明显更强、适合剪辑选段时才为 true。',
    'confidence：0 到 1 之间的小数。',
  ].join('\n');
}

function extractOpenAIMessageText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content.trim();
  if (Array.isArray(message.content)) {
    return message.content.map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part.text === 'string') return part.text;
      if (part && typeof part.output_text === 'string') return part.output_text;
      return '';
    }).join('').trim();
  }
  return String(message.content || '').trim();
}

async function analyzeWithProvider(provider, storyboardJpeg, context) {
  if (provider === 'off') return { available: false, provider: 'off', model: null, ...normalizeSegmentResult('') };
  const prompt = temporalPrompt(context);
  if (provider === 'ollama') {
    const raw = await callOllamaGenerate(prompt, storyboardJpeg.toString('base64'));
    return { available: true, provider, model: visionModel(provider), raw, ...normalizeSegmentResult(raw) };
  }
  if (provider === 'dashscope') {
    const apiKey = process.env.AI_VISION_API_KEY || process.env.DASHSCOPE_API_KEY;
    if (!apiKey) throw new Error('Missing AI_VISION_API_KEY or DASHSCOPE_API_KEY in environment');
    const model = visionModel(provider);
    const client = new OpenAI({ apiKey, baseURL: process.env.DASHSCOPE_BASE_URL || DEFAULT_DASHSCOPE_BASE_URL });
    const response = await client.chat.completions.create({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: '你只输出有效 JSON。' },
        {
          role: 'user',
          content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${storyboardJpeg.toString('base64')}` } },
          ],
        },
      ],
    });
    const raw = extractOpenAIMessageText(response && response.choices && response.choices[0] && response.choices[0].message);
    return { available: true, provider, model, raw, ...normalizeSegmentResult(raw) };
  }
  throw new Error(`Unsupported VIDEO_SEMANTIC_VISION_PROVIDER: ${provider}`);
}

function isVisionEnabled() {
  return visionProvider() !== 'off';
}

async function analyzeTemporalStoryboard(storyboardJpeg, context = {}) {
  const primary = visionProvider();
  try {
    return await analyzeWithProvider(primary, storyboardJpeg, context);
  } catch (error) {
    const fallback = fallbackProvider(primary);
    if (!fallback) throw error;
    console.warn(`[video-semantic] ${primary} failed, fallback to ${fallback}:`, error && error.message ? error.message : error);
    return analyzeWithProvider(fallback, storyboardJpeg, context);
  }
}

function deterministicTimelineSummary(segments, duration) {
  const descriptive = (segments || []).map((segment) => cleanText(segment.summary, 80)).filter(Boolean);
  const tags = Array.from(new Set((segments || []).flatMap((segment) => Array.isArray(segment.tags) ? segment.tags : []))).slice(0, 12);
  const keyEntities = Array.from(new Set((segments || []).flatMap((segment) => Array.isArray(segment.keyObjects) ? segment.keyObjects : []))).slice(0, 12);
  const visibleText = Array.from(new Set((segments || []).flatMap((segment) => Array.isArray(segment.visibleText) ? segment.visibleText : []))).slice(0, 12);
  const eventStages = (segments || []).map((segment) => cleanText(segment.eventStage, 100)).filter(Boolean);
  const keyMoments = (segments || []).filter((segment) => segment.keyMoment || (segment.actions && segment.actions.length)).slice(0, 8).map((segment) => ({
    start: segment.start,
    end: segment.end,
    summary: cleanText(segment.summary, 120),
    actions: normalizedList(segment.actions, 4, 48),
  }));
  const prefix = `全片覆盖 ${formatTime(duration)}，共理解 ${(segments || []).length} 个连续时段`;
  const narrative = (segments || []).map((segment) => {
    const range = `${formatTime(segment.start)}-${formatTime(segment.end)}`;
    const text = cleanText(segment.summary || segment.eventStage || segment.scene, 160);
    return text ? `${range}｜${text}` : '';
  }).filter(Boolean).slice(0, 8);
  const detailedSummary = cleanText([
    prefix,
    ...narrative,
    keyEntities.length ? `关键实体：${keyEntities.join('、')}` : '',
    visibleText.length ? `可见文字：${visibleText.join('、')}` : '',
  ].filter(Boolean).join('；'), 900);
  return {
    title: '',
    description: cleanText([prefix, ...descriptive.slice(0, 3)].filter(Boolean).join('；'), 500),
    summary: cleanText(descriptive.slice(0, 4).join('；') || prefix, 500),
    detailedSummary,
    event: cleanText(eventStages[0], 160),
    setting: cleanText((segments || []).map((segment) => segment.scene).find(Boolean), 160),
    tags,
    keyEntities,
    visibleText,
    searchTerms: Array.from(new Set([...tags, ...keyEntities, ...eventStages, ...((segments || []).flatMap((segment) => segment.actions || []))])).slice(0, 20),
    keyMoments,
    narrative,
    provider: 'heuristic',
    model: null,
  };
}

async function summarizeTemporalTimeline({ segments, duration, hasAudio, silences, allowModel = true }) {
  const fallback = deterministicTimelineSummary(segments, duration);
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!allowModel || !apiKey || !segments.some((segment) => segment.summary)) return fallback;
  const model = process.env.AI_VIDEO_MODEL || process.env.AI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.AI_TEXT_BASE_URL || process.env.DASHSCOPE_BASE_URL || undefined;
  const client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });
  const compactSegments = segments.map((segment) => ({
    start: Number(segment.start.toFixed(2)),
    end: Number(segment.end.toFixed(2)),
    summary: cleanText(segment.summary, 160),
    scene: cleanText(segment.scene, 100),
    eventStage: cleanText(segment.eventStage, 100),
    tags: normalizedList(segment.tags, 8),
    keyObjects: normalizedList(segment.keyObjects, 6, 64),
    visibleText: normalizedList(segment.visibleText, 6, 120),
    actions: normalizedList(segment.actions, 4),
    evidence: normalizedList(segment.evidence, 3, 140),
    keyMoment: Boolean(segment.keyMoment),
    confidence: Number.isFinite(Number(segment.confidence)) ? Number(segment.confidence) : null,
  }));
  try {
    const response = await client.chat.completions.create({
      model,
      temperature: 0.15,
      messages: [
        {
          role: 'system',
          content: [
            '你是高校融媒体视频编辑与事实核验员。根据覆盖整段视频的带证据时间线，生成可用于归档、检索和智能剪辑的详细总语义；不能编造。',
            '只返回 JSON：title(8-32字), description(50-140字), summary(不超过180字), detailedSummary(120-360字), event(0-80字), setting(0-80字), tags(0-16个中文短标签), keyEntities(0-12个具体实体), visibleText(0-12个画面文字短语), searchTerms(0-20个检索词), keyMoments([{start,end,summary,reason}]), narrative(0-8条按时间排序的“起止时间｜事件”短句)。',
            '详细总语义必须按时间讲清楚发生了什么、关键物体是什么、其在何时出现及动作如何变化。只能把输入 visibleText 中出现的内容作为“可见文字”；只能把输入 keyObjects 或 evidence 支持的内容写成具体物体或会议环节。',
            '不得把泛称强行具体化，不得把“疑似”写成事实。keyMoments 只能引用给定时段；若不确定则给空数组。',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify({ duration, hasAudio: Boolean(hasAudio), silences: (silences || []).slice(0, 20), segments: compactSegments }) },
      ],
    });
    const raw = extractOpenAIMessageText(response && response.choices && response.choices[0] && response.choices[0].message);
    const parsed = extractJson(raw);
    if (!parsed) return fallback;
    const knownRanges = compactSegments;
    const keyMoments = (Array.isArray(parsed.keyMoments) ? parsed.keyMoments : []).slice(0, 8).map((item) => {
      const start = clamp(item && item.start, 0, duration);
      const end = clamp(item && item.end, start, duration);
      const overlapsSegment = knownRanges.some((segment) => start <= segment.end && end >= segment.start);
      if (!overlapsSegment || end - start < 0.05) return null;
      return {
        start: Number(start.toFixed(3)),
        end: Number(end.toFixed(3)),
        summary: cleanText(item && item.summary, 160),
        reason: cleanText(item && item.reason, 160),
      };
    }).filter(Boolean);
    const tags = normalizedList(parsed.tags, 16);
    const keyEntities = normalizedList(parsed.keyEntities || parsed.entities || parsed.keyObjects, 12, 100);
    const visibleText = normalizedList(parsed.visibleText, 12, 140);
    const searchTerms = normalizedList(parsed.searchTerms, 20, 80);
    const narrative = normalizedList(parsed.narrative, 8, 200);
    const detailedSummary = cleanText(parsed.detailedSummary || parsed.detail || parsed.longSummary, 900) || fallback.detailedSummary;
    return {
      title: cleanText(parsed.title, 80) || fallback.title,
      description: cleanText(parsed.description, 500) || fallback.description,
      summary: cleanText(parsed.summary, 500) || fallback.summary,
      detailedSummary,
      event: cleanText(parsed.event || parsed.eventType, 160) || fallback.event,
      setting: cleanText(parsed.setting || parsed.scene, 160) || fallback.setting,
      tags: tags.length ? tags : fallback.tags,
      keyEntities: keyEntities.length ? keyEntities : fallback.keyEntities,
      visibleText: visibleText.length ? visibleText : fallback.visibleText,
      searchTerms: searchTerms.length ? searchTerms : fallback.searchTerms,
      keyMoments: keyMoments.length ? keyMoments : fallback.keyMoments,
      narrative: narrative.length ? narrative : fallback.narrative,
      provider: 'text-model',
      model,
    };
  } catch (error) {
    console.warn('[video-semantic] timeline summary fallback:', error && error.message ? error.message : error);
    return fallback;
  }
}

module.exports = {
  analyzeTemporalStoryboard,
  deterministicTimelineSummary,
  isVisionEnabled,
  summarizeTemporalTimeline,
};
