CREATE TABLE IF NOT EXISTS project_timeline_sections (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  project_id INT UNSIGNED NOT NULL,
  name VARCHAR(100) NOT NULL,
  section_time VARCHAR(64) DEFAULT NULL,
  sort_order INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_project_timeline_project_order (project_id, sort_order, id),
  KEY idx_project_timeline_project_name (project_id, name),
  CONSTRAINT fk_project_timeline_project
    FOREIGN KEY (project_id) REFERENCES projects (id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

SET @photos_timeline_section_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'timeline_section_id'
);
SET @ddl := IF(
  @photos_timeline_section_exists = 0,
  'ALTER TABLE photos ADD COLUMN timeline_section_id INT UNSIGNED DEFAULT NULL AFTER project_id',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_photos_timeline_section_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND INDEX_NAME = 'idx_photos_timeline_section'
);
SET @ddl := IF(
  @idx_photos_timeline_section_exists = 0,
  'CREATE INDEX idx_photos_timeline_section ON photos (project_id, timeline_section_id, created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
