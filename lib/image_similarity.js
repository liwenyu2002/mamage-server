const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const ort = require('onnxruntime-node');
const { pool } = require('../db');

let session = null;
const DEFAULT_ONNX_PATH = path.join(__dirname, '..', 'mobileclip_s0_image.onnx');
const ENV_ONNX_PATH = process.env.MOBILECLIP_ONNX_PATH || null;

async function loadModel(onnxPath) {
    if (session) return session;
    const p = onnxPath || ENV_ONNX_PATH || DEFAULT_ONNX_PATH;
    try {
        console.log('[image_similarity] loading ONNX model from', p);
        if (!p || !require('fs').existsSync(p)) {
            const msg = `ONNX model file not found at ${p}.\n` +
                `Place the ONNX file at this path or set MOBILECLIP_ONNX_PATH env var to the correct path.\n` +
                `If you do not have the ONNX file, export it from MobileCLIP (see scripts/export_mobileclip_image_onnx.py) or copy a pre-exported file.`;
            console.error('[image_similarity] ' + msg);
            throw new Error(msg);
        }
        session = await ort.InferenceSession.create(p, { executionProviders: ['cpu'] });
        console.log('[image_similarity] model loaded');
        return session;
    } catch (e) {
        console.error('[image_similarity] loadModel failed for', p, e && e.message ? e.message : e);
        throw e;
    }
}

async function preprocessBuffer(buf) {
    // produce Float32Array in CHW order, 224x224
    const img = await sharp(buf).resize(224, 224, { fit: 'cover' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const { data, info } = img; // info.channels == 3
    const H = 224, W = 224, C = 3;
    const floatData = new Float32Array(1 * C * H * W);
    const mean = [0.485, 0.456, 0.406];
    const std = [0.229, 0.224, 0.225];

    for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
            const idx = (y * W + x) * C;
            for (let c = 0; c < C; c++) {
                const v = data[idx + c] / 255.0;
                const dst = c * H * W + y * W + x;
                floatData[dst] = (v - mean[c]) / std[c];
            }
        }
    }
    return floatData;
}

function l2Normalize(arr) {
    let sum = 0.0;
    for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
    const norm = Math.sqrt(sum) || 1e-12;
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[i] / norm;
    return out;
}

async function encodeImageFromBuffer(buf, onnxPath) {
    try {
        const sess = await loadModel(onnxPath);
        const input = await preprocessBuffer(buf);
        const tensor = new ort.Tensor('float32', input, [1, 3, 224, 224]);
        const out = await sess.run({ input: tensor });
        // assume output name is 'output'
        const outTensor = out.output || out[Object.keys(out)[0]];
        const data = outTensor.data;
        const norm = l2Normalize(data);
        return Array.from(norm);
    } catch (e) {
        console.error('[image_similarity] encodeImageFromBuffer failed', e && e.stack ? e.stack : e);
        throw e;
    }
}

async function saveEmbedding(photoId, embedding, modelName) {
    const m = modelName || 'mobileclip_s0_image';
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

module.exports = { loadModel, encodeImageFromBuffer, saveEmbedding, cosine };
