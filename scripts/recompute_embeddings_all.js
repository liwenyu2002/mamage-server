#!/usr/bin/env node
const { pool } = require('../db');
const { spawnSync } = require('child_process');
const path = require('path');

async function run() {
    const modelName = 'resnet50';
    console.log('[recompute_embeddings_all] deleting existing embeddings for model', modelName);
    try {
        const [res] = await pool.query('DELETE FROM ai_image_embeddings WHERE model_name = ?', [modelName]);
        console.log('[recompute_embeddings_all] deleted rows:', res && res.affectedRows ? res.affectedRows : 0);
    } catch (e) {
        console.error('[recompute_embeddings_all] delete failed', e && e.stack ? e.stack : e);
        process.exit(1);
    }

    console.log('[recompute_embeddings_all] invoking generate_embeddings.js to recreate embeddings');
    const script = path.join(__dirname, 'generate_embeddings.js');
    const res = spawnSync('node', [script, '--modelName', modelName], { stdio: 'inherit' });
    if (res.error) {
        console.error('[recompute_embeddings_all] spawn error', res.error);
        process.exit(1);
    }
    process.exit(res.status || 0);
}

run().catch((e) => { console.error(e && e.stack ? e.stack : e); process.exit(1); });
