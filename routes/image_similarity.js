const express = require('express');
const router = express.Router();
const fetch = require('node-fetch');
const { pool, buildUploadUrl } = require('../db');
const { encodeImageFromBuffer, cosine } = require('../lib/image_similarity');

function normalizeTopK(raw, fallback) {
    let k = parseInt(raw, 10);
    if (Number.isNaN(k) || k <= 0) return fallback;
    if (k > 100) return 100;
    return k;
}

// POST /api/image-similar/query { photoId, topK }
router.post('/query', async (req, res) => {
    try {
        const photoId = parseInt(req.body.photoId, 10);
        if (!photoId) return res.status(400).json({ error: 'INVALID_PARAM' });
        const topK = normalizeTopK(req.body.topK, 10);

        const [rows] = await pool.query('SELECT id, thumb_url AS thumbUrl, url FROM photos WHERE id = ? LIMIT 1', [photoId]);
        if (!rows || rows.length === 0) return res.status(404).json({ error: 'NOT_FOUND' });
        const r = rows[0];
        const imageUrl = r.thumbUrl || r.url;
        if (!imageUrl) return res.status(400).json({ error: 'NO_IMAGE' });

        // fetch image (may be local path like /uploads/...); if local, read from fs
        let buffer = null;
        if (imageUrl.startsWith('/uploads') || imageUrl.startsWith('uploads/')) {
            const abs = imageUrl.replace(/^[\/]+/, '');
            // try project root path
            try { buffer = require('fs').readFileSync(abs); } catch (e) { }
        }
        if (!buffer) {
            const rfetch = await fetch(imageUrl);
            buffer = await rfetch.buffer();
        }

        const qEmb = await encodeImageFromBuffer(buffer);

        const [embRows] = await pool.query('SELECT photo_id, embedding FROM ai_image_embeddings WHERE photo_id != ?', [photoId]);
        const scored = embRows.map((er) => {
            let emb = [];
            try { emb = JSON.parse(er.embedding); } catch (e) { emb = []; }
            return { photoId: er.photo_id, score: cosine(qEmb, emb) };
        }).sort((a, b) => b.score - a.score).slice(0, topK);

        const ids = scored.map(s => s.photoId);
        let photos = [];
        if (ids.length) {
            const [pRows] = await pool.query('SELECT id, uuid, project_id AS projectId, url, thumb_url AS thumbUrl, title FROM photos WHERE id IN (?)', [ids]);
            photos = pRows.map(p => ({ ...p, url: buildUploadUrl(p.url), thumbUrl: buildUploadUrl(p.thumbUrl) }));
        }

        res.json({ queryId: photoId, results: scored.map(s => ({ photoId: s.photoId, score: s.score, photo: photos.find(p => p.id === s.photoId) || null })) });
    } catch (e) {
        console.error('[image-similar] query error', e && e.stack ? e.stack : e);
        res.status(500).json({ error: 'INTERNAL' });
    }
});

module.exports = router;
