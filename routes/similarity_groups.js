const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const { requirePermission } = require('../lib/permissions');

function l2Normalize(arr) {
    let s = 0;
    for (let v of arr) s += v * v;
    const n = Math.sqrt(s) || 1e-12;
    return arr.map(v => v / n);
}

function dot(a, b) {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += (a[i] || 0) * (b[i] || 0);
    return s;
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

// GET /api/similarity/groups?projectId=12&threshold=0.8&minSize=2&mode=connected|clique&modelName=resnet50
router.get('/groups', requirePermission('photos.view'), async (req, res) => {
    try {
        const projectId = req.query.projectId ? Number(req.query.projectId) : null;
        if (!projectId) return res.status(400).json({ error: 'projectId is required' });

        const threshold = req.query.threshold ? Number(req.query.threshold) : 0.8;
        const minSize = req.query.minSize ? Math.max(1, Number(req.query.minSize)) : 2;
        const mode = (req.query.mode || 'connected').toLowerCase();
        const minInternal = req.query.minInternal ? Number(req.query.minInternal) : 0.0;

        const modelName = req.query.modelName || 'resnet50';
        // fetch embeddings for photos in this project
        const sql = `
            SELECT p.id AS photo_id, e.embedding
            FROM ai_image_embeddings e
            JOIN photos p ON e.photo_id = p.id
            WHERE p.project_id = ? AND e.model_name = ?
        `;
        const [rows] = await pool.query(sql, [projectId, modelName]);

        if (!rows || rows.length === 0) return res.json({ groups: [] });

        const ids = [];
        const vecs = [];
        for (const r of rows) {
            ids.push(r.photo_id);
            try {
                let v = tryParseEmbedding(r.embedding) || [];
                // ensure normalized
                const norm = l2Normalize(v);
                vecs.push(norm);
            } catch (e) {
                vecs.push([]);
            }
        }

        const n = ids.length;
        // build similarity matrix (upper triangular)
        const sim = Array.from({ length: n }, () => new Array(n).fill(0));
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const s = dot(vecs[i], vecs[j]);
                sim[i][j] = s;
                sim[j][i] = s;
            }
        }

        let groups = [];

        if (mode === 'connected') {
            // build adjacency and find connected components
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
                    for (const v of adj[u]) {
                        if (!seen[v]) {
                            seen[v] = true;
                            stack.push(v);
                        }
                    }
                }
                if (comp.length >= minSize) groups.push(comp);
            }
        } else if (mode === 'clique') {
            // greedy clique builder: for each unassigned node, try to grow a clique
            const assigned = new Array(n).fill(false);
            for (let i = 0; i < n; i++) {
                if (assigned[i]) continue;
                let clique = [i];
                assigned[i] = true;
                // candidate nodes that are similar to i
                const candidates = [];
                for (let j = 0; j < n; j++) {
                    if (j === i || assigned[j]) continue;
                    if (sim[i][j] >= threshold) candidates.push(j);
                }
                // try to add candidates that are similar to all current clique members
                for (const c of candidates) {
                    let ok = true;
                    for (const m of clique) {
                        if (sim[c][m] < threshold) { ok = false; break; }
                    }
                    if (ok) {
                        clique.push(c);
                        assigned[c] = true;
                    }
                }
                if (clique.length >= minSize) groups.push(clique.map(idx => ids[idx]));
            }
        } else {
            return res.status(400).json({ error: 'unknown mode, supported: connected, clique' });
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
            groups = filtered;
        }

        res.json({ modelName, groups });
    } catch (e) {
        console.error('/api/similarity/groups error', e && e.stack ? e.stack : e);
        res.status(500).json({ error: 'internal server error' });
    }
});

// GET /api/similarity/pairs?projectId=12&modelName=resnet50&minScore=0.0
router.get('/pairs', requirePermission('photos.view'), async (req, res) => {
    try {
        const projectId = req.query.projectId ? Number(req.query.projectId) : null;
        if (!projectId) return res.status(400).json({ error: 'projectId is required' });
        const modelName = req.query.modelName || 'resnet50';
        const minScore = req.query.minScore ? Number(req.query.minScore) : 0.0;

        const sql = `
            SELECT p.id AS photo_id, e.embedding
            FROM ai_image_embeddings e
            JOIN photos p ON e.photo_id = p.id
            WHERE p.project_id = ? AND e.model_name = ?
        `;
        const [rows] = await pool.query(sql, [projectId, modelName]);
        if (!rows || rows.length === 0) return res.json({ pairs: [] });

        const ids = [];
        const vecs = [];
        for (const r of rows) {
            ids.push(r.photo_id);
            try { const v = tryParseEmbedding(r.embedding) || []; vecs.push(l2Normalize(v)); } catch (e) { vecs.push([]); }
        }

        const pairs = [];
        for (let i = 0; i < ids.length; i++) {
            for (let j = i + 1; j < ids.length; j++) {
                const s = dot(vecs[i], vecs[j]);
                if (s >= minScore) pairs.push({ a: ids[i], b: ids[j], score: s });
            }
        }

        // sort desc by score
        pairs.sort((x, y) => y.score - x.score);
        res.json({ modelName, pairs });
    } catch (e) {
        console.error('/api/similarity/pairs error', e && e.stack ? e.stack : e);
        res.status(500).json({ error: 'internal server error' });
    }
});

module.exports = router;

// 简化路由：只需 projectId，使用推荐默认参数
// GET /api/similarity/groups/simple?projectId=12
router.get('/groups/simple', requirePermission('photos.view'), async (req, res) => {
    try {
        const projectId = req.query.projectId ? Number(req.query.projectId) : null;
        if (!projectId) return res.status(400).json({ error: 'projectId is required' });

        // 推荐默认值
        const modelName = 'resnet50';
        const threshold = 0.8;
        const minSize = 2;
        const mode = 'clique';

        const sql = `
            SELECT p.id AS photo_id, e.embedding
            FROM ai_image_embeddings e
            JOIN photos p ON e.photo_id = p.id
            WHERE p.project_id = ? AND e.model_name = ?
        `;
        const [rows] = await pool.query(sql, [projectId, modelName]);
        // DEBUG: log row count to help diagnose empty results
        try {
            console.log('[similarity_groups] projectId=', projectId, 'modelName=', modelName, 'rows=', rows && rows.length ? rows.length : 0);
            if (rows && rows.length) console.log('[similarity_groups] sample ids=', rows.slice(0, 10).map(r => r.photo_id));
        } catch (e) { /* ignore logging errors */ }
        if (!rows || rows.length === 0) return res.json({ modelName, groups: [] });

        const ids = [];
        const vecs = [];
        for (const r of rows) {
            ids.push(r.photo_id);
            try {
                const v = tryParseEmbedding(r.embedding) || [];
                vecs.push(l2Normalize(v));
            } catch (e) {
                vecs.push([]);
            }
        }

        const n = ids.length;
        const sim = Array.from({ length: n }, () => new Array(n).fill(0));
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const s = dot(vecs[i], vecs[j]);
                sim[i][j] = s; sim[j][i] = s;
            }
        }

        // DEBUG: print top pair similarities to help diagnose why groups empty
        try {
            const pairsDbg = [];
            for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) pairsDbg.push({ a: ids[i], b: ids[j], score: sim[i][j] });
            pairsDbg.sort((x, y) => y.score - x.score);
            console.log('[similarity_groups] top pairs sample=', pairsDbg.slice(0, 10));
        } catch (e) { }

        const groups = [];
        if (mode === 'connected') {
            const adj = Array.from({ length: n }, () => []);
            for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (sim[i][j] >= threshold) { adj[i].push(j); adj[j].push(i); }
            const seen = new Array(n).fill(false);
            for (let i = 0; i < n; i++) {
                if (seen[i]) continue;
                const stack = [i]; seen[i] = true; const comp = [];
                while (stack.length) {
                    const u = stack.pop(); comp.push(ids[u]);
                    for (const v of adj[u]) if (!seen[v]) { seen[v] = true; stack.push(v); }
                }
                if (comp.length >= minSize) groups.push(comp);
            }
        } else {
            const assigned = new Array(n).fill(false);
            for (let i = 0; i < n; i++) {
                if (assigned[i]) continue;
                let clique = [i]; assigned[i] = true;
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

        res.json({ modelName, threshold, minSize, mode, groups });
    } catch (e) {
        console.error('/api/similarity/groups/simple error', e && e.stack ? e.stack : e);
        res.status(500).json({ error: 'internal server error' });
    }
});
