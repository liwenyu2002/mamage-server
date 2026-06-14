-- Add covering indexes for high-traffic media list/delete paths.
-- Safe and idempotent.

SET @idx_projects_org_created_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'projects'
    AND INDEX_NAME = 'idx_projects_org_created_id'
);
SET @ddl := IF(
  @idx_projects_org_created_exists = 0,
  'CREATE INDEX idx_projects_org_created_id ON projects (organization_id, created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_projects_org_type_created_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'projects'
    AND INDEX_NAME = 'idx_projects_org_type_created_id'
);
SET @ddl := IF(
  @idx_projects_org_type_created_exists = 0,
  'CREATE INDEX idx_projects_org_type_created_id ON projects (organization_id, type, created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @idx_photos_project_created_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND INDEX_NAME = 'idx_photos_project_created_id'
);
SET @ddl := IF(
  @idx_photos_project_created_exists = 0,
  'CREATE INDEX idx_photos_project_created_id ON photos (project_id, created_at, id)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
