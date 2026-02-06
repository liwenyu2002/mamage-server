// scripts/test_embedding.js
// Usage: node scripts/test_embedding.js <imagePath> <photoId>
// Example: node scripts/test_embedding.js uploads/test.jpg 999

const fs = require('fs');
const path = require('path');

async function main() {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.error('Usage: node scripts/test_embedding.js <imagePath> <photoId>');
        process.exit(2);
    }
    const imgPath = args[0];
    const photoId = Number(args[1]);

    if (!fs.existsSync(imgPath)) {
        console.error('Image not found:', imgPath);
        process.exit(2);
    }

    const buf = fs.readFileSync(imgPath);

    try {
        const imageSim = require('../lib/image_similarity');
        console.log('[test_embedding] start encode');
        const emb = await imageSim.encodeImageFromBuffer(buf);
        console.log('[test_embedding] embedding length', emb.length);
        console.log('[test_embedding] saving to DB photoId=', photoId);
        await imageSim.saveEmbedding(photoId, emb);
        console.log('[test_embedding] saved');
        process.exit(0);
    } catch (e) {
        console.error('[test_embedding] failed', e && e.stack ? e.stack : e);
        process.exit(1);
    }
}

main();
