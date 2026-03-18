// AI adapter for news generation.
// Behavior:
// - If a text-model API key (OPENAI_API_KEY or AI_TEXT_API_KEY) is present, call the text model.
// - Otherwise fall back to the local mock implementation.

const { OpenAI } = require('openai');

function mockGenerate(prompt) {
  const title = (prompt.split('\n')[0] || '新闻标题').slice(0, 80);
  const subtitle = '';
  const markdown = `# ${title}\n\n导语：这是 AI 自动生成的导语（示例）。\n\n正文：根据提供的信息生成的正文内容...\n\n(注：此为模拟输出，接入实际模型后将替换)`;
  const html = markdown.replace(/\n/g, '<br/>');
  const placeholders = [];
  const tokens = Math.min(2000, Math.max(100, Math.floor(markdown.length / 2)));
  const cost = tokens * 0.00001;
  return { title, subtitle, markdown, html, placeholders, tokens, cost };
}

function tryParseJsonFromString(input) {
  if (!input || typeof input !== 'string') return null;
  const s = input.trim();
  if (!s) return null;

  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return JSON.parse(s);
    } catch (e) {
      // continue
    }
  }

  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(s.slice(first, last + 1));
    } catch (e) {
      // continue
    }
  }

  return null;
}

function fixNestedMarkdown(md) {
  if (!md) return md;
  return md.replace(/!\[([^\]]*?)\]\(\s*([^\)]*?)\s*\)/g, (full, outerAlt, inner) => {
    try {
      const dec = decodeURIComponent(inner);
      const candidate = dec.indexOf('![') >= 0 ? dec : inner;
      const nested = candidate.match(/!\[([^\]]*?)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/);
      if (!nested) return full;
      const url = nested[2];
      const alt = outerAlt && outerAlt.trim() ? outerAlt.trim() : (nested[1] || '');
      return `![${alt}](${url})`;
    } catch (e) {
      return full;
    }
  });
}

function extractPhotosFromMarkdown(md) {
  const photos = [];
  const re = /!\[([^\]]*?)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;
  let m;
  let id = 1;
  while ((m = re.exec(md)) !== null) {
    photos.push({ id: String(id++), url: m[2], alt: m[1] || '' });
  }
  return photos;
}

function extractPlaceholdersFromMarkdown(md) {
  const placeholders = [];
  const re = /!\[(.*?)\]\(PHOTO:([^)]+)\)/g;
  let m;
  while ((m = re.exec(md)) !== null) {
    placeholders.push({ id: String(m[2]), alt: (m[1] || '').trim() });
  }
  return placeholders;
}

function dedupePhotoPlaceholders(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const seen = new Set();
  const out = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/!\[(.*?)\]\(PHOTO:([^)]+)\)/);
    if (!m) {
      out.push(line);
      continue;
    }

    const id = String(m[2]);
    const next = lines[i + 1] || '';
    const captionLineMatch = next.match(/^\s*图题[:：]\s*(.+)$/);

    if (seen.has(id)) {
      if (captionLineMatch) i += 1;
      continue;
    }

    seen.add(id);
    out.push(line);
    if (captionLineMatch) i += 1;
  }

  return out.join('\n').trim();
}

async function generateFromPrompt({ prompt, options }) {
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY || null;
  const model = process.env.AI_TEXT_MODEL || 'gpt-3.5-turbo';

  if (!apiKey) {
    return mockGenerate(prompt);
  }

  try {
    const baseURL = process.env.DASHSCOPE_BASE_URL || process.env.AI_TEXT_BASE_URL || undefined;
    const client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });

    const systemPrompt = [
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
      '9) 不要输出解释、注释或代码块。'
    ].join('\n');

    const callOptions = {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1600
    };

    const maxAttempts = parseInt(process.env.AI_JSON_MAX_ATTEMPTS || '3', 10);
    const timeoutMs = parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '15000', 10);

    let resp = null;
    let content = null;
    let parsed = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const call = client.chat.completions.create(callOptions);
        resp = await Promise.race([
          call,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
        ]);
        content = resp?.choices?.[0]?.message?.content;
        const str = typeof content === 'string' ? content : String(content || '');
        parsed = tryParseJsonFromString(str);
        if (parsed) break;
      } catch (e) {
        if (attempt >= maxAttempts) {
          console.error('[ai_for_news] text model call failed after retries:', e && e.stack ? e.stack : e);
          resp = null;
          content = null;
        }
      }
    }

    const selectedMap = (options && Array.isArray(options.selectedPhotos))
      ? options.selectedPhotos.reduce((acc, p) => {
        acc[String(p.id)] = p;
        return acc;
      }, {})
      : {};

    let markdown = '';
    const placeholders = [];

    if (parsed && typeof parsed === 'object' && parsed.markdown && Array.isArray(parsed.photos)) {
      markdown = String(parsed.markdown || '');
      (parsed.photos || []).forEach((p) => {
        const id = String(p.id || p.ID || '');
        if (!id) return;
        const selected = selectedMap[id] || {};
        placeholders.push({
          id,
          url: p.url || selected.thumbUrl || null,
          alt: p.alt || p.caption || '',
          photographerId: p.photographerId || selected.photographerId || null
        });
      });
    } else {
      let str = typeof content === 'string' ? content : String(content || '');
      str = str.replace(/\n?ImageCaptions:\n([\s\S]*?)$/i, '');
      str = fixNestedMarkdown(str);
      markdown = dedupePhotoPlaceholders(str);

      const phs = extractPlaceholdersFromMarkdown(markdown);
      phs.forEach((p) => {
        const id = String(p.id);
        const selected = selectedMap[id] || {};
        placeholders.push({
          id,
          url: selected.thumbUrl || null,
          alt: p.alt || '',
          photographerId: selected.photographerId || null
        });
      });

      const imgs = extractPhotosFromMarkdown(markdown);
      imgs.forEach((img) => {
        placeholders.push({
          id: img.id,
          url: img.url,
          alt: img.alt,
          photographerId: null
        });
      });
    }

    const title = (markdown.split('\n')[0] || '新闻标题').replace(/^#\s*/, '').slice(0, 80);
    const subtitle = '';
    const html = markdown.replace(/\n/g, '<br/>');

    let tokens = null;
    let cost = null;
    if (resp && resp.usage) tokens = resp.usage.total_tokens || null;

    return { title, subtitle, markdown, html, placeholders, tokens, cost };
  } catch (e) {
    console.error('[ai_for_news] text model call failed, falling back to mock:', e && e.stack ? e.stack : e);
    return mockGenerate(prompt);
  }
}

module.exports = { generateFromPrompt };
