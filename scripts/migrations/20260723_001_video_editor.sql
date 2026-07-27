CREATE TABLE IF NOT EXISTS video_editor_assets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  org_id INT NULL,
  name VARCHAR(255) NOT NULL,
  storage_path VARCHAR(1024) NOT NULL,
  public_url VARCHAR(1024) NULL,
  mime_type VARCHAR(128) NULL,
  file_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  duration_seconds DECIMAL(12,3) NOT NULL DEFAULT 0,
  width INT UNSIGNED NOT NULL DEFAULT 0,
  height INT UNSIGNED NOT NULL DEFAULT 0,
  has_audio TINYINT(1) NOT NULL DEFAULT 0,
  analysis_json MEDIUMTEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_video_assets_user (user_id, created_at),
  KEY idx_video_assets_org (org_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS video_projects (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  org_id INT NULL,
  name VARCHAR(160) NOT NULL,
  aspect_ratio VARCHAR(16) NOT NULL DEFAULT '16:9',
  project_json MEDIUMTEXT NOT NULL,
  duration_seconds DECIMAL(12,3) NOT NULL DEFAULT 0,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_video_projects_user (user_id, updated_at),
  KEY idx_video_projects_org (org_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS video_render_jobs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued',
  progress INT UNSIGNED NOT NULL DEFAULT 0,
  stage VARCHAR(120) NULL,
  output_path VARCHAR(1024) NULL,
  output_url VARCHAR(1024) NULL,
  error_text TEXT NULL,
  render_options TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_video_render_project (project_id, created_at),
  KEY idx_video_render_user (user_id, created_at),
  KEY idx_video_render_status (status, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
