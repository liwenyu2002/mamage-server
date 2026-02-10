#!/usr/bin/env node
const { pool } = require('../db');

async function main() {
    const [rows] = await pool.query(`SELECT e.id AS eid, e.photo_id, e.embedding, e.normalized_embedding FROM ai_image_embeddings e JOIN photos p ON e.photo_id=p.id WHERE p.project_id = ? AND e.model_name = ?`, [12, 'mobileclip_s0_image']);
    console.log('rows:', rows.length);
    for (const r of rows) {
        console.log('eid', r.eid, 'photo_id', r.photo_id);
        console.log('embedding type', typeof r.embedding, 'len', r.embedding ? String(r.embedding).length : 0);
        console.log('embedding raw preview:', r.embedding ? String(r.embedding).slice(0, 200).replace(/\n/g, '') : '<null>');
        console.log('normalized type', typeof r.normalized_embedding, 'len', r.normalized_embedding ? String(r.normalized_embedding).length : 0);
        console.log('normalized preview:', r.normalized_embedding ? String(r.normalized_embedding).slice(0, 200).replace(/\n/g, '') : '<null>');
        console.log('---');
    }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
