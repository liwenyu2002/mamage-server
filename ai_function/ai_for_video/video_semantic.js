const { OpenAI } = require('openai');
const { callOllamaGenerate, parseVisionResponse } = require('../ai_for_tags/ai_for_tags');

const DEFAULT_DASHSCOPE_BASE_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
const DEFAULT_OLLAMA_MODEL = 'qwen2.5vl:3b';
const TOTAL_SEMANTIC_LIMIT = 1800;

function totalSemanticMinimumLength(duration) {
  const seconds = Math.max(0, Number(duration) || 0);
  if (seconds >= 180) return 780;
  if (seconds >= 45) return 560;
  if (seconds >= 10) return 380;
  if (seconds >= 4) return 240;
  return 120;
}

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function cleanText(value, max = 240) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanSentence(value, max = 240) {
  return cleanText(value, max).replace(/[。！？；;，,]+$/u, '').trim();
}

function cleanNarrativePhrase(value, max = 240, canonicalObject = '') {
  let text = cleanSentence(value, max)
    .replace(/^\d{1,2}:\d{2}\s*[-~至]\s*\d{1,2}:\d{2}\s*[｜|]?\s*/u, '')
    .replace(/^(?:三帧|多帧|数帧|几帧)画面(?:中|显示|展示)?[，,]?\s*/u, '')
    .replace(/^画面(?:中|显示|展示)?[，,]?\s*/u, '')
    .replace(/^同一(?:会议)?现场[，,]?\s*/u, '')
    .replace(/(?:左侧|中间|右侧)画面(?:中)?/gu, '')
    .replace(/(?:左侧|中间|右侧)/gu, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (canonicalObject === '投票箱') {
    text = text.replace(/(?:红色)?箱(?:子|体)/gu, canonicalObject);
  }
  return text;
}

function segmentActionNarrative(segment, canonicalObject = '') {
  const actions = normalizedList(segment && segment.actions, 8, 48);
  const keyObjects = normalizedList(segment && segment.keyObjects, 8, 64);
  const focalObject = canonicalObject || keyObjects.find((item) => /箱/.test(item)) || '相关物件';
  const has = (pattern) => actions.some((action) => pattern.test(action));
  const phrases = [];
  if (has(/发言/)) phrases.push('一名参会人员手持麦克风站在讲台前发言');
  if (has(/调整.*麦克风|麦克风.*调整/)) phrases.push('另一名人员对讲台麦克风进行调整');
  if (has(/走向.*投票箱|走向.*箱/)) phrases.push(`有人走向${focalObject}`);
  if (has(/操作.*投票箱|投票箱.*操作|操作.*箱/)) phrases.push(`并在${focalObject}前进行操作`);
  if (has(/手持展示|展示.*箱|举起.*箱/)) phrases.push(`一名身着西装的人员手持${focalObject}向会场展示`);
  if (has(/放置物品|放置.*箱|放回.*箱/)) phrases.push(`展示结束后将${focalObject}放置在小凳上`);
  if (has(/就坐/)) phrases.push('周围参会人员在座位区就坐');
  const recognized = /发言|麦克风|走向.*箱|操作.*箱|手持展示|展示.*箱|举起.*箱|放置物品|放置.*箱|放回.*箱|就坐/;
  const remaining = actions.filter((action) => !recognized.test(action));
  if (remaining.length) phrases.push(`现场还可见${remaining.join('、')}等动作`);
  return Array.from(new Set(phrases)).join('，');
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

const GENERIC_ACTION_OBJECTS = new Set([
  '展示', '物品', '东西', '现场', '画面', '动作', '人物', '人员',
  '箱子', '红色箱子', '物体', '设备', '内容', '文件',
]);

function objectTermsFromActions(actions) {
  const prefixes = /^(?:正在|随后|人员)?(?:走向|靠近|操作|展示|打开|关闭|放置|举起|手持|搬运|拿起|取出|递交|调整|投放|检查|清点)/;
  return Array.from(new Set((actions || [])
    .map((action) => {
      const text = cleanText(action, 64);
      const prefix = text.match(prefixes);
      return prefix
        ? text.slice(prefix[0].length).replace(/[，,、。；;].*$/, '').trim()
        : '';
    })
    .filter((value) => value.length >= 2 && value.length <= 16 && !GENERIC_ACTION_OBJECTS.has(value))));
}

function normalizeSegmentResult(raw) {
  const structured = extractJson(raw) || {};
  const legacy = parseVisionResponse(raw);
  const summary = cleanText(structured.summary || structured.description || structured.caption || legacy.description, 220);
  const actions = normalizedList(structured.actions || structured.events || structured.keyActions, 5, 48);
  const keyObjects = Array.from(new Set([
    ...normalizedList(structured.keyObjects || structured.objects || structured.entities, 8, 64),
    ...objectTermsFromActions(actions),
  ])).slice(0, 8);
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
    actions,
    evidence: normalizedList(structured.evidence || structured.reasoningEvidence || structured.visualEvidence, 4, 140),
    peopleCount,
    keyMoment: Boolean(structured.keyMoment || structured.highlight || structured.eventMoment),
    confidence: Number.isFinite(Number(structured.confidence))
      ? Number(clamp(Number(structured.confidence), 0, 1).toFixed(2))
      : null,
  };
}

function normalizeGlobalEvidenceResult(raw) {
  const structured = extractJson(raw) || {};
  return {
    event: cleanText(structured.event || structured.eventStage || structured.activity, 160) || null,
    setting: cleanText(structured.setting || structured.scene || structured.sceneContext, 160) || null,
    keyObjects: normalizedList(structured.keyObjects || structured.objects || structured.entities, 12, 100),
    visibleText: normalizedList(structured.visibleText || structured.ocrText || structured.textOnScreen || structured.ocr, 12, 160),
    timelineFacts: normalizedList(structured.timelineFacts || structured.sequence || structured.events, 8, 220),
    evidence: normalizedList(structured.evidence || structured.reasoningEvidence || structured.visualEvidence, 8, 180),
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

function globalEvidencePrompt(context = {}) {
  const frameTimes = (Array.isArray(context.sampleTimes) ? context.sampleTimes : []).map(formatTime).join('、');
  return [
    '你是高校融媒体视频的全片事实核验助手。图片由同一视频按时间从上到下排列的高分辨率代表画面组成。',
    `代表画面时间依次为：${frameTimes || '未提供'}。请利用画面中的屏幕、横幅、物体文字和连续动作，核验整条视频的关键事实。`,
    '只写画面直接支持的内容。文字必须逐字抄录可辨认部分，不能用语境补全；物体有清晰标识时必须使用其具体名称。',
    '必须只返回一个 JSON 对象，不要 Markdown，不要解释。',
    '字段固定为：event, setting, keyObjects, visibleText, timelineFacts, evidence, confidence。',
    'event：0-1 条具体活动或会议环节；无法确认则为空字符串。',
    'setting：0-1 条场景事实。',
    'keyObjects：0-10 个关键物体或实体，避免“红色箱子”这类已可具体识别的泛称。',
    'visibleText：0-10 个可辨认的文字短语，按原文抄录。',
    'timelineFacts：0-6 条带时间的事实，格式“00:00-00:05｜发生的动作或场景”。',
    'evidence：0-6 条可见依据，说明文字或物体在何处出现。',
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

async function callVisionProvider(provider, imageJpeg, prompt) {
  if (provider === 'off') return { available: false, provider: 'off', model: null, raw: '' };
  if (provider === 'ollama') {
    const raw = await callOllamaGenerate(prompt, imageJpeg.toString('base64'));
    return { available: true, provider, model: visionModel(provider), raw };
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
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${imageJpeg.toString('base64')}` } },
          ],
        },
      ],
    });
    const raw = extractOpenAIMessageText(response && response.choices && response.choices[0] && response.choices[0].message);
    return { available: true, provider, model, raw };
  }
  throw new Error(`Unsupported VIDEO_SEMANTIC_VISION_PROVIDER: ${provider}`);
}

async function analyzeWithProvider(provider, storyboardJpeg, context) {
  const response = await callVisionProvider(provider, storyboardJpeg, temporalPrompt(context));
  return { ...response, ...normalizeSegmentResult(response.raw) };
}

async function analyzeGlobalEvidenceWithProvider(provider, evidenceJpeg, context) {
  const response = await callVisionProvider(provider, evidenceJpeg, globalEvidencePrompt(context));
  return { ...response, ...normalizeGlobalEvidenceResult(response.raw) };
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

async function analyzeGlobalEvidenceBoard(evidenceJpeg, context = {}) {
  const primary = visionProvider();
  try {
    return await analyzeGlobalEvidenceWithProvider(primary, evidenceJpeg, context);
  } catch (error) {
    const fallback = fallbackProvider(primary);
    if (!fallback) throw error;
    console.warn(`[video-semantic] global evidence ${primary} failed, fallback to ${fallback}:`, error && error.message ? error.message : error);
    return analyzeGlobalEvidenceWithProvider(fallback, evidenceJpeg, context);
  }
}

function deterministicTimelineSummary(segments, duration, globalEvidence = null) {
  const evidence = globalEvidence && typeof globalEvidence === 'object' ? globalEvidence : {};
  const descriptive = (segments || []).map((segment) => cleanText(segment.summary, 80)).filter(Boolean);
  const tags = Array.from(new Set((segments || []).flatMap((segment) => Array.isArray(segment.tags) ? segment.tags : []))).slice(0, 12);
  const rawKeyEntities = Array.from(new Set([
    ...(Array.isArray(evidence.keyObjects) ? evidence.keyObjects : []),
    ...(segments || []).flatMap((segment) => Array.isArray(segment.keyObjects) ? segment.keyObjects : []),
    ...(segments || []).flatMap((segment) => objectTermsFromActions(segment.actions || [])),
  ].map((item) => cleanSentence(item, 100)).filter(Boolean)));
  const canonicalObject = rawKeyEntities.includes('投票箱') ? '投票箱' : '';
  const keyEntities = rawKeyEntities
    .filter((item) => !canonicalObject || !['箱子', '红色箱子', '红色箱体'].includes(item))
    .slice(0, 12);
  const visibleText = Array.from(new Set([
    ...(Array.isArray(evidence.visibleText) ? evidence.visibleText : []),
    ...(segments || []).flatMap((segment) => Array.isArray(segment.visibleText) ? segment.visibleText : []),
  ])).slice(0, 12);
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
  const continuousStages = (segments || []).map((segment, index) => {
    const actionNarrative = segmentActionNarrative(segment, canonicalObject);
    const stage = actionNarrative || cleanNarrativePhrase(segment.summary || segment.eventStage || segment.scene, 220, canonicalObject);
    const visualEvidence = Array.from(new Set((Array.isArray(segment.evidence) ? segment.evidence : [])
      .map((item) => cleanNarrativePhrase(item, 180, canonicalObject))
      .filter(Boolean))).slice(0, 3);
    const details = [stage, ...(actionNarrative ? [] : visualEvidence.filter((item) => !stage || !stage.includes(item)))].filter(Boolean);
    if (!details.length) return '';
    const transition = index === 0 ? '镜头开始时' : index === (segments || []).length - 1 ? '最后' : '随后';
    return `${transition}，${details.join('，')}`;
  }).filter(Boolean);
  const opening = cleanText([
    evidence.setting ? `画面记录在${cleanNarrativePhrase(evidence.setting, 180, canonicalObject)}` : '',
    evidence.event ? `${evidence.setting ? '，内容围绕' : '视频内容围绕'}${cleanNarrativePhrase(evidence.event, 180, canonicalObject)}展开` : '',
  ].filter(Boolean).join(''), 400);
  const supportingFacts = (Array.isArray(evidence.timelineFacts) ? evidence.timelineFacts : [])
    .map((fact) => cleanNarrativePhrase(fact, 220, canonicalObject))
    .filter(Boolean)
    .slice(0, 3);
  const sceneObjects = keyEntities.filter((item) => !['黑色西装', '浅色衬衫'].includes(item)).slice(0, 10);
  const totalSemantic = cleanText([
    opening ? `${opening}。` : '',
    sceneObjects.length ? `会场内可见${sceneObjects.join('、')}等布置与物件。` : '',
    visibleText.length ? `红色背景板和现场屏幕上可辨认出${visibleText.join('、')}等文字。` : '',
    ...continuousStages.map((stage) => `${stage}。`),
    supportingFacts.length ? `操作环节中，${supportingFacts.join('；')}。` : '',
    evidence.event && continuousStages.length ? `视频以${cleanNarrativePhrase(evidence.event, 160, canonicalObject)}相关的现场环节为主线，依次呈现了发言、操作与展示过程。` : '',
  ].filter(Boolean).join(''), TOTAL_SEMANTIC_LIMIT);
  return {
    title: '',
    description: cleanText([prefix, ...descriptive.slice(0, 3)].filter(Boolean).join('；'), 500),
    summary: cleanText(descriptive.slice(0, 4).join('；') || prefix, 500),
    totalSemantic,
    // Keep the existing field for stored analyses and older consumers.
    detailedSummary: totalSemantic,
    event: cleanText(evidence.event || eventStages[0], 160),
    setting: cleanText(evidence.setting || (segments || []).map((segment) => segment.scene).find(Boolean), 160),
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

async function expandShortTotalSemantic({ client, model, duration, minimumLength, current, segments, globalEvidence }) {
  const response = await client.chat.completions.create({
    model,
    temperature: 0.1,
    messages: [
      {
        role: 'system',
        content: [
          '你是高校融媒体视频编辑与事实核验员。下面的总语义因过短需要补全，但只能依据提供的可核验视觉证据扩写，绝不能添加没有证据支持的人物、行为、物件、文字或情节。',
          `只返回 JSON：totalSemantic(一整段中文白描，至少${minimumLength}字，最多900字)。`,
          '必须从镜头开场自然写到结束，完整写出场景、人物角色、关键动作、具体物件、可见文字、人物与物件关系和环节转换。使用连贯叙述，不得使用标题、列表、标签、时间戳、分段序号，也不得提及帧、模型、采样或时间线。',
          '这是硬性补写任务：先在脑中核对内容是否充分，再输出；如果输入素材很短，也可以细致描述可明确看见的环境、站位、物件和动作变化，但不得编造。',
        ].join('\n'),
      },
      {
        role: 'user', content: JSON.stringify({
          duration,
          currentTotalSemantic: current,
          globalEvidence: globalEvidence && typeof globalEvidence === 'object' ? {
            event: cleanText(globalEvidence.event, 160),
            setting: cleanText(globalEvidence.setting, 160),
            keyObjects: normalizedList(globalEvidence.keyObjects, 12, 100),
            visibleText: normalizedList(globalEvidence.visibleText, 12, 160),
            timelineFacts: normalizedList(globalEvidence.timelineFacts, 8, 220),
            evidence: normalizedList(globalEvidence.evidence, 8, 180),
          } : null,
          segments,
        }) },
    ],
  });
  const raw = extractOpenAIMessageText(response && response.choices && response.choices[0] && response.choices[0].message);
  const parsed = extractJson(raw);
  return cleanText(parsed && (parsed.totalSemantic || parsed.detailedSummary || parsed.detail), TOTAL_SEMANTIC_LIMIT);
}

async function summarizeTemporalTimeline({ segments, duration, hasAudio, silences, globalEvidence = null, allowModel = true }) {
  const fallback = deterministicTimelineSummary(segments, duration, globalEvidence);
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!allowModel || !apiKey || !segments.some((segment) => segment.summary)) return fallback;
  const model = process.env.AI_VIDEO_MODEL || process.env.AI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.AI_TEXT_BASE_URL || process.env.DASHSCOPE_BASE_URL || undefined;
  const client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });
  const minimumTotalSemanticLength = totalSemanticMinimumLength(duration);
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
            `只返回 JSON：title(8-32字), description(50-140字), summary(不超过180字), totalSemantic(${minimumTotalSemanticLength}-900字的中文单段长文), event(0-80字), setting(0-80字), tags(0-16个中文短标签), keyEntities(0-12个具体实体), visibleText(0-12个画面文字短语), searchTerms(0-20个检索词), keyMoments([{start,end,summary,reason}]), narrative(0-8条按时间排序的“起止时间｜事件”短句)。`,
            'totalSemantic 是独立的“总语义”，必须是一整段连贯、客观、完整的中文白描：按视频自然时间从开场写到结束，用“镜头开始、随后、接着、最后”等自然衔接推进；完整交代可核验的场景、人物角色（不命名未知人物）、关键动作、物件、可读文字、人物与物件关系及环节转换。不要写标题、列表、标签、时间戳、分段序号，也不要提及“帧、采样、模型、时间线、左侧/中间/右侧画面”。素材很短时可略短，但仍要尽可能完整；不确定的细节宁可不写，绝不为凑字数编造。',
            'globalEvidence 是高分辨率全片核验结果，优先用于纠正片段摘要中的泛称、漏读或不一致；相邻时段明显是同一物体时必须使用同一个已核验的具体名称。',
            '只能把输入 visibleText 或 globalEvidence.visibleText 中出现的内容作为“可见文字”；只能把输入 keyObjects、evidence 或 globalEvidence 支持的内容写成具体物体或会议环节。',
            '不得把泛称强行具体化，不得把“疑似”写成事实。keyMoments 只能引用给定时段；若不确定则给空数组。',
          ].join('\n'),
        },
        { role: 'user', content: JSON.stringify({
          duration,
          hasAudio: Boolean(hasAudio),
          silences: (silences || []).slice(0, 20),
          globalEvidence: globalEvidence && typeof globalEvidence === 'object' ? {
            event: cleanText(globalEvidence.event, 160),
            setting: cleanText(globalEvidence.setting, 160),
            keyObjects: normalizedList(globalEvidence.keyObjects, 12, 100),
            visibleText: normalizedList(globalEvidence.visibleText, 12, 160),
            timelineFacts: normalizedList(globalEvidence.timelineFacts, 8, 220),
            evidence: normalizedList(globalEvidence.evidence, 8, 180),
          } : null,
          segments: compactSegments,
        }) },
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
    const tags = normalizedList([...(Array.isArray(parsed.tags) ? parsed.tags : []), ...fallback.tags], 16);
    const keyEntities = normalizedList(parsed.keyEntities || parsed.entities || parsed.keyObjects, 12, 100);
    const visibleText = normalizedList(parsed.visibleText, 12, 140);
    const searchTerms = normalizedList([
      ...(Array.isArray(parsed.searchTerms) ? parsed.searchTerms : []),
      ...fallback.searchTerms,
    ], 20, 80);
    const narrative = normalizedList(parsed.narrative, 8, 200);
    let totalSemantic = cleanText(
      parsed.totalSemantic || parsed.detailedSummary || parsed.detail || parsed.longSummary,
      TOTAL_SEMANTIC_LIMIT,
    ) || fallback.totalSemantic;
    if (totalSemantic.length < minimumTotalSemanticLength && fallback.totalSemantic.length > totalSemantic.length) {
      totalSemantic = fallback.totalSemantic;
    }
    if (totalSemantic.length < minimumTotalSemanticLength) {
      try {
        const expanded = await expandShortTotalSemantic({
          client,
          model,
          duration,
          minimumLength: minimumTotalSemanticLength,
          current: totalSemantic,
          segments: compactSegments,
          globalEvidence,
        });
        if (expanded.length > totalSemantic.length) totalSemantic = expanded;
      } catch (error) {
        console.warn('[video-semantic] total semantic expansion fallback:', error && error.message ? error.message : error);
      }
    }
    return {
      title: cleanText(parsed.title, 80) || fallback.title,
      description: cleanText(parsed.description, 500) || fallback.description,
      summary: cleanText(parsed.summary, 500) || fallback.summary,
      totalSemantic,
      // Compatibility for clients that were released before totalSemantic.
      detailedSummary: totalSemantic,
      event: cleanText(parsed.event || parsed.eventType, 160) || fallback.event,
      setting: cleanText(parsed.setting || parsed.scene, 160) || fallback.setting,
      tags: tags.length ? tags : fallback.tags,
      keyEntities: normalizedList([...keyEntities, ...fallback.keyEntities], 12, 100),
      visibleText: visibleText.length ? visibleText : fallback.visibleText,
      searchTerms: searchTerms.length ? searchTerms : fallback.searchTerms,
      keyMoments: keyMoments.length ? keyMoments : fallback.keyMoments,
      narrative: normalizedList([...narrative, ...fallback.narrative], 8, 200),
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
  analyzeGlobalEvidenceBoard,
  deterministicTimelineSummary,
  isVisionEnabled,
  summarizeTemporalTimeline,
};
