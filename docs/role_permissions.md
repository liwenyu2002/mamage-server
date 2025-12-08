**Role Permissions (role_permissions) — 说明**

- **目的**：将原来硬编码在代码中的角色判断（如 `if (user.role === 'admin')`）替换为表驱动的权限检查。这样可以在数据库中灵活配置角色与权限的映射，不用每次变更都改代码并重启服务。

- **表结构**（已通过 migration 创建）：
  - `role_permissions`：列 `id`, `role`, `permission`, `created_at`；每行表示某个 `role` 拥有某个 `permission`。

- **权限字符串规范**：使用 `模块.动作` 的形式，例如：
  - `projects.view`, `projects.create`, `projects.update`, `projects.delete`
  - `photos.view`, `photos.delete`, `photos.zip`
  - `upload.photo`
  - `users.register`, `users.login`, `users.me.read`, `users.me.update`, `users.invitations.create`, `users.me.invite`

- **中间件**：后端新增 `lib/permissions.js` 并导出 `requirePermission(permission)`。
  - 在路由中使用举例：
    - `router.post('/delete', requirePermission('photos.delete'), handler)`
    - `router.post('/photo', requirePermission('upload.photo'), upload.single('file'), processUpload)`
  - `requirePermission` 会：
    1. 尝试使用已存在的 `req.user`（若之前路由使用了 `authMiddleware`），否则从 `Authorization: Bearer <token>` 中解析 JWT；
    2. 读取 `users` 表以获取用户 `role`；
    3. 在 `role_permissions` 表中判断该 `role` 是否含有指定 `permission`；
    4. 通过则继续下一个中间件/处理器，否则返回 `401`/`403`。

- **为什么要这样**：
  - 支持在数据库中调整角色权限而无需改代码；
  - 更灵活地支持新增角色或细化权限点；
  - 更易与管理后台对接（未来可实现 web 界面编辑 role-permission 映射）。

- **注意事项**：
  - 初始 migration 中已插入了一组权限映射（见 migration 文件）。导入后请根据实际需求调整表内内容。
  - 某些路由在修改后仍会将 `req.user` 填充为 `{id, role}`（以便后续逻辑需要 `req.user.id`）。
