-- Migration: 2025-12-12
-- 目的: 将 projects.organization_id 改为可空，以避免 ER_NO_DEFAULT_FOR_FIELD
-- 在执行此迁移前务必先备份数据库。

ALTER TABLE projects
  MODIFY COLUMN organization_id INT UNSIGNED NULL;

-- 可选：如果表上存在外键约束并且需要保留外键行为，请按如下步骤处理：
-- 1) 查询外键名称：
--    SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
--    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'projects' AND COLUMN_NAME = 'organization_id' AND REFERENCED_TABLE_NAME IS NOT NULL;
-- 2) 如果需要，先 DROP 外键，再 MODIFY 列，再重建外键为 ON DELETE SET NULL，例如：
--    ALTER TABLE projects DROP FOREIGN KEY fk_name;
--    ALTER TABLE projects MODIFY COLUMN organization_id INT UNSIGNED NULL;
--    ALTER TABLE projects ADD CONSTRAINT fk_name FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE SET NULL;
