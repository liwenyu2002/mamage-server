const { randomUUID } = require('crypto');

function invalid(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function validateGroups(value, albumIds) {
  if (!Array.isArray(value) || value.length > 300) throw invalid('相册集数据不正确');
  const seen = new Set();
  const groups = value.map((group) => {
    if (!group || typeof group !== 'object') throw invalid('相册集数据不正确');
    const id = String(group.id || randomUUID());
    const name = String(group.name || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id) || seen.has(id) || !name || name.length > 80) throw invalid('相册集名称或标识不正确');
    seen.add(id);
    const kind = group.kind === 'smart' ? 'smart' : 'manual';
    const projectIds = [...new Set(Array.isArray(group.projectIds) ? group.projectIds.map(Number) : [])];
    if (projectIds.some(id => !Number.isSafeInteger(id) || !albumIds.has(id))) throw invalid('相册已删除，或不属于当前工作空间', 403);
    const rule = group.rule || {};
    const year = String(rule.year || '');
    if (year && !/^\d{4}$/.test(year)) throw invalid('年份不正确');
    return { id, name, kind, projectIds: kind === 'smart' ? [] : projectIds,
      rule: kind === 'smart' ? { year, text: String(rule.text || '').trim().slice(0, 100) } : {},
      symbol: kind === 'smart' ? 'smart' : ['timeline', 'image', 'grid'].includes(group.symbol) ? group.symbol : 'grid',
      layout: kind === 'smart' ? 'rule' : ['stack', 'panorama', 'mosaic'].includes(group.layout) ? group.layout : 'stack',
      color: /^#[a-fA-F0-9]{6}$/.test(group.color || '') ? group.color : '#515c67',
      tint: /^#[a-fA-F0-9]{6}$/.test(group.tint || '') ? group.tint : '#e6e9ec' };
  });
  return groups;
}

function validatePreferences(value, groups, albumIds) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid('个人桌面设置不正确');
  const groupIds = new Set(groups.map(g => g.id));
  const keys = new Set([...albumIds].map(id => `album:${id}`).concat(groups.map(g => `group:${g.id}`)));
  const pins = [...new Set(Array.isArray(value.pins) ? value.pins.filter(key => keys.has(key)) : [])];
  const recentItems = [];
  const seen = new Set();
  for (const item of Array.isArray(value.recentItems) ? value.recentItems : []) {
    const id = Number(item?.id);
    if (!albumIds.has(id) || seen.has(id)) continue;
    seen.add(id);
    recentItems.push({ id, visitedAt: Number.isFinite(Number(item.visitedAt)) ? Math.min(Date.now(), Number(item.visitedAt)) : Date.now() });
    if (recentItems.length === 30) break;
  }
  const colors = {};
  for (const [id, color] of Object.entries(value.colors || {})) {
    if (groupIds.has(id) && /^#[a-fA-F0-9]{6}$/.test(color)) colors[id] = color;
  }
  return { pins, recentItems, colors,
    dismissed: [...new Set(Array.isArray(value.dismissed) ? value.dismissed.map(Number).filter(id => albumIds.has(id)) : [])] };
}

module.exports = { invalid, json, validateGroups, validatePreferences };
