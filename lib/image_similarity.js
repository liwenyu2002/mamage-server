const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { pool } = require('../db');
const fsp = fs.promises;

const MAX_PY_STDOUT = 8 * 1024 * 1024;
const MAX_PY_STDERR = 8 * 1024 * 1024;

function getEncodeConcurrency() {
    const raw = Number(process.env.IMAGE_SIMILARITY_CONCURRENCY || 1);
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    return Math.min(4, Math.floor(raw));
}

let encodeRunning = 0;
const encodeQueue = [];

function drainEncodeQueue() {
    const concurrency = getEncodeConcurrency();
    while (encodeRunning < concurrency && encodeQueue.length > 0) {
        const job = encodeQueue.shift();
        encodeRunning += 1;
        Promise.resolve()
            .then(job.task)
            .then(job.resolve, job.reject)
            .finally(() => {
                encodeRunning -= 1;
                drainEncodeQueue();
            });
    }
}

function runWithEncodeLimit(task) {
    return new Promise((resolve, reject) => {
        encodeQueue.push({ task, resolve, reject });
        drainEncodeQueue();
    });
}

function runPythonScript(python, script, args, timeoutMs) {
    return new Promise((resolve, reject) => {
        let settled = false;
        let timedOut = false;
        let stdout = '';
        let stderr = '';

        const done = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn(value);
        };

        let child;
        try {
            child = spawn(python, [script, ...args], {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });
        } catch (err) {
            done(reject, err);
            return;
        }

        const timer = setTimeout(() => {
            timedOut = true;
            try { child.kill('SIGKILL'); } catch (e) { }
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            stdout += chunk.toString('utf8');
            if (stdout.length > MAX_PY_STDOUT) stdout = stdout.slice(-MAX_PY_STDOUT);
        });
        child.stderr.on('data', (chunk) => {
            stderr += chunk.toString('utf8');
            if (stderr.length > MAX_PY_STDERR) stderr = stderr.slice(-MAX_PY_STDERR);
        });
        child.on('error', (err) => {
            done(reject, err);
        });
        child.on('close', (code, signal) => {
            if (timedOut) {
                done(reject, new Error(`python script timeout after ${timeoutMs}ms`));
                return;
            }
            if (code !== 0) {
                const detail = (stderr || stdout || `exit code ${code}${signal ? ` (${signal})` : ''}`).trim();
                done(reject, new Error('python script failed: ' + detail));
                return;
            }
            done(resolve, stdout);
        });
    });
}

// encodeImageFromBuffer now writes the buffer to a temp file and calls
// the Python ResNet script `scripts/resnet_feature.py` to compute a
// normalized 2048-d embedding. The Python script must be runnable via
// the `python` command (or set PYTHON_PATH env var).
async function encodeImageFromBuffer(buf) {
    return runWithEncodeLimit(async () => {
        const tmpDir = os.tmpdir();
        const name = 'mamage_resnet_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.jpg';
        const tmpPath = path.join(tmpDir, name);
        try {
            await fsp.writeFile(tmpPath, buf);
        } catch (e) {
            console.error('[image_similarity] write tmp file failed', e && e.message ? e.message : e);
            throw e;
        }

        const python = process.env.PYTHON_PATH || 'python';
        const script = path.join(__dirname, '..', 'scripts', 'resnet_feature.py');
        let out = null;
        try {
            out = await runPythonScript(python, script, [tmpPath], 120000);
        } catch (e) {
            console.error('[image_similarity] call to resnet_feature.py failed', e && e.message ? e.message : e);
            throw e;
        } finally {
            try { await fsp.unlink(tmpPath); } catch (u) { }
        }

        try {
            const parsed = JSON.parse(out);
            return parsed;
        } catch (e) {
            console.error('[image_similarity] failed to parse python output', e && e.message ? e.message : e, 'raw=', out && out.slice ? out.slice(0, 200) : out);
            throw e;
        }
    });
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
