-- Full-resolution, size-capped JPEG rendition used by public share downloads.
-- Originals and thumbnails remain untouched.

SET @photos_public_download_url_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'public_download_url'
);
SET @ddl := IF(
  @photos_public_download_url_exists = 0,
  'ALTER TABLE photos ADD COLUMN public_download_url VARCHAR(255) DEFAULT NULL COMMENT ''公网下载版相对 URL（全尺寸，最多 5MB）'' AFTER thumb_url',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
