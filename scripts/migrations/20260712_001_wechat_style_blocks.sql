-- 公众号样式块库：组织级样式块存储（内置块不落库，只存"提取/自建"的块）。
-- 迁移器按文件名去重（schema_migrations），不加 IF NOT EXISTS 判断的字段级变更；本文件仅建表。

CREATE TABLE IF NOT EXISTS wechat_style_blocks (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  org_id BIGINT NULL,
  type VARCHAR(24) NOT NULL,
  name VARCHAR(64) NOT NULL,
  html_template MEDIUMTEXT NOT NULL,
  accent_editable TINYINT(1) NOT NULL DEFAULT 0,
  source VARCHAR(16) NOT NULL DEFAULT 'extracted',
  source_url VARCHAR(512) NULL,
  created_by BIGINT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
