ALTER TABLE video_editor_assets
  ADD COLUMN unit_id INT UNSIGNED NULL,
  ADD KEY idx_video_assets_user_unit (user_id, unit_id, created_at);
