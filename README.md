# mamage-server

## 数据库恢复

如果你有现成的 `backup.sql`，建议把它放到项目中的 `db/backup.sql`，然后使用项目提供的恢复脚本来导入数据库：

示例（从项目根运行）：

```powershell
.\scripts\restore-db.ps1
```

脚本会尝试从 PATH 或常见安装位置查找 `mysql.exe`。如果找不到，请指定 `-MysqlPath`：

```powershell
.\scripts\restore-db.ps1 -MysqlPath 'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe'
```

或者手动执行（示例，替换为你系统的 mysql 路径）：

```powershell
# 创建数据库
"C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe" -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"
# 导入备份
cmd /c '"C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe" -u root -p mamage < "db\\backup.sql"'
```

说明：不要把 MySQL 的实际数据目录加入 Git。项目已在 `.gitignore` 中忽略常见的数据目录（如 `data/`）。


## 前端 API 参考（常用）

### 静态资源（图片）
- 访问路径：`GET /uploads/<path>`
### 健康检查
- `GET /api/health` — 返回服务状态：`{ status: 'ok' }`。

### 项目（projects）相关
- `GET /api/projects?limit=10` — 首页项目列表，返回数组，字段包含 `coverUrl` / `coverThumbUrl`（已为完整 URL）。
  - 示例：`fetch('/api/projects?limit=6').then(r=>r.json())`
- `GET /api/projects/list?page=1&pageSize=6&keyword=xxx` — 带分页和关键字搜索，返回 `{ list, page, pageSize, total, hasMore }`。
- `GET /api/projects/:id` — 项目详情，返回项目信息并在 `photos` 数组中包含每张图的 `fullUrl` / `fullThumbUrl`（完整 URL）。
- `POST /api/projects` — 创建项目，body（JSON）示例：
  ```json
  { "projectName": "名称", "description": "描述", "eventDate": "2025-11-17" }
  ```
- `POST /api/projects/:id/update` — 更新项目，body 同上。
- `DELETE /api/projects/:id` — 删除项目（会同时删除项目下的照片记录及本地文件）。

### 照片（photos）相关
- `GET /api/photos?projectId=1&limit=10&random=1&type=normal` — 获取照片列表；返回字段 `url`/`thumbUrl` 已为完整 URL，示例：`photo.url` 可直接作为 `<img src>`。
- `POST /api/photos/delete` — 批量删除照片，body（JSON）：`{ "photoIds": [1,2,3] }`。

### 上传（upload）相关
  - 字段：`file`（图片），`projectId`（可选），`title`、`type`、`tags`（JSON 字符串）
  - 返回示例：`{ id, projectId, url, thumbUrl, title, type }`，其中 `url`/`thumbUrl` 是以 `/uploads/...` 开头的路径。

### 环境变量（服务器端）
- `UPLOAD_ABS_DIR`：指向本机存放图片的绝对目录（示例：`C:/ALL/MaMage/Photo_Base`）。服务器会在此目录下寻找 `uploads` 子目录并对外暴露为 `/uploads`。
- `UPLOAD_BASE_URL`：图片的基础访问 URL（示例：`http://localhost:3000`）。服务器端 `buildUploadUrl()` 会用此值拼接出完整图片 URL。

### 前端示例（Fetch）
```js
// 获取项目列表并展示封面
fetch('/api/projects?limit=6')
  .then(r => r.json())
  .then(list => {
    list.forEach(p => {
      console.log(p.projectName, p.coverUrl); // coverUrl 可直接作为 <img src>
    });
  });
```

---

如果你需要我把这份文档再格式化为更详细的接口说明（请求/响应示例、错误码、字段说明），告诉我你想优先补充哪个接口，我会继续完善。
```markdown
# mamage-server

## 数据库恢复

如果你有现成的 `backup.sql`，建议把它放到项目中的 `db/backup.sql`，然后使用项目提供的恢复脚本来导入数据库：

示例（从项目根运行）：

```powershell
.\scripts\restore-db.ps1
```

脚本会尝试从 PATH 或常见安装位置查找 `mysql.exe`。如果找不到，请指定 `-MysqlPath`：

```powershell
.\scripts\restore-db.ps1 -MysqlPath 'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe'
```

或者手动执行（示例，替换为你系统的 mysql 路径）：

```powershell
# 创建数据库
"C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe" -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"
# 导入备份
cmd /c '"C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe" -u root -p mamage < "db\\backup.sql"'
```

说明：不要把 MySQL 的实际数据目录加入 Git。项目已在 `.gitignore` 中忽略常见的数据目录（如 `data/`）。

```
# mamage-server