#!/usr/bin/env node
const { pool } = require('../db');

function tryParseEmbedding(raw) {
    if (!raw && raw !== 0) return null;
    if (Array.isArray(raw)) return raw;
    let s = raw;
    if (Buffer.isBuffer(s)) s = s.toString('utf8');
    if (typeof s !== 'string') s = String(s);
    s = s.trim();
    try {
        const v = JSON.parse(s); if (Array.isArray(v)) return v; if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) if (Array.isArray(v[k])) return v[k];
        }
    } catch (e) { }
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
        const inner = s.slice(1, -1).trim(); try { const v = JSON.parse(inner); if (Array.isArray(v)) return v; } catch (e) { } s = inner;
    }
    let cleaned = s.replace(/^[\[]+|[\]]+$/g, '').replace(/,\s*$/, '').trim(); cleaned = cleaned.replace(/\s+/g, ' ');
    let parts = cleaned.indexOf(',') >= 0 ? cleaned.split(',') : cleaned.split(/\s+/);
    parts = parts.map(p => p.trim()).filter(p => p.length);
    const nums = parts.map(p => { const n = Number(p); return Number.isNaN(n) ? null : n; }).filter(x => x !== null);
    if (nums.length > 0) return nums;
    return null;
}

function l2norm(a) { let s = 0; for (const v of a) s += v * v; const n = Math.sqrt(s) || 1e-12; return a.map(x => x / n); }
function dot(a, b) { let s = 0; for (let i = 0; i < Math.max(a.length, b.length); i++) { s += (a[i] || 0) * (b[i] || 0); } return s; }

async function main() {
    const argv = require('minimist')(process.argv.slice(2));
    const projectId = argv.projectId ? Number(argv.projectId) : null;
    const top = argv.top ? Number(argv.top) : 20;
    if (!projectId) { console.error('Usage: node scripts/dump_similarity_pairs.js --projectId 41 [--top 20]'); process.exit(2); }
    const sql = `SELECT p.id AS photo_id, e.embedding FROM ai_image_embeddings e JOIN photos p ON e.photo_id=p.id WHERE p.project_id=? AND e.model_name=?`;
    const [rows] = await pool.query(sql, [projectId, 'mobileclip_s0_image']);
    const items = [];
    for (const r of rows) { const v = tryParseEmbedding(r.embedding) || []; items.push({ id: r.photo_id, v: l2norm(v) }); }
    const pairs = [];
    for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
            const s = dot(items[i].v, items[j].v);
            pairs.push({ a: items[i].id, b: items[j].id, s });
        }
    }
    pairs.sort((x, y) => y.s - x.s);
    console.log('top pairs:'); console.log(pairs.slice(0, top));
    console.log('bottom pairs:'); console.log(pairs.slice(-top));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
