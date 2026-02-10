#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { pool } = require('../db');
const image_similarity = require('../lib/image_similarity');
const keys = require('../config/keys');

const uploadsAbsDir = keys.UPLOAD_ABS_DIR || path.join(__dirname, '..', 'uploads');
const uploadRoot = uploadsAbsDir.replace(/\\/g, '/').toLowerCase().endsWith('/uploads')
    ? uploadsAbsDir
    : path.join(uploadsAbsDir, 'uploads');

function fetchUrlBuffer(url) {
    return new Promise((resolve, reject) => {
        try {
            const lib = url.startsWith('https://') ? https : http;
            lib.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    return resolve(fetchUrlBuffer(res.headers.location));
                }
                if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
            }).on('error', reject);
        } catch (e) { reject(e); }
    });
}

function localFileBufferFromUrl(raw) {
    let rel = String(raw || '').replace(/^\\/, '');
    if (rel.startsWith('/uploads/')) rel = rel.replace(/^\/uploads[\\/]/, '');
    if (rel.startsWith('uploads/')) rel = rel.replace(/^uploads[\\/]/, '');
    rel = rel.split('/').join(path.sep);
    const abs = path.join(uploadRoot, rel);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs);
}

async function main() {
    const argv = require('minimist')(process.argv.slice(2));
    const projectId = argv.projectId ? Number(argv.projectId) : null;
    const limit = argv.limit ? Number(argv.limit) : null;
    const modelName = argv.modelName || 'mobileclip_s0_image';

    console.log('[generate_embeddings] projectId=%s limit=%s model=%s', projectId, limit, modelName);

    let sql = `SELECT p.id AS photo_id, p.url FROM photos p WHERE NOT EXISTS (SELECT 1 FROM ai_image_embeddings e WHERE e.photo_id = p.id AND e.model_name = ?)`;
    const params = [modelName];
    if (projectId) {
        sql += ' AND p.project_id = ?';
        params.push(projectId);
    }
    sql += ' ORDER BY p.id ASC';
    if (limit) sql += ' LIMIT ' + limit;

    const [rows] = await pool.query(sql, params);
    console.log('[generate_embeddings] photos to process:', rows.length);

    let processed = 0, skipped = 0, errors = 0;
    for (const r of rows) {
        const pid = r.photo_id;
        const url = r.url;
        try {
            let buf = null;
            if (!url) {
                console.warn('[generate_embeddings] photo %s has no url, skipping', pid);
                skipped++;
                continue;
            }
            if (/^https?:\/\//i.test(url)) {
                try {
                    buf = await fetchUrlBuffer(url);
                } catch (e) {
                    console.warn('[generate_embeddings] failed fetch remote for %s: %s', pid, e.message);
                }
            } else {
                buf = localFileBufferFromUrl(url);
            }

            if (!buf || buf.length === 0) {
                console.warn('[generate_embeddings] no data for photo %s, skipping', pid);
                skipped++;
                continue;
            }

            const emb = await image_similarity.encodeImageFromBuffer(buf);
            await image_similarity.saveEmbedding(pid, emb, modelName);
            console.log('[generate_embeddings] saved embedding for photo', pid);
            processed++;
            await new Promise((r2) => setTimeout(r2, 100));
        } catch (e) {
            console.error('[generate_embeddings] error photo', pid, e && e.stack ? e.stack : e);
            errors++;
        }
    }

    console.log('[generate_embeddings] done processed=%d skipped=%d errors=%d', processed, skipped, errors);
    process.exit(0);
}

main().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
