-- AI 创作矩阵地基：渠道模板（能力）、企业预设（人格）、批次（一次矩阵生成 = 1 batch + N 渠道 job）、月度配额。
-- 迁移器按文件名去重（schema_migrations），同一文件不会重复执行，故沿用近期迁移的写法，不加 IF NOT EXISTS 判断。

CREATE TABLE IF NOT EXISTS channel_templates (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  channel_key VARCHAR(32) NOT NULL,
  name VARCHAR(64) NOT NULL,
  version INT NOT NULL DEFAULT 1,
  output_schema JSON NOT NULL,
  prompt_fragments JSON NOT NULL,
  render_target VARCHAR(32) NOT NULL DEFAULT 'markdown',
  default_max_tokens INT NOT NULL DEFAULT 1600,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_channel_version (channel_key, version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 企业预设（组织级"人格"，最小版）：称谓规则/固定结尾/风格样文用于 prompt 注入，forbidden_words 用于生成后校验。
CREATE TABLE IF NOT EXISTS org_presets (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  org_id BIGINT NOT NULL,
  preset_name VARCHAR(64) NOT NULL DEFAULT '默认',
  org_full_name VARCHAR(128) NULL,
  title_rules TEXT NULL,
  forbidden_words JSON NULL,
  fixed_closing VARCHAR(300) NULL,
  style_samples MEDIUMTEXT NULL,
  is_default TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  KEY idx_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 批次：一次矩阵生成 = 1 batch + N 个渠道 job，status 由各子 job 状态汇总得出（见 GET /batches/:id 契约）。
CREATE TABLE IF NOT EXISTS ai_job_batches (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NULL,
  project_id BIGINT NULL,
  form_snapshot JSON NULL,
  selected_photo_ids JSON NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ai_jobs 挂到批次上，并记录渠道，便于批次内按渠道分派/重试单个 job。
ALTER TABLE ai_jobs
  ADD COLUMN batch_id BIGINT NULL,
  ADD COLUMN channel_key VARCHAR(32) NULL;

ALTER TABLE ai_jobs ADD INDEX idx_batch (batch_id);

-- 渠道特有字段（如小红书 hashtags）不污染统一 markdown，单独落 extra。
ALTER TABLE ai_results ADD COLUMN extra JSON NULL;

-- 组织月度配额：按 org_id + 'YYYY-MM' 累计 token/job 用量，超限由 lib/ai_quota.js 在应用层拦截。
CREATE TABLE IF NOT EXISTS ai_usage_quota (
  org_id BIGINT NOT NULL,
  period CHAR(7) NOT NULL,
  tokens_used BIGINT NOT NULL DEFAULT 0,
  jobs_used INT NOT NULL DEFAULT 0,
  PRIMARY KEY (org_id, period)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
