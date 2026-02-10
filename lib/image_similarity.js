const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');
const { pool } = require('../db');

// encodeImageFromBuffer now writes the buffer to a temp file and calls
// the Python ResNet script `scripts/resnet_feature.py` to compute a
// normalized 2048-d embedding. The Python script must be runnable via
// the `python` command (or set PYTHON_PATH env var).
async function encodeImageFromBuffer(buf) {
    const tmpDir = os.tmpdir();
    const name = 'mamage_resnet_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg';
    const tmpPath = path.join(tmpDir, name);
    try {
        fs.writeFileSync(tmpPath, buf);
    } catch (e) {
        console.error('[image_similarity] write tmp file failed', e && e.message ? e.message : e);
        throw e;
    }

    const python = process.env.PYTHON_PATH || 'python';
    const script = path.join(__dirname, '..', 'scripts', 'resnet_feature.py');
    let out = null;
    try {
        const res = spawnSync(python, [script, tmpPath], { encoding: 'utf8', timeout: 120000 });
        if (res.error) throw res.error;
        if (res.status !== 0) {
            const errMsg = res.stderr ? res.stderr.trim() : 'unknown python error';
            throw new Error('python script failed: ' + errMsg);
        }
        out = res.stdout;
    } catch (e) {
        console.error('[image_similarity] call to resnet_feature.py failed', e && e.message ? e.message : e);
        try { fs.unlinkSync(tmpPath); } catch (u) { }
        throw e;
    }

    try {
        const parsed = JSON.parse(out);
        return parsed;
    } catch (e) {
        console.error('[image_similarity] failed to parse python output', e && e.message ? e.message : e, 'raw=', out && out.slice ? out.slice(0, 200) : out);
        throw e;
    } finally {
        try { fs.unlinkSync(tmpPath); } catch (u) { }
    }
}

async function saveEmbedding(photoId, embedding, modelName) {
    const m = modelName || 'resnet50';
    try {
        console.log('[image_similarity] saving embedding for photoId', photoId, 'model', m);
        const [result] = await pool.query('INSERT INTO ai_image_embeddings (photo_id, model_name, embedding) VALUES (?, ?, ?)', [photoId, m, JSON.stringify(embedding)]);
        console.log('[image_similarity] save result', result && result.insertId ? 'insertId=' + result.insertId : result);
    } catch (e) {
        console.error('[image_similarity] saveEmbedding failed', e && e.message ? e.message : e);
        throw e;
    }
}

function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        const va = a[i];
        const vb = b[i] || 0;
        dot += va * vb;
        na += va * va;
        nb += vb * vb;
    }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-12);
}

module.exports = { encodeImageFromBuffer, saveEmbedding, cosine };
