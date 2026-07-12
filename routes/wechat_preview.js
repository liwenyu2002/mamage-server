// routes/wechat_preview.js
// 公众号排版手机预览：把画布渲染好的整篇文章 HTML 存库，换一个公开可访问的短 token，
// 手机扫码/点链接直接看排版效果（不需要登录，因为手机上没有本站 JWT）。
// POST 落库要求 ai.generate 权限（与 wechat_style.js / user_favorites.js 一致）；
// GET /:token 公开无鉴权，参照 routes/share.js 的 GET /:code 公开读模式挂载。
// 挂载于 app.js: app.use('/api/wechat-preview', require('./routes/wechat_preview'))
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');

const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2MB
const MAX_TITLE_LEN = 255;
const MAX_DIGEST_LEN = 512;
const MAX_PREVIEWS_PER_USER = 30;
const EXPIRES_IN_MS = 7 * 24 * 3600 * 1000; // 7 天

// 服务端再洗一遍 html（防止绕过前端）。
// ⚠️ 与 routes/wechat_style.js / routes/user_favorites.js 的同名函数同源同步维护；
// 正则清洗是纵深防御的第二道，真正防线是画布渲染前的客户端 DOMPurify。
// on* 事件属性前缀用 [\s/] 同时覆盖空白分隔与斜杠分隔两种写法（如 <svg/onload=> 的
// 经典标签分隔符绕过）；href/src 里的 javascript:/vbscript: 伪协议一并剥离。
// 注意：不剥离 style="" 属性与元素内联样式——公众号排版本身就靠内联样式，
// 只清洗 <style> 整块标签（可能装脚本触发的 CSS 表达式/行为等旧式攻击面）与脚本类标签。
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

function escapeHtml(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function generateToken() {
  return crypto.randomBytes(18).toString('base64url');
}

// 仿 routes/share.js 的 insertShareLinkWithRetry：token 唯一键冲突则重试，非冲突错误直接抛出。
async function insertPreviewWithRetry(row, maxAttempts = 5) {
  let lastErr = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    const token = generateToken();
    try {
      const [result] = await pool.query(
        `INSERT INTO wechat_previews
					(token, org_id, created_by, title, digest, html, created_at, expires_at)
				 VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
        [token, row.org_id, row.created_by, row.title, row.digest, row.html, row.expires_at]
      );
      return { id: result.insertId, token };
    } catch (e) {
      lastErr = e;
      if (e && (e.code === 'ER_DUP_ENTRY' || e.errno === 1062)) continue;
      throw e;
    }
  }
  throw lastErr || new Error('failed to generate unique preview token');
}

// 插入成功后做两件"机会性"清理，都不影响主请求成败：
// 1) 该用户名下只保留最新 MAX_PREVIEWS_PER_USER 条，超出的旧记录删掉；
// 2) 顺带删一批已过期的行（限量，避免单次请求触发大范围扫描/锁表）。
async function cleanupAfterInsert(createdBy) {
  try {
    if (createdBy) {
      const [keepRows] = await pool.query(
        'SELECT id FROM wechat_previews WHERE created_by = ? ORDER BY id DESC LIMIT ?',
        [createdBy, MAX_PREVIEWS_PER_USER]
      );
      const keepIds = (keepRows || []).map((r) => r.id);
      if (keepIds.length > 0) {
        await pool.query(
          'DELETE FROM wechat_previews WHERE created_by = ? AND id NOT IN (?)',
          [createdBy, keepIds]
        );
      }
    }
  } catch (e) {
    console.warn('[wechat_preview] cleanup per-user cap failed (ignored)', e && e.message);
  }
  try {
    await pool.query('DELETE FROM wechat_previews WHERE expires_at IS NOT NULL AND expires_at < NOW() LIMIT 100');
  } catch (e) {
    console.warn('[wechat_preview] cleanup expired rows failed (ignored)', e && e.message);
  }
}

// POST /api/wechat-preview  body: { title?, digest?, html }
// 保存渲染好的整篇文章 HTML，返回公开可访问的 token。
router.post('/', requirePermission('ai.generate'), async (req, res) => {
  try {
    const body = req.body || {};
    const rawHtml = body.html;
    if (typeof rawHtml !== 'string' || !rawHtml.trim()) {
      return res.status(400).json({ code: 4001, message: 'html is required (non-empty string)' });
    }
    if (Buffer.byteLength(rawHtml, 'utf8') > MAX_HTML_BYTES) {
      return res.status(413).json({ code: 4133, message: `html exceeds ${MAX_HTML_BYTES} bytes` });
    }

    const title = body.title !== undefined && body.title !== null ? String(body.title).trim().slice(0, MAX_TITLE_LEN) : null;
    const digest = body.digest !== undefined && body.digest !== null ? String(body.digest).trim().slice(0, MAX_DIGEST_LEN) : null;
    const html = sanitizeHtmlTemplate(rawHtml);

    const createdBy = req.user && req.user.id ? Number(req.user.id) : null;
    if (!createdBy) return res.status(401).json({ error: 'UNAUTHORIZED' });
    const orgId = req.user && req.user.organization_id !== undefined && req.user.organization_id !== null
      ? Number(req.user.organization_id)
      : null;

    const expiresAt = new Date(Date.now() + EXPIRES_IN_MS);

    const inserted = await insertPreviewWithRetry({
      org_id: Number.isNaN(orgId) ? null : orgId,
      created_by: createdBy,
      title: title || null,
      digest: digest || null,
      html,
      expires_at: expiresAt
    });

    // 清理不阻塞响应成败，但要在返回前 await，避免容量上限失控（预览表增长快，行内是整篇 HTML）。
    await cleanupAfterInsert(createdBy);

    res.status(201).json({
      token: inserted.token,
      path: `/api/wechat-preview/${inserted.token}`,
      expiresAt: expiresAt.toISOString()
    });
  } catch (err) {
    console.error('[POST /api/wechat-preview] error:', err && err.stack ? err.stack : err);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

function sendNotFoundPage(res) {
  res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>预览不存在或已过期</title></head>' +
    '<body style="margin:0;padding:40px 20px;background:#f5f5f5;color:#333;' +
    'font-family:-apple-system,BlinkMacSystemFont,\'PingFang SC\',\'Microsoft YaHei\',sans-serif;text-align:center;">' +
    '<p style="font-size:16px;">预览不存在或已过期</p>' +
    '</body></html>'
  );
}

// GET /api/wechat-preview/:token  公开访问，无需登录（手机端没有本站 JWT）。
// 命中返回完整独立 HTML 文档；CSP 头彻底禁脚本执行，即便清洗有漏网也挡住 XSS。
router.get('/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    if (!token) return sendNotFoundPage(res);

    const [rows] = await pool.query(
      'SELECT title, digest, html, expires_at FROM wechat_previews WHERE token = ? LIMIT 1',
      [token]
    );
    if (!rows || rows.length === 0) return sendNotFoundPage(res);

    const preview = rows[0];
    if (preview.expires_at && new Date(preview.expires_at).getTime() <= Date.now()) {
      return sendNotFoundPage(res);
    }

    const titleText = preview.title || '公众号预览';
    const titleHtml = escapeHtml(titleText);
    const digestHtml = preview.digest ? escapeHtml(preview.digest) : '';

    const page =
      '<!DOCTYPE html><html lang="zh-CN"><head>' +
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      // mmbiz 图床对 Referer 有防盗链校验，no-referrer 让文中的公众号图片能正常加载
      '<meta name="referrer" content="no-referrer">' +
      `<title>${titleHtml}</title>` +
      '<style>' +
      'body{margin:0;padding:16px 0;background:#f2f2f2;}' +
      '.wpv-page{background:#fff;max-width:677px;margin:0 auto;padding:20px 16px;box-sizing:border-box;}' +
      '.wpv-page img{max-width:100%;height:auto;}' +
      '.wpv-title{font-size:20px;font-weight:600;margin:0 0 8px;color:#222;}' +
      '.wpv-digest{font-size:13px;color:#888;margin:0 0 16px;}' +
      '</style>' +
      '</head><body>' +
      '<div class="wpv-page">' +
      (preview.title ? `<h1 class="wpv-title">${titleHtml}</h1>` : '') +
      (digestHtml ? `<p class="wpv-digest">${digestHtml}</p>` : '') +
      preview.html +
      '</div>' +
      '</body></html>';

    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .set('Content-Security-Policy', "default-src 'none'; img-src * data:; style-src 'unsafe-inline'; font-src * data:; base-uri 'none'")
      .send(page);
  } catch (err) {
    console.error('[GET /api/wechat-preview/:token] error:', err && err.stack ? err.stack : err);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

module.exports = router;
