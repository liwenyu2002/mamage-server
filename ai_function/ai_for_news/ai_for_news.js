// AI adapter for news generation.
// Behavior:
// - If a text-model API key (OPENAI_API_KEY or AI_TEXT_API_KEY) is present, call the text model.
// - Otherwise fall back to the local mock implementation.

const { OpenAI } = require('openai');

function mockGenerate(prompt) {
  const title = (prompt.split('\n')[0] || '新闻标题').slice(0, 80);
  const subtitle = '';
  const markdown = `# ${title}\n\n导语：这是 AI 自动生成的导语（示例）。\n\n正文：根据提供的信息生成的正文内容...\n\n(注：此为模拟输出，接入实际模型替换此函数)`;
  const html = markdown.replace(/\n/g, '<br/>');
  const placeholders = [];
  const tokens = Math.min(2000, Math.max(100, Math.floor(markdown.length / 2)));
  const cost = tokens * 0.00001;
  return { title, subtitle, markdown, html, placeholders, tokens, cost };
}

async function generateFromPrompt({ prompt, options }) {
  // prefer explicit AI_TEXT_API_KEY, fallback to OPENAI_API_KEY
  const apiKey = process.env.AI_TEXT_API_KEY || process.env.OPENAI_API_KEY || null;
  const model = process.env.AI_TEXT_MODEL || 'gpt-3.5-turbo';

  if (!apiKey) {
    // no key -> use mock
    return mockGenerate(prompt);
  }

  // create OpenAI client and call chat completion
  try {
    const baseURL = process.env.DASHSCOPE_BASE_URL || process.env.AI_TEXT_BASE_URL || undefined;
    const client = baseURL ? new OpenAI({ apiKey, baseURL }) : new OpenAI({ apiKey });

    const callOptions = {
      model: model,
      messages: [
        {
          role: 'system',
          content: `你是一个新闻稿生成助手。目标：根据用户提供的 prompt 生成结构清晰的 Markdown 新闻稿，包含标题、导语和正文。严格遵守以下规则：
1) 输出主体为 Markdown，第一行为标题（以 "# " 开头），随后为导语与正文。
2) 如果 prompt 中包含图片占位符格式 "PHOTO:<id>"，请在正文中以内嵌形式放置图片占位，采用 Markdown 图片语法，格式必须严格为：![图题](PHOTO:<id>)。说明：图片的替代文字（alt text）即为图题，请把图题写成一句话（不超过20字），仅描述画面或意境，不得包含地点、时间、人物姓名或具体数字等事实性信息。前端仅提供缩略图（thumbUrl），占位符应对应缩略图，模型不得在生成结果中插入任何图片 URL（包括原图或缩略图链接）。
3) 不要在文末重复列出所有图片；图片占位应仅代表缩略图并以内嵌形式出现在正文中。示例位置与格式：
段落内容……
![学生在操场进行体能测试](PHOTO:123)
段落继续……
4) 对于每张图片，prompt 中会同时提供该图片所属的 projectTitle；你可以将 projectTitle 作为语气或主题的参考，用以决定配图文案的侧重点，但不得将 projectTitle 中的事实性内容（如地点、时间、具体人物或数字）作为报道事实直接引用。
5) 如用户提供参考文章，仅可参考其格式与文风，绝不可引用或复述参考文中的事实（如地点、时间、事件细节或数字）。
6) 输出不要包含额外的解释、调试信息或多余的注释；正文中以内嵌占位符和紧随其后的图题行表示图片和图题。

额外强制要求：请仅输出一个有效的 JSON 对象，严格遵守如下 schema（示例）：
{
  "title": "稿件标题",
  "subtitle": "副标题，可选",
  "markdown": "完整 Markdown 字符串（图片占位使用 PHOTO:ID，例如 ![图注](PHOTO:123)）",
  "photos": [ { "id": "123", "url": "https://...jpg", "alt": "图注文本", "caption": "可选图注" } ]
}
注意：JSON 必须是响应的唯一输出内容，不能包含额外解释性文字；photos 中的 url 优先为完整 https 链接（如果模型无法提供则可置为空，由后端使用前端传入的 thumbUrl 填充）。若无法生成可用 JSON，请返回 { "title": "", "subtitle":"", "markdown":"", "photos": [] }。`
        },
        { role: 'user', content: prompt }
      ],
      temperature: 0.7,
      max_tokens: 1600
    };

    // retry attempts for JSON-compliant model output
    const maxAttempts = parseInt(process.env.AI_JSON_MAX_ATTEMPTS || '3', 10);

    // helper: try to parse JSON embedded in content string
    function tryParseJsonFromString(s) {
      if (!s || typeof s !== 'string') return null;
      s = s.trim();
      // if it is pure JSON, parse directly
      if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
        try { return JSON.parse(s); } catch (e) { /* continue to extraction */ }
      }
      // try to find first { ... } block
      const first = s.indexOf('{');
      const last = s.lastIndexOf('}');
      if (first >= 0 && last > first) {
        const sub = s.slice(first, last + 1);
        try { return JSON.parse(sub); } catch (e) { /* fallthrough */ }
      }
      return null;
    }

    // helpers for fallback extraction from Markdown
    function fixNestedMarkdown(md) {
      if (!md) return md;
      return md.replace(/!\[([^\]]*?)\]\(\s*([^\)]*?)\s*\)/g, (full, outerAlt, inner) => {
        try {
          const dec = decodeURIComponent(inner);
          const candidate = (dec.indexOf('![') >= 0) ? dec : inner;
          const nested = candidate.match(/!\[([^\]]*?)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/);
          if (nested) {
            const url = nested[2];
            const alt = outerAlt && outerAlt.trim() ? outerAlt.trim() : (nested[1] || '');
            return `![${alt}](${url})`;
          }
        } catch (e) {}
        return full;
      });
    }

    function extractPhotosFromMarkdown(md) {
      const photos = [];
      const re = /!\[([^\]]*?)\]\(\s*(https?:\/\/[^\s)]+)\s*\)/g;
      let m, id = 1;
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

    // attempt loop
    let resp = null;
    let content = null;
    let parsed = null;
    const timeoutMs = parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '15000', 10);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const call = client.chat.completions.create(callOptions);
        resp = await Promise.race([
          call,
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))
        ]);
        content = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
        const str = typeof content === 'string' ? content : String(content || '');
        // try parse JSON
        parsed = tryParseJsonFromString(str);
        if (parsed) break; // success
        // if not parsed, and not last attempt, retry
        if (attempt < maxAttempts) continue;
        // last attempt: leave content for fallback
      } catch (e) {
        // on error, if last attempt, log and fall back
        if (attempt >= maxAttempts) {
          console.error('[ai_for_news] text model call failed after retries:', e && e.stack ? e.stack : e);
          resp = null;
          content = null;
        } else {
          // continue to retry
          continue;
        }
      }
    }

    let resultObj = null;
    if (parsed && typeof parsed === 'object') {
      // basic validation: must contain markdown and photos
      if (parsed.title && parsed.markdown && Array.isArray(parsed.photos)) {
        resultObj = parsed;
      }
    }

    let markdown = '';
    const placeholders = [];
    if (resultObj) {
      // we got good structured JSON from model
      markdown = resultObj.markdown || '';
      // ensure photos entries have url either from model or from options.selectedPhotos mapping
      const selectedMap = (options && Array.isArray(options.selectedPhotos)) ? options.selectedPhotos.reduce((acc, p) => { acc[String(p.id)] = p; return acc; }, {}) : {};
      const photosOut = (resultObj.photos || []).map(p => {
        const id = String(p.id || p.ID || p.id);
        const url = p.url || (selectedMap[id] && selectedMap[id].thumbUrl) || null;
        const photographerId = p.photographerId || (selectedMap[id] && selectedMap[id].photographerId) || null;
        return { id, url, alt: p.alt || p.caption || '', photographerId };
      });
      photosOut.forEach(ph => placeholders.push(ph));
    } else {
      // fallback: treat content as markdown and normalize as before
      let str = typeof content === 'string' ? content : String(content || '');
      try {
        // remove any ImageCaptions block (old format)
        str = str.replace(/\n?ImageCaptions:\n([\s\S]*?)$/i, '');
        // fix nested markdown
        str = fixNestedMarkdown(str);

        // dedupe PHOTO: placeholders
        const lines = str.split(/\r?\n/);
        const seen = new Set();
        const out = [];
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const m = line.match(/!\[(.*?)\]\(PHOTO:([^)]+)\)/);
          if (m) {
            const altCaption = (m[1] || '').trim();
            const id = m[2];
            const next = lines[i+1] || '';
            const captionLineMatch = next.match(/^\s*图题：(.+)$/);
            if (seen.has(id)) {
              if (captionLineMatch) i++;
              continue;
            }
            seen.add(id);
            out.push(line);
            if (captionLineMatch) i++;
          } else {
            out.push(line);
          }
        }
        markdown = out.join('\n').trim();

        // extract placeholders and photos
        const phs = extractPlaceholdersFromMarkdown(markdown);
        const selectedMap = (options && Array.isArray(options.selectedPhotos)) ? options.selectedPhotos.reduce((acc, p) => { acc[String(p.id)] = p; return acc; }, {}) : {};
        phs.forEach(p => {
          const id = String(p.id);
          placeholders.push({ id, url: (selectedMap[id] && selectedMap[id].thumbUrl) || null, alt: p.alt || '', photographerId: (selectedMap[id] && selectedMap[id].photographerId) || null });
        });
        // also extract any absolute-URL images
        const imgs = extractPhotosFromMarkdown(markdown);
        imgs.forEach(img => {
          placeholders.push({ id: img.id, url: img.url, alt: img.alt, photographerId: null });
        });
      } catch (e) {
        console.error('[ai_for_news] markdown normalization failed', e && e.stack ? e.stack : e);
        markdown = String(content || '');
      }
    }
    const title = (markdown.split('\n')[0] || '新闻标题').replace(/^#\s*/, '').slice(0, 80);
    const subtitle = '';
    const html = markdown.replace(/\n/g, '<br/>');

    // tokens and cost may be available in usage info depending on provider
    let tokens = null;
    let cost = null;
    try {
      if (resp.usage) tokens = resp.usage.total_tokens || null;
    } catch (e) {}

    return { title, subtitle, markdown, html, placeholders, tokens, cost };
  } catch (e) {
    // on error fall back to mock to avoid breaking caller
    console.error('[ai_for_news] text model call failed, falling back to mock:', e && e.stack ? e.stack : e);
    return mockGenerate(prompt);
  }
}

module.exports = { generateFromPrompt };
