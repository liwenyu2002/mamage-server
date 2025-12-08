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

## 默认管理员账号

- 邮箱：`admin@example.com`
- 密码：`Admin@1234`

如果密码遗忘，可以在项目根执行以下命令重置/创建该账号：

```powershell
node .\scripts\create_admin_user.js --email admin@example.com --password Admin@1234 --name "超级管理员"
```

脚本会在 `users` 表中创建或更新此账号，并确保角色为 `admin`。建议上线环境及时更改密码或创建新的管理员。


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
  {
    "projectName": "名称",
    "description": "描述",
    "eventDate": "2025-11-17",
    "tags": ["校庆", "活动"]
  }
  ```
  - `tags` 支持数组或逗号分隔字符串，后端会存储为 JSON 数组。
- `POST /api/projects/:id/update` — 更新项目，body 字段与创建相同，可覆盖 `tags`。
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

## 开启反向代理（以 ngrok 为例）

当需要把本地 `node app.js` 暴露到公网进行联调或手机访问时，可以使用 ngrok 之类的反向代理服务。下面以 ngrok 为例说明：

1. 到 https://ngrok.com/ 注册账号并下载客户端，安装后在 PowerShell 中执行一次登陆：

  ```powershell
  ngrok config add-authtoken <你的-ngrok-token>
  ```

2. 启动后端（默认监听 3000 端口）：

  ```powershell
  node app.js
  ```

3. 启动隧道，把本地 3000 暴露出去：

  ```powershell
  ngrok http 3000
  ```

4. ngrok 会输出一个 `https://xxxxx.ngrok-free.app`/`ngrok-free.dev` 的公网地址。复制该地址：
  - 把 `.env` 或系统环境变量中的 `UPLOAD_BASE_URL` 设置为此地址（例如 `https://demo.ngrok-free.app`），然后重启后端，确保生成的图片 URL 是公网可访问的。
  - 前端请求同样改为指向该地址，比如 `fetch('https://demo.ngrok-free.app/api/photos')`。

5. ngrok 需要保持终端窗口打开才能持续转发。若需要长期运行，可使用付费计划或在服务器上运行其他反向代理（如 Cloudflare Tunnel、frp 等），步骤与上面类似：只要确保 `UPLOAD_BASE_URL` 与实际公网入口一致即可。

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

## 本地开发：使用 `.env`

建议在本地开发时把敏感配置放到项目根的 `.env` 文件（请勿提交该文件）。仓库已包含 `.env.example` 作为示例。步骤：

1. 复制并编辑 `.env`：
```powershell
copy .env.example .env
# 用编辑器填入真实的值（不要把 .env 提交到仓库）
```

2. 安装依赖（若尚未安装 `dotenv`）：
```powershell
npm install
```

3. 启动服务（`app.js` 会自动加载 `.env`）：
```powershell
node app.js
```

备注：`.env` 已在 `.gitignore` 中被忽略。如果你在生产环境，请通过系统环境变量或进程管理器（PM2 / Windows Service）配置真实凭据，避免在生产用明文 `.env`。

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