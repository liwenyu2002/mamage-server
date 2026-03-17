-- Face recognition core schema (idempotent).
-- 1) face_persons: clustered/annotated persons per organization
-- 2) photo_faces: per-face records with bbox + embedding + person mapping
-- 3) role permissions seed for future face APIs

CREATE TABLE IF NOT EXISTS face_persons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  person_no INT UNSIGNED NOT NULL,
  name VARCHAR(120) DEFAULT NULL,
  note TEXT DEFAULT NULL,
  cover_face_id BIGINT UNSIGNED DEFAULT NULL,
  created_by INT UNSIGNED DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_face_persons_org_person_no (organization_id, person_no),
  KEY idx_face_persons_org_name (organization_id, name),
  KEY idx_face_persons_created_at (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS photo_faces (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  photo_id INT UNSIGNED NOT NULL,
  project_id INT UNSIGNED DEFAULT NULL,
  organization_id INT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED DEFAULT NULL,
  face_no INT UNSIGNED NOT NULL DEFAULT 1,
  bbox_x DECIMAL(8,6) NOT NULL COMMENT 'left: ratio (0-1) or pixel based on bbox_unit',
  bbox_y DECIMAL(8,6) NOT NULL COMMENT 'top: ratio (0-1) or pixel based on bbox_unit',
  bbox_w DECIMAL(8,6) NOT NULL COMMENT 'width: ratio (0-1) or pixel based on bbox_unit',
  bbox_h DECIMAL(8,6) NOT NULL COMMENT 'height: ratio (0-1) or pixel based on bbox_unit',
  bbox_unit VARCHAR(16) NOT NULL DEFAULT 'ratio' COMMENT 'ratio | pixel',
  image_width INT UNSIGNED DEFAULT NULL,
  image_height INT UNSIGNED DEFAULT NULL,
  detection_score DECIMAL(7,6) DEFAULT NULL,
  quality_score DECIMAL(7,6) DEFAULT NULL,
  embedding JSON DEFAULT NULL,
  normalized_embedding JSON DEFAULT NULL,
  model_name VARCHAR(128) NOT NULL DEFAULT 'mobilefacenet_arcface',
  model_version VARCHAR(64) DEFAULT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'detected' COMMENT 'detected|clustered|confirmed|rejected',
  face_hash VARCHAR(128) DEFAULT NULL COMMENT 'optional dedupe hash for same photo face',
  extra JSON DEFAULT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_photo_faces_photo_face_no (photo_id, face_no),
  KEY idx_photo_faces_org_photo (organization_id, photo_id),
  KEY idx_photo_faces_org_project (organization_id, project_id),
  KEY idx_photo_faces_org_person (organization_id, person_id),
  KEY idx_photo_faces_status (status),
  KEY idx_photo_faces_created_at (created_at),
  CONSTRAINT fk_photo_faces_photo FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET @fk_photo_faces_person_exists := (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'photo_faces'
    AND CONSTRAINT_NAME = 'fk_photo_faces_person'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_photo_faces_person_exists = 0,
  'ALTER TABLE photo_faces ADD CONSTRAINT fk_photo_faces_person FOREIGN KEY (person_id) REFERENCES face_persons(id) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @fk_face_persons_cover_face_exists := (
  SELECT COUNT(*)
  FROM information_schema.TABLE_CONSTRAINTS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'face_persons'
    AND CONSTRAINT_NAME = 'fk_face_persons_cover_face'
    AND CONSTRAINT_TYPE = 'FOREIGN KEY'
);
SET @ddl := IF(
  @fk_face_persons_cover_face_exists = 0,
  'ALTER TABLE face_persons ADD CONSTRAINT fk_face_persons_cover_face FOREIGN KEY (cover_face_id) REFERENCES photo_faces(id) ON DELETE SET NULL ON UPDATE CASCADE',
  'SELECT 1'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO role_permissions (role, permission) VALUES
  ('admin', 'faces.view'),
  ('admin', 'faces.detect'),
  ('admin', 'faces.label'),
  ('photographer', 'faces.view'),
  ('photographer', 'faces.detect');
