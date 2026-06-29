-- Persist photo semantic-analysis state so the UI can recover after refresh.

SET @photos_ai_status_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'ai_status'
);
SET @ddl := IF(
  @photos_ai_status_exists = 0,
  'ALTER TABLE photos ADD COLUMN ai_status VARCHAR(20) NOT NULL DEFAULT ''done'' COMMENT ''pending|running|done|failed|skipped'' AFTER tags',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @photos_ai_error_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'ai_error'
);
SET @ddl := IF(
  @photos_ai_error_exists = 0,
  'ALTER TABLE photos ADD COLUMN ai_error VARCHAR(255) DEFAULT NULL AFTER ai_status',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @photos_ai_started_at_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'ai_started_at'
);
SET @ddl := IF(
  @photos_ai_started_at_exists = 0,
  'ALTER TABLE photos ADD COLUMN ai_started_at DATETIME DEFAULT NULL AFTER ai_error',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @photos_ai_finished_at_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'ai_finished_at'
);
SET @ddl := IF(
  @photos_ai_finished_at_exists = 0,
  'ALTER TABLE photos ADD COLUMN ai_finished_at DATETIME DEFAULT NULL AFTER ai_started_at',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_photos_ai_status_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND INDEX_NAME = 'idx_photos_ai_status'
);
SET @ddl := IF(
  @idx_photos_ai_status_exists = 0,
  'CREATE INDEX idx_photos_ai_status ON photos (ai_status, project_id, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
