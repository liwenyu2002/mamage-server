// scripts/migrate_strip_upload_baseurl.js
// Usage:
//   node scripts/migrate_strip_upload_baseurl.js --dry-run
//   node scripts/migrate_strip_upload_baseurl.js --apply

try { require('dotenv').config(); } catch (e) { }
const path = require('path');
const { pool } = require('../db');
const keys = require('../config/keys');

const argv = process.argv.slice(2);
const apply = argv.includes('--apply');
const dry = argv.includes('--dry-run') || !apply;

(async () => {
    try {
        const baseCandidates = [
            (keys.UPLOAD_BASE_URL || '').toString(),
            (keys.COS_BASE_URL || '').toString(),
            (process.env.UPLOAD_BASE_URL || '').toString(),
            (process.env.COS_BASE_URL || '').toString()
        ].filter(Boolean);

        if (baseCandidates.length === 0) {
            console.error('No UPLOAD_BASE_URL or COS_BASE_URL configured in env or config/keys. Aborting.');
            process.exit(2);
        }

        // prefer explicit UPLOAD_BASE_URL if present
        const base = (keys.UPLOAD_BASE_URL || keys.COS_BASE_URL || process.env.UPLOAD_BASE_URL || process.env.COS_BASE_URL || '').replace(/\/+$/, '');
        if (!base) {
            console.error('Unable to determine base URL. Aborting.');
            process.exit(2);
        }

        console.log('[migrate] using base =', base);

        // find rows where url or thumb_url starts with base
        const likePattern = base + '/%';
        const [rows] = await pool.query(`SELECT id, url, thumb_url FROM photos WHERE url LIKE ? OR thumb_url LIKE ? LIMIT 1000`, [likePattern, likePattern]);

        console.log('[migrate] matched rows:', rows.length);
        if (rows.length === 0) {
            console.log('Nothing to do.');
            process.exit(0);
        }

        // preview
        for (const r of rows.slice(0, 50)) {
            const newUrl = r.url && r.url.indexOf(base) === 0 ? r.url.substring(base.length) : r.url;
            const newThumb = r.thumb_url && r.thumb_url.indexOf(base) === 0 ? r.thumb_url.substring(base.length) : r.thumb_url;
            console.log('id=', r.id, '\n  old url=', r.url, '\n  new url=', newUrl, '\n  old thumb=', r.thumb_url, '\n  new thumb=', newThumb);
        }

        if (dry) {
            console.log('\nDry run mode - no changes applied. Run with --apply to perform updates.');
            process.exit(0);
        }

        // apply updates in transaction
        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();
            for (const r of rows) {
                const newUrl = r.url && r.url.indexOf(base) === 0 ? r.url.substring(base.length) : r.url;
                const newThumb = r.thumb_url && r.thumb_url.indexOf(base) === 0 ? r.thumb_url.substring(base.length) : r.thumb_url;
                // ensure leading slash
                const finalUrl = newUrl && !newUrl.startsWith('/') ? '/' + newUrl : newUrl;
                const finalThumb = newThumb && !newThumb.startsWith('/') ? '/' + newThumb : newThumb;
                await conn.query(`UPDATE photos SET url = ?, thumb_url = ? WHERE id = ?`, [finalUrl, finalThumb, r.id]);
            }
            await conn.commit();
            console.log('[migrate] applied updates for', rows.length, 'rows');
        } catch (e) {
            await conn.rollback();
            console.error('[migrate] error applying updates - rolled back', e && e.message ? e.message : e);
            process.exit(2);
        } finally {
            conn.release();
        }

        process.exit(0);
    } catch (e) {
        console.error('migration error:', e && e.message ? e.message : e);
        process.exit(2);
    }
})();
