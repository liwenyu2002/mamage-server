ALTER TABLE video_projects
  ADD COLUMN unit_id INT UNSIGNED NULL,
  ADD KEY idx_video_projects_org_unit (org_id, unit_id, updated_at);
