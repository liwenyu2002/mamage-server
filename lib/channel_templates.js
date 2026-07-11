// 渠道模板读取。
// 约束：批量矩阵生成会在同一次请求里对多个渠道各查一次模板，60s 内存缓存避免打穿 DB；
// 缓存粒度是"全部活跃模板列表"一次性加载，getTemplateByKey 只是对同一份内存数据过滤，
// 保证 getActiveTemplates() 与 getTemplateByKey() 在同一缓存周期内看到的是同一个快照。

const { pool } = require('../db');

const CACHE_TTL_MS = 60 * 1000;
let cache = { data: null, expiresAt: 0 };

function parseMaybeJson(value, fallback) {
  // mysql2 通常已把 JSON 列解析为对象；个别驱动/连接参数下会退化成字符串，这里兜底防止上游按对象取字段时炸掉
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (e) {
    return fallback;
  }
}

function normalizeTemplateRow(row) {
  return {
    ...row,
    output_schema: parseMaybeJson(row.output_schema, {}),
    prompt_fragments: parseMaybeJson(row.prompt_fragments, {}),
  };
}

async function loadActiveTemplatesFromDb() {
  const [rows] = await pool.query(
    `SELECT id, channel_key, name, version, output_schema, prompt_fragments,
            render_target, default_max_tokens, is_active
       FROM channel_templates
      WHERE is_active = 1
      ORDER BY channel_key ASC, version DESC`
  );

  // 同一 channel_key 理论上不该有多条同时 active，但防御性地只保留版本号最大的一条，避免上游拿到重复渠道
  const byKey = new Map();
  (rows || []).forEach((row) => {
    const existing = byKey.get(row.channel_key);
    if (!existing || Number(row.version) > Number(existing.version)) {
      byKey.set(row.channel_key, normalizeTemplateRow(row));
    }
  });
  return Array.from(byKey.values());
}

async function getActiveTemplates() {
  const now = Date.now();
  if (cache.data && now < cache.expiresAt) return cache.data;
  const data = await loadActiveTemplatesFromDb();
  cache = { data, expiresAt: now + CACHE_TTL_MS };
  return data;
}

async function getTemplateByKey(key) {
  const templates = await getActiveTemplates();
  return templates.find((t) => t.channel_key === key) || null;
}

module.exports = { getActiveTemplates, getTemplateByKey };
