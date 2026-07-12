// routes/user_favorites.js
// 用户个人收藏（样式块/照片）：与 wechat_style_blocks（组织级样式库）解耦，
// 全部按 req.user.id 隔离，一用户一份收藏；styleBlock 收藏落 payload 快照，
// 删除原块后收藏仍可渲染。全部接口要求 ai.generate 权限。
// 挂载于 app.js: app.use('/api/favorites', require('./routes/user_favorites'))
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');

// snippet=画布框选收藏的元素片段（payload.blocks 是 DocBlock 数组,可原样再插入画布）
const ALLOWED_KINDS = new Set(['styleBlock', 'photo', 'snippet']);
const MAX_REF_KEY_LEN = 64;
const MAX_PAYLOAD_BYTES = 32 * 1024; // 32KB（styleBlock/photo）
// 片段可含整段导入的 raw 富 HTML,更可能含图片编辑器导出的 data URL（单张 1280px JPEG ~200-400KB,
// 多张叠加轻松超 256KB）——放宽到 2MB 避免常态化 413（与手机预览 html 上限同量级）。
const MAX_SNIPPET_PAYLOAD_BYTES = 2 * 1024 * 1024;
const MAX_FAVORITES_PER_KIND = 200;

// 服务端正则清洗（与 routes/wechat_style.js 的 sanitizeHtmlTemplate 同步维护）。
// ⚠️ 正则清洗天然不完备，这里是纵深防御的第二道；真正的防线是 CanvasEditor 渲染前的
// 客户端 DOMPurify（htmlTemplate 唯一进 innerHTML 的地方）。此处至少堵住已知绕过：
// on* 事件属性前既可能是空白、也可能是 `/`（如 <svg/onload=>，经典标签分隔符绕过），
// 两种前缀都要命中；同时剥 iframe/object/embed 与 javascript: 伪协议。
function sanitizeHtmlTemplate(html) {
  let out = String(html || '');
  out = out.replace(/<(script|style|iframe|object|embed)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  out = out.replace(/<(iframe|object|embed)\b[^>]*>/gi, ''); // 无闭合标签的残体
  // on* 事件属性：前缀 [\s/] 覆盖 "空白分隔" 与 "斜杠分隔" 两种写法，替换为单个空格防 token 粘连
  out = out.replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ');
  out = out.replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ');
  out = out.replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ');
  // href/src 里的 javascript:/vbscript: 伪协议（容忍 & 实体与空白混淆）
  out = out.replace(/(href|src)\s*=\s*(["']?)\s*(?:javascript|vbscript)\s*:[^"'>\s]*/gi, '$1=$2#');
  return out;
}

// mysql2 通常已把 JSON 列解析为对象；个别驱动/连接参数下会退化成字符串，这里兜底。
function parseMaybeJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function rowToFavorite(row) {
  return {
    id: row.id,
    kind: row.kind,
    refKey: row.ref_key,
    payload: parseMaybeJson(row.payload, null),
    createdAt: row.created_at,
  };
}

// GET /api/favorites?kind=styleBlock|photo  kind 缺省返回全量
router.get('/', requirePermission('ai.generate'), async (req, res) => {
  try {
    const kind = req.query.kind;
    if (kind !== undefined && !ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ code: 4001, message: 'kind invalid' });
    }

    const userId = req.user.id;
    const params = [userId];
    let sql = 'SELECT * FROM user_favorites WHERE user_id = ?';
    if (kind) {
      sql += ' AND kind = ?';
      params.push(kind);
    }
    sql += ' ORDER BY created_at DESC LIMIT 500';

    const [rows] = await pool.query(sql, params);
    res.json({ favorites: (rows || []).map(rowToFavorite) });
  } catch (e) {
    console.error('GET /api/favorites error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

// POST /api/favorites  body: { kind, refKey, payload }
// 重复收藏（唯一键 uq_user_kind_ref 冲突）幂等返回既有行，状态码 200；新建返回 201。
router.post('/', requirePermission('ai.generate'), async (req, res) => {
  try {
    const body = req.body || {};
    const kind = body.kind;
    if (!ALLOWED_KINDS.has(kind)) {
      return res.status(400).json({ code: 4001, message: 'kind invalid' });
    }

    const refKey = String(body.refKey || '').trim();
    if (!refKey || refKey.length > MAX_REF_KEY_LEN) {
      return res.status(400).json({ code: 4002, message: `refKey is required (max ${MAX_REF_KEY_LEN} chars)` });
    }

    let payload = body.payload;
    let payloadJson = null; // mysql2 的 `?` 占位符对普通对象会展开成 `k = v, ...`（SET 子句语法），不是 JSON 字符串，
    // 所以 INSERT 必须显式传已 JSON.stringify 的字符串，交给 JSON 列类型自行解析入库。
    if (payload !== undefined && payload !== null) {
      if (typeof payload !== 'object' || Array.isArray(payload)) {
        return res.status(400).json({ code: 4003, message: 'payload must be an object' });
      }
      // htmlTemplate 可能来自客户端自建的样式块收藏，落库前必须过一遍白名单剥离
      if (typeof payload.htmlTemplate === 'string') {
        payload = { ...payload, htmlTemplate: sanitizeHtmlTemplate(payload.htmlTemplate) };
      }
      // snippet：payload.blocks 是 DocBlock 数组，其中 raw/para 块的 html 同样落库前清洗
      if (kind === 'snippet' && Array.isArray(payload.blocks)) {
        payload = {
          ...payload,
          blocks: payload.blocks.map((b) => (
            b && typeof b.html === 'string' ? { ...b, html: sanitizeHtmlTemplate(b.html) } : b
          )),
        };
      }
      try {
        payloadJson = JSON.stringify(payload);
      } catch (e) {
        return res.status(400).json({ code: 4003, message: 'payload must be JSON-serializable' });
      }
      const cap = kind === 'snippet' ? MAX_SNIPPET_PAYLOAD_BYTES : MAX_PAYLOAD_BYTES;
      if (Buffer.byteLength(payloadJson, 'utf8') > cap) {
        return res.status(413).json({ code: 4133, message: `payload exceeds ${cap} bytes` });
      }
    }

    const userId = req.user.id;

    const [existingRows] = await pool.query(
      'SELECT * FROM user_favorites WHERE user_id = ? AND kind = ? AND ref_key = ? LIMIT 1',
      [userId, kind, refKey]
    );
    if (existingRows && existingRows.length > 0) {
      return res.status(200).json({ favorite: rowToFavorite(existingRows[0]) });
    }

    const [[{ cnt }]] = await pool.query(
      'SELECT COUNT(*) AS cnt FROM user_favorites WHERE user_id = ? AND kind = ?',
      [userId, kind]
    );
    if (cnt >= MAX_FAVORITES_PER_KIND) {
      return res.status(413).json({ code: 4134, message: `favorites of kind ${kind} exceed max ${MAX_FAVORITES_PER_KIND}` });
    }

    let insertId;
    try {
      const [result] = await pool.query(
        'INSERT INTO user_favorites (user_id, kind, ref_key, payload, created_at) VALUES (?, ?, ?, ?, NOW())',
        [userId, kind, refKey, payloadJson]
      );
      insertId = result.insertId;
    } catch (e) {
      // 并发下两个请求都通过了上面的"不存在"检查，唯一键在 DB 层拦下重复写入，退化为幂等读取
      if (e && e.code === 'ER_DUP_ENTRY') {
        const [dupRows] = await pool.query(
          'SELECT * FROM user_favorites WHERE user_id = ? AND kind = ? AND ref_key = ? LIMIT 1',
          [userId, kind, refKey]
        );
        if (dupRows && dupRows.length > 0) {
          return res.status(200).json({ favorite: rowToFavorite(dupRows[0]) });
        }
      }
      throw e;
    }

    const [savedRows] = await pool.query('SELECT * FROM user_favorites WHERE id = ? LIMIT 1', [insertId]);
    res.status(201).json({ favorite: rowToFavorite(savedRows[0]) });
  } catch (e) {
    console.error('POST /api/favorites error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

// DELETE /api/favorites/:id  仅本人行可删，他人/不存在一律 404（不暴露"存在但无权"）
router.delete('/:id', requirePermission('ai.generate'), async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.status(400).json({ code: 4001, message: 'invalid id' });

    const userId = req.user.id;
    const [rows] = await pool.query('SELECT id FROM user_favorites WHERE id = ? AND user_id = ? LIMIT 1', [id, userId]);
    if (!rows || rows.length === 0) return res.status(404).json({ code: 4041, message: 'favorite not found' });

    await pool.query('DELETE FROM user_favorites WHERE id = ?', [id]);
    res.json({ deleted: true, id });
  } catch (e) {
    console.error('DELETE /api/favorites/:id error', e);
    res.status(500).json({ code: 5000, message: 'Internal server error' });
  }
});

module.exports = router;
