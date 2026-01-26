-- scripts/create_share_tables.sql

-- 分享链接元信息表：一条记录 = 一个分享链接
CREATE TABLE IF NOT EXISTS share_links (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    code VARCHAR(64) NOT NULL,
    share_type VARCHAR(32) NOT NULL COMMENT 'project | collection',
    project_id INT UNSIGNED DEFAULT NULL COMMENT 'share_type=project 时填写',
    title VARCHAR(255) DEFAULT NULL,
    note VARCHAR(255) DEFAULT NULL,
    created_by INT UNSIGNED NOT NULL,
    organization_id INT UNSIGNED NOT NULL,
    expires_at DATETIME DEFAULT NULL,
    revoked_at DATETIME DEFAULT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_share_links_code (code),
    KEY idx_share_links_org (organization_id),
    KEY idx_share_links_created_by (created_by),
    KEY idx_share_links_project_id (project_id),
    KEY idx_share_links_expires_at (expires_at),
    KEY idx_share_links_revoked_at (revoked_at),
    CONSTRAINT fk_share_links_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT fk_share_links_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT fk_share_links_org FOREIGN KEY (organization_id) REFERENCES organizations (id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- 分享照片明细表：一条记录 = 分享里的一张照片
CREATE TABLE IF NOT EXISTS share_link_items (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    share_id INT UNSIGNED NOT NULL,
    photo_id INT UNSIGNED NOT NULL,
    sort_order INT UNSIGNED NOT NULL DEFAULT 0,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uk_share_link_items_share_photo (share_id, photo_id),
    KEY idx_share_link_items_share_id (share_id),
    KEY idx_share_link_items_photo_id (photo_id),
    CONSTRAINT fk_share_link_items_share FOREIGN KEY (share_id) REFERENCES share_links (id) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT fk_share_link_items_photo FOREIGN KEY (photo_id) REFERENCES photos (id) ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;