CREATE TABLE organization_copy_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  share_id BIGINT UNSIGNED NOT NULL,
  organization_id INT UNSIGNED NOT NULL,
  target_unit_id INT UNSIGNED NOT NULL,
  requested_by INT UNSIGNED NOT NULL,
  system_initiated TINYINT(1) NOT NULL DEFAULT 0,
  target_project_id INT UNSIGNED NULL,
  status ENUM('queued', 'copying', 'ready', 'failed') NOT NULL DEFAULT 'queued',
  estimated_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  copied_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  manifest_json JSON NULL,
  result_json JSON NULL,
  error_code VARCHAR(80) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_organization_copy_jobs_status (status, created_at),
  KEY idx_organization_copy_jobs_user (requested_by, created_at),
  CONSTRAINT fk_organization_copy_jobs_share FOREIGN KEY (share_id) REFERENCES internal_shares (id),
  CONSTRAINT fk_organization_copy_jobs_unit FOREIGN KEY (target_unit_id) REFERENCES organization_units (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE photos ADD COLUMN source_attribution JSON NULL;
