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
    const idsArg = argv.ids || argv.i;
    if (!idsArg) { console.error('Usage: node scripts/analyze_ids.js --ids 284,285,286 [--thresholds 0.82,0.75]'); process.exit(2); }
    const ids = String(idsArg).split(',').map(x => Number(x.trim())).filter(x => !Number.isNaN(x));
    const thresholds = (argv.thresholds ? String(argv.thresholds).split(',') : ['0.82', '0.75', '0.6', '0.54', '0.5']).map(x => Number(x));

    const sql = `SELECT e.photo_id, e.embedding FROM ai_image_embeddings e WHERE e.photo_id IN (${ids.map(() => '?').join(',')}) AND e.model_name = ?`;
    const params = [...ids, 'mobileclip_s0_image'];
    const [rows] = await pool.query(sql, params);
    const map = new Map();
    for (const r of rows) { const v = tryParseEmbedding(r.embedding) || []; map.set(r.photo_id, l2norm(v)); }

    console.log('Found embeddings for ids:', Array.from(map.keys()));

    // pairwise
    const pairs = [];
    for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
            const a = ids[i], b = ids[j];
            const va = map.get(a) || []; const vb = map.get(b) || [];
            const s = (va.length && vb.length) ? dot(va, vb) : null;
            pairs.push({ a, b, s });
        }
    }
    console.log('\nPairwise similarities:');
    for (const p of pairs) console.log(`${p.a} <-> ${p.b} : ${p.s === null ? '<missing>' : p.s.toFixed(6)}`);

    // simulate grouping for each threshold and both modes
    for (const t of thresholds) {
        console.log(`\nThreshold ${t} — connected:`);
        // build adj
        const idx = ids.map(id => id);
        const indexOf = id => ids.indexOf(id);
        const adj = new Map(); ids.forEach(id => adj.set(id, []));
        for (const p of pairs) { if (p.s !== null && p.s >= t) { adj.get(p.a).push(p.b); adj.get(p.b).push(p.a); } }
        // connected components
        const seen = new Set(); const groups = [];
        for (const id of ids) { if (seen.has(id)) continue; const stack = [id]; seen.add(id); const comp = []; while (stack.length) { const u = stack.pop(); comp.push(u); for (const v of adj.get(u) || []) if (!seen.has(v)) { seen.add(v); stack.push(v); } } if (comp.length > 0) groups.push(comp); }
        console.log('groups:', groups.filter(g => g.length >= 2));

        console.log(`Threshold ${t} — clique:`);
        // clique greedy
        const assigned = new Set(); const cliques = [];
        for (const id of ids) {
            if (assigned.has(id)) continue; let clique = [id]; assigned.add(id); const candidates = ids.filter(x => x !== id && !assigned.has(x) && (() => { const p = pairs.find(z => (z.a === id && z.b === x) || (z.a === x && z.b === id)); return p && p.s >= t; })());
            for (const c of candidates) { let ok = true; for (const m of clique) { const p = pairs.find(z => (z.a === c && z.b === m) || (z.a === m && z.b === c)); if (!p || p.s < t) { ok = false; break; } } if (ok) { clique.push(c); assigned.add(c); } }
            if (clique.length >= 2) cliques.push(clique);
        }
        console.log('cliques:', cliques);
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
