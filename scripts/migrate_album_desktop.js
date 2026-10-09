const { pool } = require('../db');

async function migrate(db = pool) {
  await db.query(`CREATE TABLE IF NOT EXISTS album_desktop_workspaces (
    organization_id BIGINT NOT NULL,
    unit_key BIGINT NOT NULL DEFAULT 0,
    state JSON NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (organization_id, unit_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await db.query(`CREATE TABLE IF NOT EXISTS album_desktop_users (
    user_id BIGINT NOT NULL,
    organization_id BIGINT NOT NULL,
    unit_key BIGINT NOT NULL DEFAULT 0,
    state JSON NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, organization_id, unit_key)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

if (require.main === module) migrate().then(() => console.log('Album desktop schema ready')).catch(error => {
  console.error(error.message); process.exitCode = 1;
}).finally(() => pool.end());

module.exports = { migrate };
