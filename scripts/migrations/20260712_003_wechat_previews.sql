CREATE TABLE IF NOT EXISTS wechat_previews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(32) NOT NULL UNIQUE,
  org_id INT NULL,
  created_by INT NULL,
  title VARCHAR(255) NULL,
  digest VARCHAR(512) NULL,
  html MEDIUMTEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME NULL,
  KEY idx_created_by (created_by),
  KEY idx_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
