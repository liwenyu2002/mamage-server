#!/usr/bin/env node
// Finds a user who has 'photos.view' permission and prints a JWT for testing
const { pool } = require('../db');
const jwt = require('jsonwebtoken');
const keys = require('../config/keys');

async function main() {
    try {
        const [roles] = await pool.query('SELECT DISTINCT role FROM role_permissions WHERE permission = ? LIMIT 10', ['photos.view']);
        if (!roles || roles.length === 0) {
            console.error('No roles grant photos.view permission');
            process.exit(2);
        }
        const roleNames = roles.map(r => r.role);
        const [users] = await pool.query('SELECT id, organization_id FROM users WHERE role IN (?) LIMIT 1', [roleNames]);
        if (!users || users.length === 0) {
            console.error('No user found for roles:', roleNames);
            process.exit(3);
        }
        const u = users[0];
        const payload = { id: u.id, organization_id: u.organization_id };
        const token = jwt.sign(payload, keys.JWT_SECRET || 'please-change-this-secret', { expiresIn: '30d' });
        console.log(token);
        process.exit(0);
    } catch (e) {
        console.error('error', e && e.stack ? e.stack : e);
        process.exit(1);
    }
}

main();
