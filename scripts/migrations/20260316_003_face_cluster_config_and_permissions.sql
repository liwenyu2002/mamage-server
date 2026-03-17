-- Face cluster runtime config + extra face permissions.

CREATE TABLE IF NOT EXISTS face_cluster_configs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  match_threshold DECIMAL(5,4) NOT NULL DEFAULT 0.3600,
  updated_by INT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_face_cluster_cfg_org (organization_id),
  KEY idx_face_cluster_cfg_updated_at (updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

INSERT IGNORE INTO role_permissions (role, permission) VALUES
  ('admin', 'faces.merge'),
  ('admin', 'faces.config');

