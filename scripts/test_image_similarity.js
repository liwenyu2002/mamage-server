#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

async function main() {
    const imgPath = process.argv[2];
    if (!imgPath) {
        console.error('Usage: node scripts/test_image_similarity.js <image-file>');
        process.exit(2);
    }
    if (!fs.existsSync(imgPath)) {
        console.error('Image file not found:', imgPath);
        process.exit(3);
    }

    try {
        const image_similarity = require(path.join(__dirname, '..', 'lib', 'image_similarity'));
        const buf = fs.readFileSync(imgPath);
        console.log('[test] loading model and encoding image...');
        const emb = await image_similarity.encodeImageFromBuffer(buf);
        console.log('[test] embedding length:', emb.length);
        console.log('[test] first 8 values:', emb.slice(0, 8));
        process.exit(0);
    } catch (e) {
        console.error('[test] error:', e && e.stack ? e.stack : e);
        process.exit(1);
    }
}

main();
