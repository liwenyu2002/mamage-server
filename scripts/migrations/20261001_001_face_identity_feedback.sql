CREATE TABLE IF NOT EXISTS face_feedback_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED DEFAULT NULL,
  action VARCHAR(32) NOT NULL,
  operation_key VARCHAR(191) DEFAULT NULL,
  details JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_face_feedback_operation (operation_key),
  KEY idx_face_feedback_org_time (organization_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS face_identity_feedback (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  person_id BIGINT UNSIGNED DEFAULT NULL,
  face_id BIGINT UNSIGNED DEFAULT NULL,
  photo_id INT UNSIGNED NOT NULL,
  sample_kind VARCHAR(16) NOT NULL,
  normalized_embedding JSON DEFAULT NULL,
  bbox JSON NOT NULL,
  model_name VARCHAR(128) NOT NULL,
  model_version VARCHAR(64) DEFAULT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_face_identity_feedback_face (face_id),
  KEY idx_face_identity_feedback_person (organization_id, person_id),
  KEY idx_face_identity_feedback_photo (photo_id),
  CONSTRAINT fk_identity_feedback_person FOREIGN KEY (person_id) REFERENCES face_persons(id) ON DELETE SET NULL,
  CONSTRAINT fk_identity_feedback_face FOREIGN KEY (face_id) REFERENCES photo_faces(id) ON DELETE SET NULL,
  CONSTRAINT fk_identity_feedback_photo FOREIGN KEY (photo_id) REFERENCES photos(id) ON DELETE CASCADE,
  CONSTRAINT fk_identity_feedback_event FOREIGN KEY (event_id) REFERENCES face_feedback_events(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS face_person_separations (
  organization_id INT UNSIGNED NOT NULL,
  person_low_id BIGINT UNSIGNED NOT NULL,
  person_high_id BIGINT UNSIGNED NOT NULL,
  event_id BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (organization_id, person_low_id, person_high_id),
  CONSTRAINT fk_face_separation_low FOREIGN KEY (person_low_id) REFERENCES face_persons(id) ON DELETE CASCADE,
  CONSTRAINT fk_face_separation_high FOREIGN KEY (person_high_id) REFERENCES face_persons(id) ON DELETE CASCADE,
  CONSTRAINT fk_face_separation_event FOREIGN KEY (event_id) REFERENCES face_feedback_events(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
