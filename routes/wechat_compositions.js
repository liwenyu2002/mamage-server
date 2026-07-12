// routes/wechat_compositions.js
// 公众号排版器"存档"：把画布编辑中的整篇 DocBlock[] 文档快照落库，供用户随时另存/续写/覆盖。
// 与 wechat_preview（渲染好的只读 HTML、公开短时效链接）解耦——这里存的是可再编辑的结构化
// doc JSON，全部接口按 req.user.id 隔离，一用户最多 50 条，全部要求 ai.generate 权限。
// 挂载于 app.js: app.use('/api/wechat-compositions', require('./routes/wechat_compositions'))
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');

const MAX_NAME_LEN = 120;
const MAX_TITLE_LEN = 255;
const MAX_DIGEST_LEN = 512;
const MAX_THEME_KEY_LEN = 32;
const MAX_DOC_BYTES = 8 * 1024 * 1024; // 8MB：raw 块可能含图片编辑器导出的 data URL
const MAX_BLOCK_CONFIG_BYTES = 60 * 1000; // block_config 列是 TEXT（上限 65535 字节），留安全余量
const MAX_ARCHIVES_PER_USER = 50;
const DEFAULT_NAME = '未命名存档';

// 服务端再洗一遍 raw 块的 html（防止绕过前端 DOMPurify）。
// ⚠️ 与 routes/user_favorites.js / routes/wechat_style.js / routes/wechat_preview.js 的
// 同名函数同源同步维护；正则清洗是纵深防御的第二道，真正防线是画布渲染前的客户端 DOMPurify。
// on* 事件属性前缀用 [\s/] 同时覆盖空白分隔与斜杠分隔两种写法（如 <svg/onload=> 的经典标签
// 分隔符绕过）；href/src 里的 javascript:/vbscript: 伪协议一并剥离。
function sanitizeHtmlTemplate(html) {
  let out = String(html || '');
  out = out.replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(iframe|object|embed)\b[^>]*>/gi, ''); // 无闭合标签的残体
  out = out.replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ');
  out = out.replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ');
  out = out.replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ');
  out = out.replace(/(href|src)\s*=\s*(["']?)\s*(?:javascript|vbscript)\s*:[^"'>\s]*/gi, '$1=$2#');
  return out;
}

// mysql2 通常已把 JSON/TEXT 列解析/原样吐出；这里统一兜底把字符串解析回对象，解析失败给 fallback。
function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

// 遍历 doc 数组，对 kind==='raw' 或 kind==='para' 的 block.html 清洗。
// para 块在前端受限于 sanitizeParaHtml 的四标签白名单，但那只是 contenteditable 失焦提交时的
// 客户端防线；CanvasEditor 的 ParaView 在每次 doc 变化时都会把 block.html 直接 el.innerHTML =
// （见 CanvasEditor.jsx ParaView），不会重新过白名单。一个绕过前端、直接打 POST/PUT 的请求可以
// 把 kind:'para' 的 html 塞进 <img onerror=...> 之类 payload，之后本人"载入存档"时就会在画布里
// 原地执行——这与 raw 块的风险同源，必须同一套服务端清洗兜底。
// （styled 块不含整段富文本 html，其 content/caption 由前端渲染时转义，不在此清洗范围内）。
function sanitizeDoc(doc) {
  return doc.map((b) => (
    b && typeof b === 'object' && (b.kind === 'raw' || b.kind === 'para') && typeof b.html === 'string'
      ? { ...b, html: sanitizeHtmlTemplate(b.html) }
      : b
  ));
}

// blockCount = doc.length；imageCount = doc 序列化后 <img 标签出现次数 + kind='styled' 且
// type='imageCard' 的块数（imageCard 块图源存在 src 字段而非 <img> 标签，需单独计数）。
function countBlocksAndImages(doc) {
  const blockCount = doc.length;
  const docJson = JSON.stringify(doc);
  const imgTagMatches = docJson.match(/<img\b/gi);
  const imgTagCount = imgTagMatches ? imgTagMatches.length : 0;
  const imageCardCount = doc.filter((b) => b && typeof b === 'object' && b.kind === 'styled' && b.type === 'imageCard').length;
  return { blockCount, imageCount: imgTagCount + imageCardCount };
}

function normalizeName(rawName) {
  const name = String(rawName == null ? '' : rawName).trim();
  return name || DEFAULT_NAME;
}

function rowToSummary(row) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    blockCount: row.block_count,
    imageCount: row.image_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToDetail(row) {
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    digest: row.digest,
    doc: parseMaybeJson(row.doc, []),
    blockConfig: parseMaybeJson(row.block_config, null),
    themeKey: row.theme_key,
    blockCount: row.block_count,
    imageCount: row.image_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// 校验/序列化 doc；成功返回 { docJson, blockCount, imageCount }，失败返回 { error }（400 文案）。
function validateAndSerializeDoc(rawDoc) {
  if (!Array.isArray(rawDoc)) {
    return { error: 'doc must be an array' };
  }
  const sanitized = sanitizeDoc(rawDoc);
  let docJson;
  try {
    docJson = JSON.stringify(sanitized);
  } catch (e) {
    return { error: 'doc must be JSON-serializable' };
  }
  if (Buffer.byteLength(docJson, 'utf8') > MAX_DOC_BYTES) {
    return { error: `doc exceeds ${MAX_DOC_BYTES} bytes` };
  }
  const { blockCount, imageCount } = countBlocksAndImages(sanitized);
  return { docJson, blockCount, imageCount };
}

// 校验/序列化 blockConfig；成功返回 { blockConfigJson }（null 允许，代表未自定义），失败返回 { error }。
function validateAndSerializeBlockConfig(rawBlockConfig) {
  if (rawBlockConfig === undefined || rawBlockConfig === null) {
    return { blockConfigJson: null };
  }
  if (typeof rawBlockConfig !== 'object' || Array.isArray(rawBlockConfig)) {
    return { error: 'blockConfig must be an object' };
  }
  let blockConfigJson;
  try {
    blockConfigJson = JSON.stringify(rawBlockConfig);
  } catch (e) {
    return { error: 'blockConfig must be JSON-serializable' };
  }
  if (Buffer.byteLength(blockConfigJson, 'utf8') > MAX_BLOCK_CONFIG_BYTES) {
    return { error: `blockConfig exceeds ${MAX_BLOCK_CONFIG_BYTES} bytes` };
  }
  return { blockConfigJson };
}

// GET /api/wechat-compositions  按 updated_at 倒序，不含 doc/block_config 大字段
router.get('/', requirePermission('ai.generate'), async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.query(
      `SELECT id, name, title, block_count, image_count, created_at, updated_at
       FROM wechat_compositions WHERE user_id = ? ORDER BY updated_at DESC`,
      [userId]
    );
    res.json({ items: (rows || []).map(rowToSummary) });
  } catch (e) {
    console.error('[GET /api/wechat-compositions] error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// POST /api/wechat-compositions  body { name, title, digest, doc, blockConfig, themeKey }
router.post('/', requirePermission('ai.generate'), async (req, res) => {
  try {
    const body = req.body || {};
    const userId = req.user.id;

    const name = normalizeName(body.name);
    if (name.length > MAX_NAME_LEN) {
      return res.status(400).json({ error: `name exceeds ${MAX_NAME_LEN} chars` });
    }

    const docResult = validateAndSerializeDoc(body.doc);
    if (docResult.error) return res.status(400).json({ error: docResult.error });

    const blockConfigResult = validateAndSerializeBlockConfig(body.blockConfig);
    if (blockConfigResult.error) return res.status(400).json({ error: blockConfigResult.error });

    const title = body.title !== undefined && body.title !== null ? String(body.title).trim().slice(0, MAX_TITLE_LEN) : null;
    const digest = body.digest !== undefined && body.digest !== null ? String(body.digest).trim().slice(0, MAX_DIGEST_LEN) : null;
    const themeKey = body.themeKey !== undefined && body.themeKey !== null ? String(body.themeKey).trim().slice(0, MAX_THEME_KEY_LEN) : null;

    const orgId = req.user && req.user.organization_id !== undefined && req.user.organization_id !== null
      ? Number(req.user.organization_id)
      : null;

    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM wechat_compositions WHERE user_id = ?',
      [userId]
    );
    if (cnt >= MAX_ARCHIVES_PER_USER) {
      return res.status(409).json({ error: 'ARCHIVE_LIMIT', limit: MAX_ARCHIVES_PER_USER });
    }

    const [result] = await pool.query(
      `INSERT INTO wechat_compositions
        (user_id, org_id, name, title, digest, doc, block_config, theme_key, block_count, image_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        userId,
        Number.isNaN(orgId) ? null : orgId,
        name,
        title || null,
        digest || null,
        docResult.docJson,
        blockConfigResult.blockConfigJson,
        themeKey || null,
        docResult.blockCount,
        docResult.imageCount,
      ]
    );

    const [savedRows] = await pool.query(
      'SELECT id, name, created_at, updated_at FROM wechat_compositions WHERE id = ? LIMIT 1',
      [result.insertId]
    );
    const saved = savedRows[0];
    res.status(201).json({ id: saved.id, name: saved.name, createdAt: saved.created_at, updatedAt: saved.updated_at });
  } catch (e) {
    console.error('[POST /api/wechat-compositions] error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// GET /api/wechat-compositions/:id
router.get('/:id', requirePermission('ai.generate'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'INVALID_ID' });

    const userId = req.user.id;
    const [rows] = await pool.query(
      'SELECT * FROM wechat_compositions WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'NOT_FOUND' });

    res.json(rowToDetail(rows[0]));
  } catch (e) {
    console.error('[GET /api/wechat-compositions/:id] error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// PUT /api/wechat-compositions/:id  body 同 POST，字段全可选，只更新给到的
router.put('/:id', requirePermission('ai.generate'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'INVALID_ID' });

    const userId = req.user.id;
    const [existingRows] = await pool.query(
      'SELECT id FROM wechat_compositions WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
    );
    if (!existingRows || existingRows.length === 0) return res.status(404).json({ error: 'NOT_FOUND' });

    const body = req.body || {};
    const sets = [];
    const params = [];

    if (body.name !== undefined) {
      const name = normalizeName(body.name);
      if (name.length > MAX_NAME_LEN) {
        return res.status(400).json({ error: `name exceeds ${MAX_NAME_LEN} chars` });
      }
      sets.push('name = ?');
      params.push(name);
    }

    if (body.title !== undefined) {
      const title = body.title !== null ? String(body.title).trim().slice(0, MAX_TITLE_LEN) : null;
      sets.push('title = ?');
      params.push(title || null);
    }

    if (body.digest !== undefined) {
      const digest = body.digest !== null ? String(body.digest).trim().slice(0, MAX_DIGEST_LEN) : null;
      sets.push('digest = ?');
      params.push(digest || null);
    }

    if (body.themeKey !== undefined) {
      const themeKey = body.themeKey !== null ? String(body.themeKey).trim().slice(0, MAX_THEME_KEY_LEN) : null;
      sets.push('theme_key = ?');
      params.push(themeKey || null);
    }

    if (body.blockConfig !== undefined) {
      const blockConfigResult = validateAndSerializeBlockConfig(body.blockConfig);
      if (blockConfigResult.error) return res.status(400).json({ error: blockConfigResult.error });
      sets.push('block_config = ?');
      params.push(blockConfigResult.blockConfigJson);
    }

    if (body.doc !== undefined) {
      const docResult = validateAndSerializeDoc(body.doc);
      if (docResult.error) return res.status(400).json({ error: docResult.error });
      sets.push('doc = ?', 'block_count = ?', 'image_count = ?');
      params.push(docResult.docJson, docResult.blockCount, docResult.imageCount);
    }

    sets.push('updated_at = NOW()');
    params.push(id, userId);

    await pool.query(
      `UPDATE wechat_compositions SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`,
      params
    );

    const [savedRows] = await pool.query(
      'SELECT id, name, updated_at FROM wechat_compositions WHERE id = ? LIMIT 1',
      [id]
    );
    const saved = savedRows[0];
    res.json({ id: saved.id, name: saved.name, updatedAt: saved.updated_at });
  } catch (e) {
    console.error('[PUT /api/wechat-compositions/:id] error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

// DELETE /api/wechat-compositions/:id
router.delete('/:id', requirePermission('ai.generate'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ error: 'INVALID_ID' });

    const userId = req.user.id;
    const [rows] = await pool.query(
      'SELECT id FROM wechat_compositions WHERE id = ? AND user_id = ? LIMIT 1',
      [id, userId]
    );
    if (!rows || rows.length === 0) return res.status(404).json({ error: 'NOT_FOUND' });

    await pool.query('DELETE FROM wechat_compositions WHERE id = ? AND user_id = ?', [id, userId]);
    res.json({ ok: true });
  } catch (e) {
    console.error('[DELETE /api/wechat-compositions/:id] error', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

module.exports = router;
