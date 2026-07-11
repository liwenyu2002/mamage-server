// AI 创作矩阵 - 生成后事实校验 + 图说生成（纯规则，不调模型）
// 约束：宁可漏报不可误报刷屏（每类 issue 上限 5 条），无法可靠定位的一律跳过。
// 约束：中文分词没有天然边界，姓名候选窗口必须锚定在已知 personNames 的长度上，
//       不能用贪婪正则从任意起点向前扫，否则会把无关字吞进候选名（如"活动由李明"）。

const TITLE_WORDS = ['校长', '书记', '主任', '教授'];

function levenshtein(a, b) {
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  const dp = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) dp[j] = j;
  for (let i = 1; i <= al; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= bl; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[bl];
}

// 职务词位置向前取窗口，窗口长度只在"目标姓名长度 ±1"里试，避免吞入无关汉字
function detectNameIssues(markdown, personNames) {
  const issues = [];
  if (!markdown || !Array.isArray(personNames) || personNames.length === 0) return issues;
  const titleRe = new RegExp(`(?:副)?(?:${TITLE_WORDS.join('|')})`, 'g');
  let m;
  while ((m = titleRe.exec(markdown))) {
    if (issues.length >= 5) break;
    const titlePos = m.index;
    const before = markdown.slice(Math.max(0, titlePos - 5), titlePos);
    let exactFound = false;
    let bestCandidate = null;
    let bestMatch = null;
    let bestDist = Infinity;
    for (const name of personNames) {
      if (!name || name.length < 2) continue;
      const lens = new Set([name.length, name.length - 1, name.length + 1].filter((l) => l >= 2 && l <= before.length));
      for (const len of lens) {
        const candidate = before.slice(before.length - len);
        if (!/^[一-龥]+$/.test(candidate)) continue;
        if (candidate === name) { exactFound = true; break; }
        const dist = levenshtein(candidate, name);
        if (dist === 1 && dist < bestDist) {
          bestDist = dist;
          bestCandidate = candidate;
          bestMatch = name;
        }
      }
      if (exactFound) break;
    }
    if (exactFound || !bestCandidate) continue; // 精确匹配到人名，或找不到一字之差的疑似项 -> 不报
    const start = Math.max(0, titlePos - 8);
    const end = Math.min(markdown.length, titlePos + m[0].length + 8);
    issues.push({
      type: 'name',
      expect: bestMatch,
      found: bestCandidate + m[0],
      snippet: markdown.slice(start, end),
    });
  }
  return issues;
}

// 支持 "2026-07-10" / "2026/7/10" / "2026年7月10日" / "2026" 几种表单日期写法
function parseFormDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  let m = s.match(/(\d{1,4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (m) return { year: +m[1], month: +m[2], day: +m[3] };
  m = s.match(/(\d{1,4})[-\/年](\d{1,2})月?$/);
  if (m) return { year: +m[1], month: +m[2] };
  m = s.match(/^(\d{4})$/);
  if (m) return { year: +m[1] };
  return null; // 解析不了就跳过比对，避免误报
}

function parseMdDateParts(str) {
  const parts = {};
  let m = str.match(/(\d{1,4})年/);
  if (m) parts.year = +m[1];
  m = str.match(/(\d{1,2})月/);
  if (m) parts.month = +m[1];
  m = str.match(/(\d{1,2})日/);
  if (m) parts.day = +m[1];
  return parts;
}

function detectDateIssues(markdown, eventDate) {
  const issues = [];
  if (!markdown || !eventDate) return issues;
  const formParts = parseFormDate(eventDate);
  if (!formParts) return issues;
  const DATE_RE = /\d{1,4}年\d{1,2}月\d{1,2}日|\d{1,4}年\d{1,2}月|\d{1,2}月\d{1,2}日|\d{1,4}年(?!级|度)/g;
  let m;
  const seen = new Set();
  while ((m = DATE_RE.exec(markdown))) {
    if (issues.length >= 5) break;
    const matched = m[0];
    if (seen.has(matched)) continue;
    const mdParts = parseMdDateParts(matched);
    let mismatch = false;
    for (const key of ['year', 'month', 'day']) {
      if (formParts[key] !== undefined && mdParts[key] !== undefined && formParts[key] !== mdParts[key]) {
        mismatch = true;
        break;
      }
    }
    if (mismatch) {
      seen.add(matched);
      const start = Math.max(0, m.index - 8);
      const end = Math.min(markdown.length, m.index + matched.length + 8);
      issues.push({
        type: 'date',
        expect: String(eventDate),
        found: matched,
        snippet: markdown.slice(start, end),
      });
    }
  }
  return issues;
}

// 弱提醒：表单地点没在正文任何位置出现过，不代表一定错，仅提示复核
function detectLocationIssue(markdown, location) {
  if (!markdown || !location) return [];
  const loc = String(location).trim();
  if (!loc) return [];
  if (markdown.indexOf(loc) !== -1) return [];
  return [{ type: 'location', expect: loc, found: '', snippet: '' }];
}

function extractNumberContexts(text) {
  const out = [];
  if (!text) return out;
  const str = String(text);
  const re = /\d{2,}/g;
  let m;
  while ((m = re.exec(str))) {
    const num = m[0];
    const start = m.index;
    const before = str.slice(Math.max(0, start - 6), start).replace(/[，,。.\s]/g, '');
    const after = str.slice(start + num.length, start + num.length + 6).replace(/[，,。.\s]/g, '');
    out.push({ number: num, before, after });
  }
  return out;
}

// 用表单数字左右各 6 字的文字做锚点去正文里定位同一处描述，锚点找不到就跳过（宁可漏报）
function detectNumberIssues(markdown, form) {
  const issues = [];
  if (!markdown || !form) return issues;
  const sources = [form.participants, form.highlights].filter(Boolean);
  for (const src of sources) {
    const contexts = extractNumberContexts(src);
    for (const ctx of contexts) {
      if (issues.length >= 5) return issues;
      const usingBefore = ctx.before.length >= 2;
      const anchor = usingBefore ? ctx.before : ctx.after;
      if (!anchor || anchor.length < 2) continue;
      const anchorIdx = markdown.indexOf(anchor);
      if (anchorIdx === -1) continue;
      let windowStart;
      let windowEnd;
      if (usingBefore) {
        windowStart = anchorIdx + anchor.length;
        windowEnd = Math.min(markdown.length, windowStart + 20);
      } else {
        windowEnd = anchorIdx;
        windowStart = Math.max(0, windowEnd - 20);
      }
      const windowText = markdown.slice(windowStart, windowEnd);
      const foundMatch = windowText.match(/\d+/);
      if (foundMatch && foundMatch[0] !== ctx.number) {
        issues.push({
          type: 'number',
          expect: ctx.number,
          found: foundMatch[0],
          snippet: markdown.slice(Math.max(0, anchorIdx - 10), Math.min(markdown.length, anchorIdx + anchor.length + 20)),
        });
      }
    }
  }
  return issues;
}

function checkFacts({ markdown, form, personNames } = {}) {
  const md = String(markdown || '');
  const f = form || {};
  const names = Array.isArray(personNames) ? personNames : [];
  const issues = [
    ...detectNameIssues(md, names),
    ...detectDateIssues(md, f.eventDate),
    ...detectLocationIssue(md, f.location),
    ...detectNumberIssues(md, f),
  ];
  return { issues };
}

// 禁用词全量命中（企业预设 forbidden_words 生成后校验），不设上限 —— 命中即需要拦截，不是"提示"
function checkForbiddenWords(markdown, forbiddenWords) {
  const md = String(markdown || '');
  const words = Array.isArray(forbiddenWords) ? forbiddenWords : [];
  const hits = [];
  for (const raw of words) {
    const word = String(raw || '').trim();
    if (!word) continue;
    let idx = md.indexOf(word);
    while (idx !== -1) {
      const start = Math.max(0, idx - 10);
      const end = Math.min(md.length, idx + word.length + 10);
      hits.push({ word, index: idx, snippet: md.slice(start, end) });
      idx = md.indexOf(word, idx + word.length);
    }
  }
  return { hits };
}

function buildCaption(photo) {
  const p = photo || {};
  const names = Array.isArray(p.personNames) ? p.personNames.filter(Boolean) : [];
  let caption = '图为';
  if (names.length) {
    caption += names.slice(0, 3).join('、') + (names.length > 3 ? '等' : '');
  }
  if (p.sectionName) {
    caption += '在' + String(p.sectionName).trim() + '环节';
  }
  const descPart = String(p.description || '').trim().slice(0, 20).replace(/。/g, '');
  caption += descPart;
  const photographerSuffix = p.photographerName ? `（摄影：${String(p.photographerName).trim()}）` : '';
  let full = caption + photographerSuffix;
  if (full.length > 50) {
    // 超长优先保留摄影署名，压缩前面的描述部分
    const maxCaptionLen = Math.max(0, 50 - photographerSuffix.length);
    full = caption.slice(0, maxCaptionLen) + photographerSuffix;
    if (full.length > 50) full = full.slice(0, 50); // 极端兜底，防止署名本身超长
  }
  return full;
}

function generateCaptions({ photos } = {}) {
  const list = Array.isArray(photos) ? photos : [];
  return list.map((p) => ({ photoId: p && p.id, caption: buildCaption(p) }));
}

module.exports = { checkFacts, checkForbiddenWords, generateCaptions };
