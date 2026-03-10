-- Core compatibility migration (idempotent)
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS invitations (
  id INT NOT NULL AUTO_INCREMENT,
  code VARCHAR(128) NOT NULL,
  role VARCHAR(50) NOT NULL,
  created_by INT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME DEFAULT NULL,
  max_uses INT DEFAULT 1,
  uses INT DEFAULT 0,
  revoked TINYINT(1) DEFAULT 0,
  note VARCHAR(255) DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_invitations_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS share_links (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(64) NOT NULL,
  share_type VARCHAR(32) NOT NULL COMMENT 'project | collection',
  project_id INT UNSIGNED DEFAULT NULL,
  title VARCHAR(255) DEFAULT NULL,
  note VARCHAR(255) DEFAULT NULL,
  created_by INT UNSIGNED NOT NULL,
  organization_id INT UNSIGNED NOT NULL,
  expires_at DATETIME DEFAULT NULL,
  revoked_at DATETIME DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_share_links_code (code),
  KEY idx_share_links_org (organization_id),
  KEY idx_share_links_created_by (created_by),
  KEY idx_share_links_project_id (project_id),
  KEY idx_share_links_expires_at (expires_at),
  KEY idx_share_links_revoked_at (revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS share_link_items (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  share_id INT UNSIGNED NOT NULL,
  photo_id INT UNSIGNED NOT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_share_link_items_share_photo (share_id, photo_id),
  KEY idx_share_link_items_share_id (share_id),
  KEY idx_share_link_items_photo_id (photo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) NULL;

