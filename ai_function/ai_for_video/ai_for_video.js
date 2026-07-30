const { OpenAI } = require('openai');

const MAX_SOURCES = 60;
const MAX_CLIPS = 80;
const MAX_PROJECTS = 20;

function clamp(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function cleanText(value, max = 500) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function compactTemporalSegments(input, max = 12) {
  const source = Array.isArray(input) ? input : [];
  const normalized = source.map((segment) => ({
    start: clamp(segment && segment.start, 0, 4 * 60 * 60),
    end: clamp(segment && segment.end, 0, 4 * 60 * 60),
    summary: cleanText(segment && segment.summary, 180),
    scene: cleanText(segment && segment.scene, 120),
    eventStage: cleanText(segment && segment.eventStage, 120),
    tags: (Array.isArray(segment && segment.tags) ? segment.tags : []).map((tag) => cleanText(tag, 32)).filter(Boolean).slice(0, 8),
    keyObjects: (Array.isArray(segment && segment.keyObjects) ? segment.keyObjects : []).map((item) => cleanText(item, 64)).filter(Boolean).slice(0, 6),
    visibleText: (Array.isArray(segment && segment.visibleText) ? segment.visibleText : []).map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 6),
    actions: (Array.isArray(segment && segment.actions) ? segment.actions : []).map((action) => cleanText(action, 48)).filter(Boolean).slice(0, 4),
    keyMoment: Boolean(segment && segment.keyMoment),
  })).filter((segment) => segment.end - segment.start >= 0.05);
  if (normalized.length <= max) return normalized;
  const selected = new Map();
  normalized.filter((segment) => segment.keyMoment).slice(0, Math.ceil(max / 2)).forEach((segment) => selected.set(`${segment.start}-${segment.end}`, segment));
  for (let index = 0; selected.size < max && index < max; index += 1) {
    const sourceIndex = Math.round((index / Math.max(1, max - 1)) * (normalized.length - 1));
    const segment = normalized[sourceIndex];
    selected.set(`${segment.start}-${segment.end}`, segment);
  }
  return Array.from(selected.values()).sort((left, right) => left.start - right.start).slice(0, max);
}

function normalizeSources(input) {
  return (Array.isArray(input) ? input : [])
    .map((item, index) => ({
      id: cleanText(item && item.id, 120) || `source-${index + 1}`,
      name: cleanText(item && item.name, 200) || `素材 ${index + 1}`,
      duration: clamp(item && item.duration, 0, 4 * 60 * 60),
      description: cleanText(item && item.description, 500),
      projectId: cleanText(item && item.projectId, 120),
      projectName: cleanText(item && item.projectName, 200),
      timelineSectionName: cleanText(item && item.timelineSectionName, 160),
      photographerName: cleanText(item && item.photographerName, 120),
      createdAt: cleanText(item && item.createdAt, 80),
      aiScore: Number.isFinite(Number(item && item.aiScore)) ? Number(item.aiScore) : null,
      aiQuality: cleanText(item && item.aiQuality, 80),
      analysis: item && item.analysis && typeof item.analysis === 'object' ? {
        summary: cleanText(item.analysis.summary, 240),
        semanticStatus: cleanText(item.analysis.semanticStatus, 24),
        coverage: item.analysis.coverage && typeof item.analysis.coverage === 'object' ? {
          duration: clamp(item.analysis.coverage.duration, 0, 4 * 60 * 60),
          segmentCount: clamp(item.analysis.coverage.segmentCount, 0, 48),
          visualSegments: clamp(item.analysis.coverage.visualSegments, 0, 48),
        } : null,
        global: item.analysis.global && typeof item.analysis.global === 'object' ? {
          title: cleanText(item.analysis.global.title, 120),
          description: cleanText(item.analysis.global.description, 360),
          summary: cleanText(item.analysis.global.summary, 360),
          detailedSummary: cleanText(item.analysis.global.detailedSummary, 900),
          event: cleanText(item.analysis.global.event, 160),
          setting: cleanText(item.analysis.global.setting, 160),
          tags: (Array.isArray(item.analysis.global.tags) ? item.analysis.global.tags : []).map((tag) => cleanText(tag, 32)).filter(Boolean).slice(0, 12),
          keyEntities: (Array.isArray(item.analysis.global.keyEntities) ? item.analysis.global.keyEntities : []).map((item) => cleanText(item, 100)).filter(Boolean).slice(0, 12),
          visibleText: (Array.isArray(item.analysis.global.visibleText) ? item.analysis.global.visibleText : []).map((item) => cleanText(item, 120)).filter(Boolean).slice(0, 12),
          searchTerms: (Array.isArray(item.analysis.global.searchTerms) ? item.analysis.global.searchTerms : []).map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 20),
          keyMoments: compactTemporalSegments(item.analysis.global.keyMoments, 8),
        } : null,
        segments: compactTemporalSegments(item.analysis.segments, 12),
        scenes: (Array.isArray(item.analysis.scenes) ? item.analysis.scenes : []).slice(0, 80).map((scene) => ({
          start: clamp(scene.start, 0, 4 * 60 * 60), end: clamp(scene.end, 0, 4 * 60 * 60), duration: clamp(scene.duration, 0, 600),
        })),
        silences: (Array.isArray(item.analysis.silences) ? item.analysis.silences : []).slice(0, 80).map((silence) => ({
          start: clamp(silence.start, 0, 4 * 60 * 60), end: clamp(silence.end, 0, 4 * 60 * 60),
        })),
      } : null,
      tags: (Array.isArray(item && item.tags) ? item.tags : [])
        .map((tag) => cleanText(tag, 40))
        .filter(Boolean)
        .slice(0, 12),
    }))
    .filter((item) => item.duration > 0.15);
}

function normalizeProjects(input) {
  return (Array.isArray(input) ? input : []).slice(0, MAX_PROJECTS).map((project, index) => ({
    id: cleanText(project && project.id, 120) || `project-${index + 1}`,
    name: cleanText(project && project.name, 200) || `项目 ${index + 1}`,
    description: cleanText(project && project.description, 500),
    eventDate: cleanText(project && project.eventDate, 80),
    tags: (Array.isArray(project && project.tags) ? project.tags : []).map((tag) => cleanText(tag, 40)).filter(Boolean).slice(0, 12),
  }));
}

function interleaveSourcesByProject(sources) {
  const groups = new Map();
  sources.forEach((source, index) => {
    const group = source.projectId || `local-${index}`;
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(source);
  });
  const queues = Array.from(groups.values());
  const interleaved = [];
  let offset = 0;
  while (interleaved.length < sources.length) {
    queues.forEach((queue) => { if (queue[offset]) interleaved.push(queue[offset]); });
    offset += 1;
  }
  return interleaved;
}

function heuristicRoughCut({ sources, projects = [], brief, targetDuration, style, aspectRatio }) {
  const target = clamp(targetDuration || 45, 5, 600);
  const clipLength = style === 'dynamic' ? 3.2 : style === 'documentary' ? 7 : style === 'social' ? 4.2 : 5;
  const clips = [];
  let total = 0;
  let round = 0;

  while (total < target - 0.1 && clips.length < MAX_CLIPS && round < 20) {
    let added = false;
    for (let index = 0; index < sources.length && total < target - 0.1; index += 1) {
      const source = sources[index];
      const usable = Math.min(clipLength, target - total, source.duration);
      if (usable < 0.35) continue;
      const maxStart = Math.max(0, source.duration - usable);
      const ratio = ((round * 0.37) + (index * 0.19)) % 0.92;
      const semanticSegments = source.analysis && Array.isArray(source.analysis.segments) ? source.analysis.segments : [];
      const semanticCandidates = semanticSegments.filter((segment) => segment.keyMoment || (segment.actions && segment.actions.length) || segment.summary);
      const semantic = semanticCandidates.length ? semanticCandidates[(round + index) % semanticCandidates.length] : null;
      const scene = source.analysis && source.analysis.scenes && source.analysis.scenes[(round + index) % source.analysis.scenes.length];
      const start = semantic
        ? Math.min(maxStart, Math.max(0, semantic.start))
        : scene ? Math.min(maxStart, Math.max(0, scene.start)) : Math.min(maxStart, maxStart * ratio);
      const end = Math.min(source.duration, start + usable);
      clips.push({
        sourceId: source.id,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        speed: 1,
        transition: clips.length ? (style === 'dynamic' ? 'flash' : 'dissolve') : 'none',
        reason: (semantic && semantic.summary) || source.description || `${source.projectName ? `${source.projectName} · ` : ''}${source.name} 的代表性片段`,
      });
      total += end - start;
      added = true;
    }
    if (!added) break;
    round += 1;
  }

  return {
    title: cleanText(brief, 60) || 'AI 粗剪方案',
    summary: `${projects.length ? `综合 ${projects.map((project) => project.name).join('、')}，` : ''}按${style === 'dynamic' ? '快节奏' : style === 'documentary' ? '纪实叙事' : style === 'social' ? '社交媒体' : '均衡'}节奏跨项目轮选素材，生成约 ${Math.round(total)} 秒初剪。`,
    targetDuration: target,
    aspectRatio: aspectRatio || '16:9',
    clips,
    captions: [],
    musicMood: style === 'dynamic' ? '节奏明快' : style === 'documentary' ? '克制、温暖' : '轻快自然',
    notes: ['当前使用本地规则粗剪；配置 AI_TEXT_API_KEY 后将由大模型按语义重新编排。'],
  };
}

function extractJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (e) { /* continue */ }
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch (e) { /* continue */ }
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (e) { /* ignore */ }
  }
  return null;
}

function normalizePlan(rawPlan, sources, fallbackInput) {
  const sourceMap = new Map(sources.map((source) => [String(source.id), source]));
  const clips = [];
  (Array.isArray(rawPlan && rawPlan.clips) ? rawPlan.clips : []).slice(0, MAX_CLIPS).forEach((clip) => {
    const source = sourceMap.get(String(clip && clip.sourceId));
    if (!source) return;
    const start = clamp(clip.start, 0, source.duration);
    const end = clamp(clip.end, start, source.duration);
    if (end - start < 0.15) return;
    clips.push({
      sourceId: source.id,
      start: Number(start.toFixed(2)),
      end: Number(end.toFixed(2)),
      speed: clamp(clip.speed || 1, 0.25, 4),
      transition: ['none', 'cut', 'dissolve', 'fade', 'flash'].includes(clip.transition) ? clip.transition : 'cut',
      reason: cleanText(clip.reason, 240),
    });
  });
  if (!clips.length) return heuristicRoughCut({ ...fallbackInput, sources });

  return {
    title: cleanText(rawPlan.title, 100) || cleanText(fallbackInput.brief, 60) || 'AI 粗剪方案',
    summary: cleanText(rawPlan.summary, 500),
    targetDuration: clamp(rawPlan.targetDuration || fallbackInput.targetDuration || 45, 5, 600),
    aspectRatio: ['16:9', '9:16', '1:1', '4:3'].includes(rawPlan.aspectRatio) ? rawPlan.aspectRatio : (fallbackInput.aspectRatio || '16:9'),
    clips,
    captions: (Array.isArray(rawPlan.captions) ? rawPlan.captions : []).slice(0, 30).map((caption) => ({
      at: clamp(caption && caption.at, 0, 600),
      text: cleanText(caption && caption.text, 120),
    })).filter((caption) => caption.text),
    musicMood: cleanText(rawPlan.musicMood, 120),
    notes: (Array.isArray(rawPlan.notes) ? rawPlan.notes : []).map((note) => cleanText(note, 180)).filter(Boolean).slice(0, 8),
  };
}

async function generateRoughCut(input = {}) {
  const sources = interleaveSourcesByProject(normalizeSources(input.sources)).slice(0, MAX_SOURCES);
  if (!sources.length) {
    const error = new Error('至少需要一个包含时长的视频素材');
    error.status = 400;
    throw error;
  }
  const request = {
    projects: normalizeProjects(input.projects),
    sources,
    brief: cleanText(input.brief, 2000),
    targetDuration: clamp(input.targetDuration || 45, 5, 600),
    style: ['balanced', 'dynamic', 'documentary', 'social'].includes(input.style) ? input.style : 'balanced',
    aspectRatio: ['16:9', '9:16', '1:1', '4:3'].includes(input.aspectRatio) ? input.aspectRatio : '16:9',
  };

  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY || '';
  if (!apiKey) {
    return { provider: 'heuristic', model: null, plan: heuristicRoughCut(request) };
  }

  const model = process.env.AI_VIDEO_MODEL || process.env.AI_TEXT_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const baseURL = process.env.AI_TEXT_BASE_URL || process.env.DASHSCOPE_BASE_URL || undefined;
  const client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });
  const system = [
    '你是专业视频粗剪导演。根据素材元数据与用户目标生成结构化剪辑方案。',
    '只返回 JSON 对象，不要 Markdown。不得虚构 sourceId，不得给出超出素材时长的入点/出点。',
    '优先建立开场、发展、高潮、收束的叙事；避免连续重复同一素材，除非只有一个素材。',
    '若提供多个 projects，结合项目名称、日期、标签和描述建立跨项目叙事，并尽量平衡各项目的代表性镜头。',
    '素材可能包含 projectName、timelineSectionName、photographerName、aiScore、aiQuality，以及 analysis.global / analysis.segments 的全程时间线语义；应优先依照这些真实时间段内容选取片段，不要只按视频开头或单张封面判断。',
    'clips 每项字段：sourceId,start,end,speed,transition,reason。transition 只能是 none/cut/dissolve/fade/flash。',
    '根字段：title,summary,targetDuration,aspectRatio,clips,captions,musicMood,notes。',
    'captions 每项字段：at,text。总片段数不超过 80。',
  ].join('\n');
  const response = await client.chat.completions.create({
    model,
    temperature: 0.25,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: JSON.stringify(request) },
    ],
  });
  const content = response && response.choices && response.choices[0] && response.choices[0].message
    ? response.choices[0].message.content
    : '';
  const parsed = extractJson(content);
  if (!parsed) throw new Error('模型未返回有效的粗剪 JSON');
  return { provider: 'model', model, plan: normalizePlan(parsed, sources, request) };
}

module.exports = { generateRoughCut, heuristicRoughCut, normalizePlan };
