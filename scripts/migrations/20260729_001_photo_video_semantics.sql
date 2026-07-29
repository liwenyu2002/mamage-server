-- Full temporal-video semantic payloads live separately from gallery tags so
-- ordinary project reads remain lightweight while deep timeline data is retained.
CREATE TABLE IF NOT EXISTS photo_video_semantics (
  photo_id INT UNSIGNED NOT NULL,
  analysis_json MEDIUMTEXT NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (photo_id),
  CONSTRAINT fk_photo_video_semantics_photo
    FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
