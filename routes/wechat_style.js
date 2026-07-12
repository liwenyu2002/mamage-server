// routes/wechat_style.js
// 公众号样式块库：POST /extract 从公众号文章链接启发式提取样式块（不落库，预览态）；
// GET/POST/DELETE /blocks 管理本组织已保存的样式块。全部接口要求 ai.generate 权限。
// 挂载于 app.js: app.use('/api/wechat-style', require('./routes/wechat_style'))
const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');
const { extractStyleBlocksFromHtml } = require('../lib/wechat_style_extract');

// ---- 常量 ----
const ALLOWED_HOST = 'mp.weixin.qq.com'; // SSRF 白名单：仅公众号文章域，精确匹配（不含子域通配）
const FETCH_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // 现代公众号文章页 HTML 普遍 1-5MB（内嵌脚本/样式），3MB 会误杀正常文章
const MAX_REDIRECTS = 5;
const DESKTOP_CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_SAVE_BLOCKS = 30; // 与单次提取上限(MAX_BLOCKS=30)对齐，否则"全选保存"必 413
const MAX_TEMPLATE_BYTES = 50 * 1024; // 50KB
const ALLOWED_TYPES = new Set(['h2', 'h3', 'quote', 'divider', 'imageCard', 'signoff']);

// 只允许 http/https 且 host 精确等于白名单域，拒绝用户名密码嵌入等花招（new URL 会正常解析出 hostname，
// 但额外显式校验 protocol，防止 file:/javascript: 等伪协议绕过）。
function assertAllowedWechatUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl));
  } catch (e) {
    const err = new Error('url 格式非法');
    err.httpStatus = 400;
    throw err;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    const err = new Error('仅支持 http/https 协议');
    err.httpStatus = 400;
    throw err;
  }
  if (parsed.hostname !== ALLOWED_HOST) {
    const err = new Error('仅支持公众号文章链接（mp.weixin.qq.com）');
    err.httpStatus = 400;
    throw err;
  }
  return parsed;
}

// 手动跟随重定向：每一跳都先校验目标 host 再发起下一次请求，防止"首跳是白名单域、
// 302 后跳到内网/其它域"的 SSRF；同时用 size 选项硬性限制单次响应体大小。
async function fetchWechatArticleHtml(rawUrl) {
  let currentUrl = assertAllowedWechatUrl(rawUrl).toString();

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let resp;
    try {
      resp = await fetch(currentUrl, {
        method: 'GET',
        redirect: 'manual',
        timeout: FETCH_TIMEOUT_MS,
        size: MAX_RESPONSE_BYTES,
        headers: {
          'User-Agent': DESKTOP_CHROME_UA,
          Accept: 'text/html,application/xhtml+xml',
        },
      });
    } catch (e) {
      const err = new Error(e && e.type === 'max-size' ? '响应体超过大小上限' : `抓取失败: ${(e && e.message) || e}`);
      err.httpStatus = 502;
      throw err;
    }

    if (resp.status >= 300 && resp.status < 400) {
      const location = resp.headers.get('location');
      if (!location) {
        const err = new Error('重定向缺少 location');
        err.httpStatus = 502;
        throw err;
      }
      let next;
      try {
        next = new URL(location, currentUrl);
      } catch (e) {
        const err = new Error('重定向目标非法');
        err.httpStatus = 502;
        throw err;
      }
      // 重定向后必须仍落在白名单域内，否则视为 SSRF 尝试直接拒绝
      assertAllowedWechatUrl(next.toString());
      currentUrl = next.toString();
      continue;
    }

    if (!resp.ok) {
      const err = new Error(`公众号页面返回 ${resp.status}`);
      err.httpStatus = 502;
      throw err;
    }

    let html;
    try {
      html = await resp.text();
    } catch (e) {
      const err = new Error(e && e.type === 'max-size' ? '响应体超过大小上限' : `读取响应失败: ${(e && e.message) || e}`);
      err.httpStatus = 502;
      throw err;
    }
    return { html, finalUrl: currentUrl };
  }

  const err = new Error('重定向次数过多');
  err.httpStatus = 502;
  throw err;
}

// 服务端再洗一遍（防止 POST /blocks 直接绕过 /extract 塞入恶意模板）：剥 <script> 与所有 on* 事件属性。
function sanitizeHtmlTemplate(html) {
  let out = String(html || '');
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  return out;
}

function rowToBlock(row) {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    htmlTemplate: row.html_template,
    accentEditable: !!row.accent_editable,
    source: row.source,
    sourceUrl: row.source_url || null,
    createdBy: row.created_by || null,
    createdAt: row.created_at,
  };
}

// POST /api/wechat-style/extract  body: { url }
// 从公众号文章链接启发式提取样式块，不落库，供前端预览后逐块勾选保存。
router.post('/extract', requirePermission('ai.generate'), async (req, res) => {
  try {
    const url = req.body && req.body.url;
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ code: 4001, message: 'url is required' });
    }

    let html;
    let finalUrl;
    try {
      const fetched = await fetchWechatArticleHtml(url);
      html = fetched.html;
      finalUrl = fetched.finalUrl;
    } catch (e) {
      const status = e && e.httpStatus ? e.httpStatus : 502;
      return res.status(status).json({ code: status === 400 ? 4002 : 5020, message: (e && e.message) || '抓取失败' });
    }

    let result;
    try {
      result = extractStyleBlocksFromHtml(html);
    } catch (e) {
      // 目前解析器唯一会 throw 的场景就是找不到 #js_content 容器
      return res.status(422).json({ code: 4220, message: (e && e.message) || '不是有效的公众号文章页' });
    }

    const blocks = result.blocks.map((b) => ({ ...b, sourceUrl: finalUrl }));
    res.json({ blocks, count: blocks.length });
  } catch (e) {
    console.error('POST /api/wechat-style/extract error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

// GET /api/wechat-style/blocks  当前 org 已保存的样式块列表
router.get('/blocks', requirePermission('ai.generate'), async (req, res) => {
  try {
    const orgId = (req.user && req.user.organization_id !== undefined) ? req.user.organization_id : null;
    // <=> 为 MySQL NULL 安全等于，兼容用户暂未归属任何组织（org_id 为 NULL）的场景
    const [rows] = await pool.query(
      'SELECT * FROM wechat_style_blocks WHERE org_id <=> ? ORDER BY created_at DESC LIMIT 500',
      [orgId]
    );
    res.json({ blocks: (rows || []).map(rowToBlock) });
  } catch (e) {
    console.error('GET /api/wechat-style/blocks error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

// POST /api/wechat-style/blocks  body: { blocks: [{type,name,htmlTemplate,accentEditable,sourceUrl}] }
// 批量保存提取结果（或用户自建块），≤30/次（与提取上限对齐）。
router.post('/blocks', requirePermission('ai.generate'), async (req, res) => {
  try {
    const input = req.body && req.body.blocks;
    if (!Array.isArray(input) || input.length === 0) {
      return res.status(400).json({ code: 4001, message: 'blocks is required (non-empty array)' });
    }
    if (input.length > MAX_SAVE_BLOCKS) {
      return res.status(413).json({ code: 4132, message: `blocks exceed max ${MAX_SAVE_BLOCKS} per request` });
    }

    const rowsToInsert = [];
    for (let i = 0; i < input.length; i += 1) {
      const b = input[i] || {};
      const type = String(b.type || '').trim();
      if (!ALLOWED_TYPES.has(type)) {
        return res.status(400).json({ code: 4003, message: `blocks[${i}].type invalid: ${type}` });
      }
      const name = String(b.name || '').trim().slice(0, 64);
      if (!name) {
        return res.status(400).json({ code: 4004, message: `blocks[${i}].name is required` });
      }
      const rawTemplate = String(b.htmlTemplate || '');
      if (!rawTemplate.trim()) {
        return res.status(400).json({ code: 4005, message: `blocks[${i}].htmlTemplate is required` });
      }
      if (Buffer.byteLength(rawTemplate, 'utf8') > MAX_TEMPLATE_BYTES) {
        return res.status(413).json({ code: 4133, message: `blocks[${i}].htmlTemplate exceeds ${MAX_TEMPLATE_BYTES} bytes` });
      }
      const htmlTemplate = sanitizeHtmlTemplate(rawTemplate);
      const accentEditable = !!b.accentEditable;
      const sourceUrl = b.sourceUrl ? String(b.sourceUrl).slice(0, 512) : null;

      rowsToInsert.push({ type, name, htmlTemplate, accentEditable, sourceUrl });
    }

    const orgId = (req.user && req.user.organization_id !== undefined) ? req.user.organization_id : null;
    const createdBy = req.user && req.user.id ? req.user.id : null;

    const insertedIds = [];
    for (const r of rowsToInsert) {
      // source 恒为 'extracted'：builtin 块只存在于前端内置数组，不经此接口落库，防止客户端伪造 source='builtin'
      const [result] = await pool.query(
        `INSERT INTO wechat_style_blocks
           (org_id, type, name, html_template, accent_editable, source, source_url, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, 'extracted', ?, ?, NOW())`,
        [orgId, r.type, r.name, r.htmlTemplate, r.accentEditable ? 1 : 0, r.sourceUrl, createdBy]
      );
      insertedIds.push(result.insertId);
    }

    const [savedRows] = await pool.query(
      `SELECT * FROM wechat_style_blocks WHERE id IN (${insertedIds.map(() => '?').join(',')}) ORDER BY id ASC`,
      insertedIds
    );
    res.status(201).json({ blocks: (savedRows || []).map(rowToBlock) });
  } catch (e) {
    console.error('POST /api/wechat-style/blocks error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

// DELETE /api/wechat-style/blocks/:id  本 org 且（创建者本人或 admin/superadmin）
router.delete('/blocks/:id', requirePermission('ai.generate'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ code: 4001, message: 'invalid id' });

    const [rows] = await pool.query('SELECT * FROM wechat_style_blocks WHERE id = ? LIMIT 1', [id]);
    if (!rows || rows.length === 0) return res.status(404).json({ code: 4041, message: 'block not found' });
    const row = rows[0];

    const orgId = (req.user && req.user.organization_id !== undefined) ? req.user.organization_id : null;
    const rowOrgId = row.org_id === undefined ? null : row.org_id;
    // 跨组织一律 404，不暴露"存在但无权"这一信息
    const sameOrg = (rowOrgId === null && orgId === null) || (rowOrgId !== null && orgId !== null && Number(rowOrgId) === Number(orgId));
    if (!sameOrg) return res.status(404).json({ code: 4041, message: 'block not found' });

    const requesterId = req.user && req.user.id ? Number(req.user.id) : null;
    const isOwner = requesterId !== null && row.created_by !== null && Number(row.created_by) === requesterId;
    const isAdmin = req.user && (req.user.role === 'admin' || req.user.role === 'superadmin');
    if (!isOwner && !isAdmin) return res.status(403).json({ code: 4030, message: 'forbidden' });

    await pool.query('DELETE FROM wechat_style_blocks WHERE id = ?', [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    console.error('DELETE /api/wechat-style/blocks/:id error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

module.exports = router;
