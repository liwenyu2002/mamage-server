ALTER TABLE external_import_jobs
  MODIFY status ENUM('queued', 'running', 'paused', 'completed', 'completed_with_errors', 'cancelled') NOT NULL DEFAULT 'queued',
  ADD COLUMN scan_status ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'completed' AFTER status,
  ADD COLUMN discovered_count INT UNSIGNED NOT NULL DEFAULT 0 AFTER selected_count,
  ADD COLUMN reported_total INT UNSIGNED NULL AFTER discovered_count,
  ADD COLUMN scan_error_code VARCHAR(80) NULL AFTER reported_total,
  ADD COLUMN scan_attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER scan_error_code,
  ADD COLUMN retry_after DATETIME NULL AFTER scan_attempts,
  ADD COLUMN attribution_visible TINYINT(1) NOT NULL DEFAULT 1 AFTER retry_after,
  ADD COLUMN finished_at DATETIME NULL AFTER attribution_visible,
  ADD KEY idx_external_import_album_status (project_id, status, id);

ALTER TABLE external_import_items
  ADD COLUMN source_order INT UNSIGNED NULL AFTER provider_photo_id,
  ADD COLUMN attempt_count SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER error_code;
