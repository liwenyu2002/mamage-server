-- Store web-optimized video playback renditions separately from original media.
-- Original video remains in photos.url for download/archive; playback_url is used by the web player.

SET @photos_playback_url_exists := (
  SELECT COUNT(*)
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photos'
    AND COLUMN_NAME = 'playback_url'
);
SET @ddl := IF(
  @photos_playback_url_exists = 0,
  'ALTER TABLE photos ADD COLUMN playback_url VARCHAR(255) DEFAULT NULL AFTER thumb_url',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
