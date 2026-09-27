CREATE TABLE organization_units (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  slug VARCHAR(80) NOT NULL,
  name VARCHAR(150) NOT NULL,
  archived_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_organization_units_org_slug (organization_id, slug),
  KEY idx_organization_units_org (organization_id),
  CONSTRAINT fk_organization_units_org FOREIGN KEY (organization_id) REFERENCES organizations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE organization_unit_memberships (
  unit_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  role ENUM('member', 'editor', 'manager') NOT NULL DEFAULT 'member',
  removed_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (unit_id, user_id),
  KEY idx_organization_unit_memberships_user (user_id, removed_at),
  CONSTRAINT fk_organization_unit_memberships_unit FOREIGN KEY (unit_id) REFERENCES organization_units (id),
  CONSTRAINT fk_organization_unit_memberships_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE organization_admin_grants (
  organization_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  granted_by INT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT fk_organization_admin_grants_org FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_organization_admin_grants_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE face_search_grants (
  organization_id INT UNSIGNED NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  college_wide TINYINT(1) NOT NULL DEFAULT 0,
  granted_by INT UNSIGNED NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, user_id),
  CONSTRAINT fk_face_search_grants_org FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_face_search_grants_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE organization_access_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  unit_id INT UNSIGNED NULL,
  user_id INT UNSIGNED NOT NULL,
  action VARCHAR(80) NOT NULL,
  resource_type VARCHAR(40) NULL,
  resource_id BIGINT UNSIGNED NULL,
  details JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_organization_access_audit_org_time (organization_id, created_at),
  KEY idx_organization_access_audit_user_time (user_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE users ADD COLUMN active_unit_id INT UNSIGNED NULL;
ALTER TABLE projects ADD COLUMN unit_id INT UNSIGNED NULL, ADD KEY idx_projects_org_unit_created (organization_id, unit_id, created_at);
ALTER TABLE photos ADD COLUMN unit_id INT UNSIGNED NULL, ADD KEY idx_photos_org_unit_project (organization_id, unit_id, project_id);
ALTER TABLE wechat_style_blocks ADD COLUMN unit_id INT UNSIGNED NULL, ADD KEY idx_wechat_style_blocks_org_unit (org_id, unit_id);
ALTER TABLE wechat_compositions ADD COLUMN unit_id INT UNSIGNED NULL, ADD KEY idx_wechat_compositions_org_unit (org_id, unit_id);

CREATE TABLE internal_shares (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id INT UNSIGNED NOT NULL,
  source_unit_id INT UNSIGNED NOT NULL,
  target_unit_id INT UNSIGNED NULL,
  target_user_id INT UNSIGNED NULL,
  share_type ENUM('album', 'collection') NOT NULL,
  mode ENUM('read', 'copy', 'collaborate') NOT NULL,
  project_id INT UNSIGNED NULL,
  created_by INT UNSIGNED NOT NULL,
  snapshot_json JSON NULL,
  expires_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_internal_shares_target_unit (target_unit_id, expires_at, revoked_at),
  KEY idx_internal_shares_target_user (target_user_id, expires_at, revoked_at),
  KEY idx_internal_shares_project (project_id),
  CONSTRAINT fk_internal_shares_org FOREIGN KEY (organization_id) REFERENCES organizations (id),
  CONSTRAINT fk_internal_shares_source_unit FOREIGN KEY (source_unit_id) REFERENCES organization_units (id),
  CONSTRAINT fk_internal_shares_target_unit FOREIGN KEY (target_unit_id) REFERENCES organization_units (id),
  CONSTRAINT fk_internal_shares_target_user FOREIGN KEY (target_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE internal_share_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  share_id BIGINT UNSIGNED NOT NULL,
  photo_id INT UNSIGNED NULL,
  snapshot_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uk_internal_share_items_photo (share_id, photo_id),
  CONSTRAINT fk_internal_share_items_share FOREIGN KEY (share_id) REFERENCES internal_shares (id) ON DELETE CASCADE,
  CONSTRAINT fk_internal_share_items_photo FOREIGN KEY (photo_id) REFERENCES photos (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE share_links
  ADD COLUMN unit_id INT UNSIGNED NULL,
  ADD COLUMN sync_mode ENUM('approval', 'automatic') NOT NULL DEFAULT 'approval',
  ADD KEY idx_share_links_org_unit (organization_id, unit_id);

UPDATE organizations SET name = '北京中关村学院' WHERE code = 'BZA2024';
INSERT INTO organization_units (organization_id, slug, name)
  SELECT id, 'student-media', '学工与融媒体中心' FROM organizations WHERE code = 'BZA2024';
INSERT INTO organization_units (organization_id, slug, name)
  SELECT id, 'business-school', '商学院' FROM organizations WHERE code = 'BZA2024';
INSERT INTO organization_units (organization_id, slug, name)
  SELECT id, 'public-relations', '公关部门' FROM organizations WHERE code = 'BZA2024';
INSERT INTO organization_admin_grants (organization_id, user_id)
  SELECT o.id, u.id FROM organizations o JOIN users u ON u.organization_id = o.id
  WHERE o.code = 'BZA2024' AND u.email = 's-lwy24@bza.edu.cn';
