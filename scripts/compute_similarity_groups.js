#!/usr/bin/env node
const { pool } = require('../db');

function l2Normalize(arr) {
    let s = 0;
    for (let v of arr) s += v * v;
    const n = Math.sqrt(s) || 1e-12;
    return arr.map(v => v / n);
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

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] || 0) * (b[i] || 0);
    return s;
}

async function compute(projectId, threshold = 0.8, minSize = 2, mode = 'connected', minInternal = 0.0, modelName = 'resnet50') {
    const sql = `
        SELECT p.id AS photo_id, e.embedding
        FROM ai_image_embeddings e
        JOIN photos p ON e.photo_id = p.id
        WHERE p.project_id = ? AND e.model_name = ?
    `;
    const [rows] = await pool.query(sql, [projectId, modelName]);
    if (!rows || rows.length === 0) return [];

    const ids = [];
    const vecs = [];
    for (const r of rows) {
        ids.push(r.photo_id);
        let v = null;
        try {
            v = tryParseEmbedding(r.embedding);
            if (v && !Array.isArray(v)) v = null;
            if (v && v.length > 0) {
                // ensure normalized
                const sumsq = v.reduce((s, x) => s + (x || 0) * (x || 0), 0);
                if (Math.abs(1 - Math.sqrt(sumsq)) > 1e-3) v = l2Normalize(v);
            } else v = [];
        } catch (e) {
            v = [];
        }
        vecs.push(v);
    }

    const n = ids.length;
    const sim = Array.from({ length: n }, () => new Array(n).fill(0));
    for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
            const s = dot(vecs[i], vecs[j]);
            sim[i][j] = s;
            sim[j][i] = s;
        }
    }

    const groups = [];
    if (mode === 'connected') {
        const adj = Array.from({ length: n }, () => []);
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                if (sim[i][j] >= threshold) {
                    adj[i].push(j);
                    adj[j].push(i);
                }
            }
        }
        const seen = new Array(n).fill(false);
        for (let i = 0; i < n; i++) {
            if (seen[i]) continue;
            const stack = [i];
            const comp = [];
            seen[i] = true;
            while (stack.length) {
                const u = stack.pop();
                comp.push(ids[u]);
                for (const v of adj[u]) if (!seen[v]) { seen[v] = true; stack.push(v); }
            }
            if (comp.length >= minSize) groups.push(comp);
        }
    } else if (mode === 'clique') {
        const assigned = new Array(n).fill(false);
        for (let i = 0; i < n; i++) {
            if (assigned[i]) continue;
            let clique = [i];
            assigned[i] = true;
            const candidates = [];
            for (let j = 0; j < n; j++) if (j !== i && !assigned[j] && sim[i][j] >= threshold) candidates.push(j);
            for (const c of candidates) {
                let ok = true;
                for (const m of clique) if (sim[c][m] < threshold) { ok = false; break; }
                if (ok) { clique.push(c); assigned[c] = true; }
            }
            if (clique.length >= minSize) groups.push(clique.map(idx => ids[idx]));
        }
    }

    // apply optional post-filter: require every pair inside a group to have sim >= minInternal
    if (minInternal && minInternal > 0) {
        const idToIndex = new Map();
        for (let i = 0; i < ids.length; i++) idToIndex.set(ids[i], i);
        const filtered = [];
        for (const g of groups) {
            let ok = true;
            for (let i = 0; i < g.length && ok; i++) {
                for (let j = i + 1; j < g.length; j++) {
                    const ia = idToIndex.get(g[i]);
                    const ib = idToIndex.get(g[j]);
                    const s = sim[ia][ib] || 0;
                    if (s < minInternal) { ok = false; break; }
                }
            }
            if (ok) filtered.push(g);
        }
        return filtered;
    }

    return groups;
}

async function main() {
    const argv = require('minimist')(process.argv.slice(2));
    const projectId = argv.projectId ? Number(argv.projectId) : null;
    if (!projectId) { console.error('Usage: node scripts/compute_similarity_groups.js --projectId 12 [--threshold 0.7] [--minSize 2] [--mode connected|clique]'); process.exit(2); }
    const threshold = argv.threshold ? Number(argv.threshold) : 0.8;
    const minSize = argv.minSize ? Number(argv.minSize) : 2;
    const mode = argv.mode || 'connected';
    const minInternal = argv.minInternal ? Number(argv.minInternal) : 0.0;
    const modelName = argv.modelName || 'resnet50';
    try {
        const groups = await compute(projectId, threshold, minSize, mode, minInternal, modelName);
        console.log(JSON.stringify({ projectId, threshold, minSize, mode, groups }, null, 2));
        process.exit(0);
    } catch (e) {
        console.error('Error computing groups:', e && e.stack ? e.stack : e);
        process.exit(1);
    }
}

main();
