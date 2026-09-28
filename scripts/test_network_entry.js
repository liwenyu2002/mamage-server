const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const os = require('os');

process.env.JWT_SECRET = 'network-entry-test-secret';

const { pool } = require('../db');
const originalQuery = pool.query;
const originalNetworkInterfaces = os.networkInterfaces;
let server;

async function main() {
  pool.query = async (sql) => {
    if (sql.startsWith('SELECT role FROM users')) return [[{ role: 'photographer' }]];
    if (sql.startsWith('SELECT organization_id FROM users')) return [[{ organization_id: 1 }]];
    if (sql.startsWith('SELECT 1 FROM role_permissions')) return [[{ allowed: 1 }]];
    throw new Error(`Unexpected database query: ${sql}`);
  };
  os.networkInterfaces = () => ({
    en1: [{ family: 'IPv4', internal: false, address: '10.100.71.180' }],
  });

  const app = express();
  app.use('/api/network', require('../routes/network'));
  server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/network/lan/manual`;
  const token = jwt.sign({ id: 42 }, process.env.JWT_SECRET, { expiresIn: '5m' });

  const authenticated = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(authenticated.status, 200);
  const entry = await authenticated.json();
  assert.equal(entry.ok, true);
  assert.equal(entry.lanIp, '10.100.71.180');
  assert.equal(entry.lanPort, 3443);

  const anonymous = await fetch(url);
  assert.equal(anonymous.status, 401);
  console.log('network manual entry tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
}).finally(async () => {
  pool.query = originalQuery;
  os.networkInterfaces = originalNetworkInterfaces;
  if (server) await new Promise((resolve) => server.close(resolve));
  await pool.end();
});
