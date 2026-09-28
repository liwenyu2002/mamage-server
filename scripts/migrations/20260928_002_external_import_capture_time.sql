ALTER TABLE external_import_items
  ADD COLUMN source_capture_time DATETIME NULL AFTER source_order;
