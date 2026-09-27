CREATE TABLE IF NOT EXISTS external_import_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  provider VARCHAR(32) NOT NULL,
  source_url VARCHAR(512) NOT NULL,
  source_title VARCHAR(255) NOT NULL,
  source_quality VARCHAR(40) NOT NULL,
  organization_id INT UNSIGNED NOT NULL,
  unit_id INT UNSIGNED NULL,
  project_id INT UNSIGNED NOT NULL,
  timeline_section_id INT UNSIGNED NULL,
  requested_by INT UNSIGNED NOT NULL,
  status ENUM('queued', 'running', 'completed', 'completed_with_errors', 'cancelled') NOT NULL DEFAULT 'queued',
  cancel_requested TINYINT(1) NOT NULL DEFAULT 0,
  selected_count INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_external_import_jobs_status (status, created_at),
  KEY idx_external_import_jobs_user (requested_by, project_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS external_import_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  job_id BIGINT UNSIGNED NOT NULL,
  provider_photo_id VARCHAR(128) NOT NULL,
  filename VARCHAR(180) NOT NULL,
  source_section_name VARCHAR(80) NULL,
  timeline_section_id INT UNSIGNED NULL,
  asset_url TEXT NOT NULL,
  preview_url TEXT NOT NULL,
  object_key VARCHAR(512) NULL,
  thumb_key VARCHAR(512) NULL,
  status ENUM('pending', 'running', 'done', 'skipped', 'failed') NOT NULL DEFAULT 'pending',
  photo_id INT UNSIGNED NULL,
  error_code VARCHAR(80) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_external_import_item (job_id, provider_photo_id),
  KEY idx_external_import_item_status (job_id, status, id),
  KEY idx_external_import_provider_photo (provider_photo_id, status),
  CONSTRAINT fk_external_import_item_job FOREIGN KEY (job_id) REFERENCES external_import_jobs (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS external_import_templates (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  hostname VARCHAR(255) NOT NULL,
  route_key VARCHAR(255) NOT NULL,
  fingerprint CHAR(64) NOT NULL,
  rules_json JSON NOT NULL,
  hit_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_external_import_template (hostname, route_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
