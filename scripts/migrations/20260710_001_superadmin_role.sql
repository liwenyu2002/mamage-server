-- 超级管理员角色：继承 admin 全部权限，另加用户后台能力。
-- users.view_all     查看所有用户信息（不含密码）
-- users.manage_roles 修改任意用户的角色/权限

-- users.role 是 ENUM，需先扩充取值（保留既有值，包括历史遗留的 'bc'）
ALTER TABLE users MODIFY COLUMN role ENUM('visitor','photographer','admin','bc','superadmin') NOT NULL DEFAULT 'visitor';

INSERT INTO role_permissions (role, permission)
SELECT 'superadmin', rp.permission
FROM role_permissions rp
WHERE rp.role = 'admin'
  AND NOT EXISTS (
    SELECT 1 FROM role_permissions x
    WHERE x.role = 'superadmin' AND x.permission = rp.permission
  );

INSERT INTO role_permissions (role, permission)
SELECT 'superadmin', 'users.view_all'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions WHERE role = 'superadmin' AND permission = 'users.view_all'
);

INSERT INTO role_permissions (role, permission)
SELECT 'superadmin', 'users.manage_roles'
WHERE NOT EXISTS (
  SELECT 1 FROM role_permissions WHERE role = 'superadmin' AND permission = 'users.manage_roles'
);
