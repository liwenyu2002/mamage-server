-- Improve photo search/list query performance.
-- Safe and idempotent.

SET @idx_photos_org_project_created_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND INDEX_NAME = 'idx_photos_org_project_created_id'
);
SET @ddl := IF(
  @idx_photos_org_project_created_exists = 0,
  'CREATE INDEX idx_photos_org_project_created_id ON photos (organization_id, project_id, created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_photos_org_created_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND INDEX_NAME = 'idx_photos_org_created_id'
);
SET @ddl := IF(
  @idx_photos_org_created_exists = 0,
  'CREATE INDEX idx_photos_org_created_id ON photos (organization_id, created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
