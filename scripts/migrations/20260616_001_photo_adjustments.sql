-- Store non-destructive photo tone adjustment parameters.
-- The original image and thumbnails remain unchanged; clients render using this JSON.

SET @photo_adjustments_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'adjustments'
);
SET @ddl := IF(
  @photo_adjustments_exists = 0,
  'ALTER TABLE photos ADD COLUMN adjustments JSON DEFAULT NULL COMMENT ''非破坏式调色参数 JSON'' AFTER description',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
