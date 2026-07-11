// Prompt 组装回归测试（golden test）。
//
// 为什么需要它：ai_for_news.js / routes/ai_news.js 要为"渠道模板"改造 systemPrompt / assemblePrompt
// 的组装逻辑，但 press_release（新闻稿）默认路径——即调用方不传 channelName/channelTemplate 的旧路径，
// 例如现有 POST /api/ai/news/generate——必须与改造前逐字节一致，否则线上新闻稿的生成质量会在无感知的
// 情况下漂移。本脚本用一份写死的"现状"实现（下方 legacy* 系列函数/常量，是重构前源码的冻结副本）生成
// 一次快照文件；此后每次运行都改为调用重构后的真实导出函数，与快照逐字节比对。
//
// 用法：
//   node scripts/test_prompt_golden.js            // 快照不存在则生成；存在则校验
//   node scripts/test_prompt_golden.js --bootstrap // 强制重新生成快照（仅在明确要更新基准时用）

const fs = require('fs');
const path = require('path');

const GOLDEN_DIR = path.join(__dirname, '__golden__');
const GOLDEN_FILE = path.join(GOLDEN_DIR, 'press_release.txt');
const MAX_REFERENCE_CHARS = 20000; // 与 routes/ai_news.js 常量保持一致

// ---------------------------------------------------------------------------
// 固定输入：字段齐全（含摄影师署名、人物姓名、参考资料、采访记录），覆盖 assemblePrompt 的所有分支。
// ---------------------------------------------------------------------------
const FORM = {
  eventName: '2026 校园科技节开幕式',
  eventDate: '2026-07-11',
  location: '主楼报告厅',
  organizer: '校团委',
  participants: '全体师生代表约300人',
  highlights: '揭幕仪式、机器人巡游、学生作品展',
  usage: '官网新闻稿',
  tone: '正式',
  targetWords: '800',
};

const SELECTED_PHOTOS = [
  {
    id: 'p1',
    description: '嘉宾致辞',
    tags: ['开幕式', '致辞'],
    projectTitle: '2026科技节',
    faceNames: ['张校长', '李主任'],
    photographerId: 'ph1',
    photographerName: '王摄影',
  },
  {
    id: 'p2',
    description: '机器人巡游现场',
    tags: ['机器人', '巡游'],
    projectTitle: '2026科技节',
    personNames: ['陈同学'],
    photographerId: 'ph2',
    photographerName: '赵摄影',
  },
];

const REFERENCE_ARTICLE = '往届科技节报道：2025年科技节吸引了超过500名师生参与，现场设置了20余个展位。';
const INTERVIEW_TEXT = '采访记录：张校长表示，本届科技节是校庆七十周年系列活动的重要组成部分。';

// ---------------------------------------------------------------------------
// legacy* 系列：重构前 routes/ai_news.js 与 ai_function/ai_for_news/ai_for_news.js 中
// assemblePrompt / systemPrompt 构造逻辑的冻结副本，只用于第一次生成快照，此后不再被调用。
// 禁止在重构时"顺手"修改这里——它就是要保持不变的历史真相。
// ---------------------------------------------------------------------------
function legacyToNameList(input) {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : String(input).split(/[;,|]/);
  const out = [];
  raw.forEach((v) => {
    const s = String(v || '').trim();
    if (!s) return;
    if (out.includes(s)) return;
    out.push(s);
  });
  return out;
}

function legacyExtractPersonNames(photo) {
  const direct = legacyToNameList(
    (photo && (
      photo.faceNames
      || photo.personNames
      || photo.personNameList
      || photo.face_name_list
      || photo.person_name_list
      || photo.people
    )) || []
  );
  if (direct.length) return direct;

  const faces = Array.isArray(photo && photo.faces) ? photo.faces : [];
  const names = [];
  faces.forEach((f) => {
    const name = String((f && (f.personName || f.person_name || f.name || f.label)) || '').trim();
    if (!name) return;
    if (names.includes(name)) return;
    names.push(name);
  });
  return names;
}

function legacyAssemblePrompt(form, selectedPhotos, referenceArticle, interviewText) {
  const MAX_PHOTOS = 30;
  const lines = [];
  lines.push(`活动名称：${form.eventName || ''}`);
  lines.push(`时间：${form.eventDate || ''}`);
  lines.push(`地点：${form.location || ''}`);
  lines.push(`主办：${form.organizer || ''}`);
  lines.push(`参与：${form.participants || ''}`);
  lines.push(`亮点：${form.highlights || ''}`);
  lines.push(`用途：${form.usage || ''}；文风：${form.tone || ''}；目标字数：${form.targetWords || ''}`);

  if (selectedPhotos && selectedPhotos.length) {
    lines.push('\n已选图片：');
    selectedPhotos.slice(0, MAX_PHOTOS).forEach((p, idx) => {
      const desc = p.description || '';
      const tags = Array.isArray(p.tags) ? p.tags.join(',') : '';
      const projectTitle = p.projectTitle || p.project || '';
      const personNames = legacyExtractPersonNames(p);
      const peoplePart = personNames.length ? ` (人物:${personNames.join('、')})` : '';
      const photographer = String(p.photographerName || p.photographer_name || '').trim();
      const photographerPart = photographer ? ` (摄影:${photographer})` : '';
      lines.push(`图${idx + 1}：${desc} (tags:${tags}) (projectTitle:${projectTitle})${peoplePart}${photographerPart} -> 占位符 PHOTO:${p.id} (thumb provided)`);
    });
    lines.push('说明：仅使用 PHOTO:<id> 作为图片占位符，不要在正文中输出真实图片 URL。');
    lines.push('说明：可以参考 projectTitle 把握语气与主题，但不要把它当成事实来源直接写入。');
    lines.push('要求：正文中以内嵌方式插入图片，格式必须是 ![图题](PHOTO:<id>)。');
    lines.push('要求：图题为一句话，不超过 20 字，仅描述画面，不包含具体事实信息。');
  }

  if (referenceArticle) {
    lines.push('\n参考资料：');
    lines.push(referenceArticle.slice(0, MAX_REFERENCE_CHARS));
    lines.push('注意：参考资料仅用于学习结构与文风，不可直接引用其中的具体事实。');
  }

  if (interviewText) {
    lines.push('\n采访记录：');
    lines.push(interviewText.slice(0, 5000));
  }

  lines.push('\n请根据以上信息生成一篇新闻稿，包含标题、导语、正文；在正文中按需插入 PHOTO: 占位符；遵守目标字数与文风要求；输出 Markdown。');
  return lines.join('\n');
}

const LEGACY_SYSTEM_PROMPT = [
  '你是一个新闻稿生成助手。',
  '输出要求：',
  '1) 仅输出一个 JSON 对象，字段为 title、subtitle、markdown、photos。',
  '2) markdown 必须是完整新闻稿（标题+导语+正文），并且图片占位必须使用 ![图题](PHOTO:<id>)。',
  '3) 不允许在 markdown 中输出真实图片 URL（http/https）。',
  '4) 图题（即 alt）不超过20字。',
  '5) 如果图片信息里给出了人物名（people/faceNames/personNames），图题必须优先包含对应人物姓名。',
  '6) 没有人名时再写中性图题。',
  '7) photos 数组每项为 {id,url,alt,caption}，url 可为空。',
  '8) 参考资料只可借鉴文风，不可直接引用其事实。',
  '9) 不要输出解释、注释或代码块。',
].join('\n');

function buildSnapshotText() {
  const user = legacyAssemblePrompt(FORM, SELECTED_PHOTOS, REFERENCE_ARTICLE, INTERVIEW_TEXT);
  return `===SYSTEM===\n${LEGACY_SYSTEM_PROMPT}\n===USER===\n${user}\n`;
}

// ---------------------------------------------------------------------------
// 校验模式：调用重构后的真实导出函数（默认路径——不传 channelName/channelTemplate）。
// ---------------------------------------------------------------------------
function buildLiveText() {
  // 延迟 require：bootstrap 模式下重构后的文件可能还没导出这些符号，不应该在那条路径上炸掉。
  const { assemblePrompt } = require('../routes/ai_news.js');
  const { buildSystemPrompt } = require('../ai_function/ai_for_news/ai_for_news.js');

  if (typeof assemblePrompt !== 'function') {
    throw new Error('routes/ai_news.js 未导出 assemblePrompt，无法校验 golden test');
  }
  if (typeof buildSystemPrompt !== 'function') {
    throw new Error('ai_function/ai_for_news/ai_for_news.js 未导出 buildSystemPrompt，无法校验 golden test');
  }

  const liveSystem = buildSystemPrompt({});
  const liveUser = assemblePrompt(FORM, SELECTED_PHOTOS, REFERENCE_ARTICLE, INTERVIEW_TEXT, {});
  return `===SYSTEM===\n${liveSystem}\n===USER===\n${liveUser}\n`;
}

function firstDiffLine(expected, actual) {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) {
      return `第 ${i + 1} 行不一致：\n  期望: ${JSON.stringify(a[i])}\n  实际: ${JSON.stringify(b[i])}`;
    }
  }
  return '(内容长度不同但逐行相同，末尾存在多余/缺失空白)';
}

function main() {
  const forceBootstrap = process.argv.includes('--bootstrap');
  const needBootstrap = forceBootstrap || !fs.existsSync(GOLDEN_FILE);

  if (needBootstrap) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    const snapshot = buildSnapshotText();
    fs.writeFileSync(GOLDEN_FILE, snapshot, 'utf8');
    console.log(`[golden] 快照已写入: ${GOLDEN_FILE} (${snapshot.length} chars)`);
    return;
  }

  const expected = fs.readFileSync(GOLDEN_FILE, 'utf8');
  const actual = buildLiveText();

  if (actual !== expected) {
    console.error('[golden] FAIL: press_release 默认路径（不传 channelName/channelTemplate）与快照不一致');
    console.error(firstDiffLine(expected, actual));
    process.exit(1);
  }

  console.log('[golden] PASS: press_release 默认路径与快照逐字节一致');
}

main();
