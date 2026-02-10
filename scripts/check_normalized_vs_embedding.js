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

function l2norm(arr) {
    let s = 0; for (const v of arr) s += v * v; return Math.sqrt(s) || 0;
}

function maxAbsDiff(a, b) {
    const n = Math.max(a.length, b.length);
    let m = 0;
    for (let i = 0; i < n; i++) {
        const av = a[i] || 0, bv = b[i] || 0; const d = Math.abs(av - bv); if (d > m) m = d;
    }
    return m;
}

async function main() {
    const argv = require('minimist')(process.argv.slice(2));
    const limit = argv.limit ? Number(argv.limit) : 10;
    const [rows] = await pool.query('SELECT id, photo_id, embedding, normalized_embedding FROM ai_image_embeddings LIMIT ?', [limit]);
    console.log('rows:', rows.length);
    for (const r of rows) {
        const emb = tryParseEmbedding(r.embedding) || [];
        const norm = tryParseEmbedding(r.normalized_embedding) || [];
        console.log('id', r.id, 'photo', r.photo_id, 'len(emb)', emb.length, 'len(norm)', norm.length, 'norm(emb)', l2norm(emb).toFixed(6), 'norm(norm)', l2norm(norm).toFixed(6), 'maxAbsDiff', maxAbsDiff(emb, norm));
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
