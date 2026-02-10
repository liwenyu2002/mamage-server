#!/usr/bin/env node
const { pool } = require('../db');

function dot(a, b) {
    let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] || 0) * (b[i] || 0); return s;
}

function l2norm(a) {
    let s = 0; for (let v of a) s += v * v; const n = Math.sqrt(s) || 1e-12; return a.map(x => x / n);
}

async function main() {
    const argv = require('minimist')(process.argv.slice(2));
    const projectId = argv.projectId ? Number(argv.projectId) : null;
    if (!projectId) { console.error('Usage: node scripts/inspect_project_embeddings.js --projectId 12'); process.exit(2); }
    const sql = `SELECT p.id AS photo_id, e.embedding, e.normalized_embedding FROM ai_image_embeddings e JOIN photos p ON e.photo_id=p.id WHERE p.project_id = ? AND e.model_name = ?`;

    function l2Normalize(a) {
        let s = 0; for (let v of a) s += v * v; const n = Math.sqrt(s) || 1e-12; return a.map(x => x / n);
    }

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

    const [rows] = await pool.query(sql, [projectId, 'mobileclip_s0_image']);
    console.log('rows:', rows.length);
    if (!rows.length) return;
    const vecs = [];
    for (const r of rows) {
        let raw = r.embedding;
        let parsed = null;
        try { parsed = tryParseEmbedding(raw); } catch (e) { console.warn('parse fail id', r.photo_id, e.message); }
        if (!parsed) parsed = [];
        const v = l2Normalize(parsed);
        vecs.push({ id: r.photo_id, v });
    }
    console.log('sample ids:', vecs.slice(0, 6).map(x => x.id));
    console.log('sample vec[0..7]:', vecs.slice(0, 3).map(x => (x.v.slice(0, 8))));

    // compute pairwise similarities (upper triangle)
    const sims = [];
    for (let i = 0; i < vecs.length; i++) {
        for (let j = i + 1; j < vecs.length; j++) {
            const a = vecs[i].v, b = vecs[j].v;
            if (!a.length || !b.length) continue;
            sims.push(dot(a, b));
        }
    }
    if (sims.length === 0) { console.log('no pair similarities (maybe single item or empty vectors)'); return; }
    const min = Math.min(...sims); const max = Math.max(...sims);
    const sum = sims.reduce((s, x) => s + x, 0); const mean = sum / sims.length;
    console.log('pairs:', sims.length, 'min:', min.toFixed(6), 'max:', max.toFixed(6), 'mean:', mean.toFixed(6));
    // show histogram buckets
    const buckets = {};
    for (const s of sims) {
        const b = Math.floor(s * 100) / 100; // 0.01 buckets
        buckets[b] = (buckets[b] || 0) + 1;
    }
    const keys = Object.keys(buckets).map(Number).sort((a, b) => a - b);
    console.log('histogram (bucket->count) sample:', keys.slice(0, 10).map(k => [k.toFixed(2), buckets[k]]));
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
