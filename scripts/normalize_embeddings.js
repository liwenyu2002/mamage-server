#!/usr/bin/env node
const { pool } = require('../db');

function l2Normalize(arr) {
    let sum = 0; for (let v of arr) sum += v * v;
    const norm = Math.sqrt(sum) || 1e-12;
    return arr.map(v => v / norm);
}

async function main() {
    try {
        console.log('[normalize_embeddings] scanning ai_image_embeddings...');
        const [rows] = await pool.query('SELECT id, embedding FROM ai_image_embeddings');
        console.log('[normalize_embeddings] rows:', rows.length);
        let updated = 0, skipped = 0;
        for (const r of rows) {
            if (!r.embedding) { skipped++; continue; }
            try {
                const emb = JSON.parse(r.embedding);
                const norm = l2Normalize(emb);
                await pool.query('UPDATE ai_image_embeddings SET normalized_embedding = ? WHERE id = ?', [JSON.stringify(norm), r.id]);
                updated++;
            } catch (e) {
                console.warn('[normalize_embeddings] skip id', r.id, e.message);
                const { pool } = require('../db');

                function l2Normalize(arr) {
                    let sum = 0; for (let v of arr) sum += v * v;
                    const norm = Math.sqrt(sum) || 1e-12;
                    return arr.map(v => v / norm);
                }

                function tryParseEmbedding(raw) {
                    if (!raw && raw !== 0) return null;
                    if (Array.isArray(raw)) return raw;
                    let s = raw;
                    if (Buffer.isBuffer(s)) s = s.toString('utf8');
                    if (typeof s !== 'string') s = String(s);
                    s = s.trim();

                    try {
                        const v = JSON.parse(s);
                        if (Array.isArray(v)) return v;
            #!/usr/bin / env node
                        const { pool } = require('../db');

                        function l2Normalize(arr) {
                            let sum = 0; for (let v of arr) sum += v * v;
                            const norm = Math.sqrt(sum) || 1e-12;
                            return arr.map(v => v / norm);
                        }

                        function tryParseEmbedding(raw) {
                            if (!raw && raw !== 0) return null;
                            if (Array.isArray(raw)) return raw;
                            let s = raw;
                            if (Buffer.isBuffer(s)) s = s.toString('utf8');
                            if (typeof s !== 'string') s = String(s);
                            s = s.trim();

                            try {
                                const v = JSON.parse(s);
                                if (Array.isArray(v)) return v;
                                if (v && typeof v === 'object') {
                                    for (const k of Object.keys(v)) {
                                        if (Array.isArray(v[k])) return v[k];
                                    }
                                }
                            } catch (e) { }

                            if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                                const inner = s.slice(1, -1).trim();
                                try {
                                    const v = JSON.parse(inner);
                                    if (Array.isArray(v)) return v;
                                } catch (e) { }
                                s = inner;
                            }

                            let cleaned = s.replace(/^[\[]+|[\]]+$/g, '').replace(/,\s*$/, '').trim();
                            cleaned = cleaned.replace(/\s+/g, ' ');

                            let parts = cleaned.indexOf(',') >= 0 ? cleaned.split(',') : cleaned.split(/\s+/);
                            parts = parts.map(p => p.trim()).filter(p => p.length);
                            const nums = parts.map(p => {
                                const n = Number(p);
                                return Number.isNaN(n) ? null : n;
                            }).filter(x => x !== null);
                            if (nums.length > 0) return nums;

                            return null;
                        }

                        async function main() {
                            try {
                                console.log('[normalize_embeddings] scanning ai_image_embeddings...');
                                const [rows] = await pool.query('SELECT id, embedding FROM ai_image_embeddings');
                                console.log('[normalize_embeddings] rows:', rows.length);
                                let updated = 0, skipped = 0;
                                for (const r of rows) {
                                    if (!r.embedding) { skipped++; continue; }
                                    try {
                                        const emb = tryParseEmbedding(r.embedding);
                                        if (!emb || !Array.isArray(emb) || emb.length === 0) {
                      #!/usr/bin / env node
                                            const { pool } = require('../db');

                                            function l2Normalize(arr) {
                                                let sum = 0; for (let v of arr) sum += v * v;
                                                const norm = Math.sqrt(sum) || 1e-12;
                                                return arr.map(v => v / norm);
                                            }

                                            function tryParseEmbedding(raw) {
                                                if (!raw && raw !== 0) return null;
                                                if (Array.isArray(raw)) return raw;
                                                let s = raw;
                                                if (Buffer.isBuffer(s)) s = s.toString('utf8');
                                                if (typeof s !== 'string') s = String(s);
                                                s = s.trim();

                                                try {
                                                    const v = JSON.parse(s);
                                                    if (Array.isArray(v)) return v;
                                                    if (v && typeof v === 'object') {
                                                        for (const k of Object.keys(v)) {
                                                            if (Array.isArray(v[k])) return v[k];
                                                        }
                                                    }
                                                } catch (e) { }

                                                if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
                                                    const inner = s.slice(1, -1).trim();
                                                    try {
                                                        const v = JSON.parse(inner);
                                                        if (Array.isArray(v)) return v;
                                                    } catch (e) { }
                                                    s = inner;
                                                }

                                                let cleaned = s.replace(/^[\[]+|[\]]+$/g, '').replace(/,\s*$/, '').trim();
                                                cleaned = cleaned.replace(/\s+/g, ' ');

                                                let parts = cleaned.indexOf(',') >= 0 ? cleaned.split(',') : cleaned.split(/\s+/);
                                                parts = parts.map(p => p.trim()).filter(p => p.length);
                                                const nums = parts.map(p => {
                                                    const n = Number(p);
                                                    return Number.isNaN(n) ? null : n;
                                                }).filter(x => x !== null);
                                                if (nums.length > 0) return nums;

                                                return null;
                                            }

                                            async function main() {
                                                try {
                                                    console.log('[normalize_embeddings] scanning ai_image_embeddings...');
                                                    const [rows] = await pool.query('SELECT id, embedding FROM ai_image_embeddings');
                                                    console.log('[normalize_embeddings] rows:', rows.length);
                                                    let updated = 0, skipped = 0;
                                                    for (const r of rows) {
                                                        if (!r.embedding) { skipped++; continue; }
                                                        try {
                                                            const emb = tryParseEmbedding(r.embedding);
                                                            if (!emb || !Array.isArray(emb) || emb.length === 0) {
                                                                throw new Error('cannot-parse-embedding');
                                                            }
                                                            const norm = l2Normalize(emb);
                                                            await pool.query('UPDATE ai_image_embeddings SET normalized_embedding = ? WHERE id = ?', [JSON.stringify(norm), r.id]);
                                                            updated++;
                                                        } catch (e) {
                                                            console.warn('[normalize_embeddings] skip id', r.id, e && e.message ? e.message : e);
                                                            skipped++;
                                                        }
                                                    }
                                                    console.log('[normalize_embeddings] done updated=%d skipped=%d', updated, skipped);
                                                    process.exit(0);
                                                } catch (e) {
                                                    console.error('[normalize_embeddings] error', e && e.stack ? e.stack : e);
                                                    process.exit(1);
                                                }
                                            }

                                            main();
