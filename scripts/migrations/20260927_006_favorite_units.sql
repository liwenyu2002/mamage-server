ALTER TABLE user_favorites
  ADD COLUMN unit_id INT UNSIGNED NULL,
  ADD COLUMN unit_scope_id INT UNSIGNED GENERATED ALWAYS AS (COALESCE(unit_id, 0)) STORED;

ALTER TABLE user_favorites
  DROP INDEX uq_user_kind_ref,
  ADD UNIQUE KEY uq_user_unit_kind_ref (user_id, unit_scope_id, kind, ref_key),
  ADD KEY idx_user_favorites_unit (user_id, unit_id, created_at);
