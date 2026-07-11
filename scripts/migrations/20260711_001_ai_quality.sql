-- AI 选片 2.0：多维评分持久化。
-- ai_score   0-100 综合分（技术锐度/曝光实测 + 模型构图/主体/瞬间/美感加权）
-- ai_quality JSON {dims, flags, reason, tech}，三档标签仍写在 tags 里保持兼容

ALTER TABLE photos
  ADD COLUMN ai_score TINYINT UNSIGNED NULL AFTER ai_error,
  ADD COLUMN ai_quality JSON NULL AFTER ai_score;

ALTER TABLE photos ADD KEY idx_photos_project_score (project_id, ai_score);
