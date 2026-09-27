ALTER TABLE projects
  ADD COLUMN restricted_to_user_id INT UNSIGNED NULL,
  ADD KEY idx_projects_restricted_user (restricted_to_user_id);
