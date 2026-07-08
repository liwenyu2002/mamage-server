SET @organizations_code_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'organizations'
    AND COLUMN_NAME = 'code'
);
SET @ddl := IF(
  @organizations_code_exists = 0,
  'ALTER TABLE organizations ADD COLUMN code VARCHAR(64) DEFAULT NULL AFTER slug',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

UPDATE organizations
SET code = 'HITMEDIA'
WHERE name = '哈工大全媒体测试'
  AND (code IS NULL OR code = '');

UPDATE organizations
SET code = 'BZA2024'
WHERE name = '中关村学院测试'
  AND (code IS NULL OR code = '');

UPDATE organizations
SET code = 'LSM2024'
WHERE name = '生命科学和医学学部测试'
  AND (code IS NULL OR code = '');

UPDATE organizations
SET code = 'DEMO2024'
WHERE name = 'demo'
  AND (code IS NULL OR code = '');

UPDATE organizations
SET code = 'MAMAGE2024'
WHERE name = 'MaMage内部测试'
  AND (code IS NULL OR code = '');

UPDATE organizations
SET code = CONCAT('ORG', LPAD(id, 4, '0'))
WHERE code IS NULL OR code = '';

SET @idx_organizations_code_exists := (
  SELECT COUNT(*)
  FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'organizations'
    AND INDEX_NAME = 'uk_organizations_code'
);
SET @ddl := IF(
  @idx_organizations_code_exists = 0,
  'CREATE UNIQUE INDEX uk_organizations_code ON organizations (code)',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
