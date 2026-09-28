ALTER TABLE external_import_items
  ADD KEY idx_external_import_pending_order (job_id, status, source_order, id),
  ADD KEY idx_external_import_updates (job_id, status, photo_id);
