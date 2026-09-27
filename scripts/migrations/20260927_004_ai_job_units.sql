ALTER TABLE ai_jobs
  ADD COLUMN unit_id INT UNSIGNED NULL,
  ADD KEY idx_ai_jobs_unit_created (unit_id, created_at);

ALTER TABLE ai_job_batches
  ADD COLUMN unit_id INT UNSIGNED NULL,
  ADD KEY idx_ai_job_batches_unit_created (unit_id, created_at);
