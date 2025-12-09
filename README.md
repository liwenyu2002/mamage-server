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

# 项目名称

后端算法服务（MaMage Server） — 基于 Node.js 的图像管理与算法后端

## 项目简介（Overview）
- 本项目为校园新闻/活动图片提供后端存储、处理与算法能力：包括图片上传、缩略图生成、可选对象存储（Tencent COS）、以及 AI 多模态图像分析并写回数据库（description 与 tags）。
- 后端负责流量接收、缩略图生成、本地/远程存储、权限校验及对外 HTTP API；算法模块（ai_for_tags）对图片做视觉+文本分析，后端通过队列异步调度并写回结果，供前端直接展示。

## 技术栈（Tech Stack）
- 语言与运行环境：Node.js（CommonJS，建议 Node 16+/18+）
- 后端框架：Express
- 数据库：MySQL（通过 `mysql2/promise` 使用）
- 文件处理：multer（上传），sharp（缩略图）
- 对象存储（可选）：Tencent COS（`cos-nodejs-sdk-v5`）
- AI 客户端：`openai`（兼容 DashScope / qwen-vl 类模型）
- 其它：UUID（`uuid`）、JWT（`jsonwebtoken`）、bcrypt（`bcryptjs`）

## 目录结构（Project Structure）
```text
/
├─ app.js                         // 程序入口：路由挂载、静态 /uploads 暴露
├─ db.js                          // MySQL 连接池与 buildUploadUrl 工具
├─ config/keys.js                 // 集中读取环境变量（JWT/COS等）
├─ routes/
│  ├─ upload.js                   // 上传接口：multer、sharp、COS 上传、写 photos 表、enqueue AI
│  ├─ photos.js                   // 照片查询接口（projectId、random、type 等）
│  ├─ projects.js                 // 项目接口与封面选择逻辑（优先 '合影' + '推荐'）
│  └─ users.js                    // 用户注册/登录/鉴权（JWT）
├─ lib/
│  ├─ permissions.js              // 基于数据库的权限检查（role_permissions）
│  └─ ai_tags_worker.js           // AI 分析队列：调度 ai_for_tags.analyze 并写回 DB
├─ ai_function/ai_for_tags/
│  └─ ai_for_tags.js              // AI 多模态分析核心模块（analyze 函数）
├─ uploads/                       // 本地 uploads（可通过 UPLOAD_ABS_DIR 配置）
└─ .env.example                   // 本地开发示例（占位）
```

## 核心算法说明（Algorithms）

### 1. ai_for_tags 模块（`ai_function/ai_for_tags/ai_for_tags.js`）
- 模块名：ai_for_tags
- 功能：对图片进行多模态视觉分析，输出中文 description 与标签列表（tags），并提供 AI recommended / AI rejected 的选片判定要点。
- 输入：`imageUrl`（String）— 网络 URL 或可访问的图片地址；模块会在必要时下载图片并转成 data URL 发给模型。
- 输出：`{ raw, description, tags }`
  - `raw`（String）：模型原始输出（用于调试）。
  - `description`（String|null）：约 30 字的中文新闻风格描述。
  - `tags`（Array|null）：标签数组，例如 `['AI recommended','中景','室外']`。
- 内部思路：先尝试将远程图片拉下并转 base64，避免模型直接访问外网失败；然后调用兼容 OpenAI 的 chat completion 接口（默认模型 `qwen2-vl-72b-instruct`），严格格式化 prompt 并解析返回文本。
- 性能要点：主要耗时为网络 I/O（图片下载 + 模型 API 调用）；建议低并发或串行调用以避免配额耗尽（仓库中的 `ai_tags_worker` 默认并发 1）。

### 2. AI 分析调度（`lib/ai_tags_worker.js`）
- 模块名：ai_tags_worker
- 功能：FIFO 队列调度图片分析任务，执行 HEAD 检查、调用 `analyze()`，并把结果写回 `photos` 表。
- 输入：`enqueue({ id, relPath, absPath })`，其中 `id` 为 photos 表主键，`relPath` 通常为 `/uploads/...`。
- 输出：无（模块会更新数据库并打印日志）。
- 内部思路：使用数组 `queue` 与 `CONCURRENCY` 控制并发，串行取任务执行 headRequest 与 analyze，再更新 DB；发生错误时在控制台打印详细信息。
- 性能要点：当前 `CONCURRENCY = 1`，如需更高吞吐需加入重试、限流与监控机制。

## 接口与使用方式（API & Usage）

> 假设服务运行在 `http://localhost:3000`

主要接口摘要：
- `POST /api/users/login` — 用户登录（返回 `{ id, token, username, role, permissions }`）
- `POST /api/upload/photo` — 上传图片（multipart/form-data，受权限保护）
  - 字段：`file`（必填），`projectId`（可选），`title`、`type`、`tags`（JSON 字符串）
  - 返回示例：
```json
{ "id": 172, "projectId": 4, "url": "/uploads/2025/12/08/xxx.jpg", "thumbUrl": "/uploads/2025/12/08/thumbs/thumb_xxx.jpg", "title": "", "type": "normal" }
```
  - 说明：若 COS 可用且上传成功，`url`/`thumbUrl` 会是完整 COS 地址（`https://...`），否则为 `/uploads/...` 相对路径。
- `GET /api/projects` — 首页项目列表（返回包含 `coverUrl` / `coverThumbUrl` 的项目数组）
- `GET /api/projects/:id` — 项目详情，包含 `photos` 数组（每张图含 `fullUrl` / `fullThumbUrl`）
- `GET /api/photos` — 照片列表（支持 `projectId`、`limit`、`random`、`type`）

调用示例（PowerShell）：
```powershell
# 登录
curl.exe --% -X POST http://localhost:3000/api/users/login -H "Content-Type: application/json" -d "{\"email\":\"admin@example.com\",\"password\":\"Admin@1234\"}"

# 使用返回的 token 上传图片
curl.exe --% -X POST http://localhost:3000/api/upload/photo -H "Authorization: Bearer <TOKEN>" -F "file=@C:\path\to\img.jpg" -F "projectId=4"
```

## 环境要求与安装（Environment & Installation）
- Node.js（建议 v16+/v18+）
- MySQL（5.7+ / 8.x 推荐）
- 可选：Tencent COS 账号与凭证（若要启用远程对象存储）
- 可选：AI 服务 API Key（DashScope / OpenAI）

安装步骤：
```bash
git clone <repo-url>
cd mamage-server
npm install
```
配置：复制 `.env.example` 为 `.env` 并填写实际值，或在生产使用系统环境变量。然后启动：
```powershell
node app.js
```

数据库：请确保 MySQL 可用并导入必要表结构（仓库内有 `db/backup.sql` 可作参考）。TODO：项目当前缺少自动 migration 脚本，建议手动导入或补充迁移工具。

## 配置说明（Configuration）
主要配置入口：`config/keys.js`（集中读取环境变量），以及可选的本地 `.env`（复制 `.env.example` 并填写）。

关键环境变量（示例）
```dotenv
JWT_SECRET=please-change-this-secret
UPLOAD_ABS_DIR=
UPLOAD_BASE_URL=
# Tencent COS
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=
COS_BASE_URL=
# AI
DASHSCOPE_API_KEY=
OPENAI_API_KEY=
VISION_MODEL=
```

注意：不要将真实密钥提交到仓库；生产环境建议使用 Secret Manager 或进程管理器注入环境变量。

## 运行与调试（Run & Development）
- 启动（开发）：
```powershell
node app.js
```
- 生产：建议使用 PM2 / Windows Service / systemd 等进程管理器部署并在服务配置中注入环境变量。
- 测试：当前仓库未包含自动化测试脚本（`npm test` 未配置）。建议为关键逻辑新增单元测试（Jest / Mocha）。

## 日志与错误处理（Logging & Error Handling）
- 日志：当前通过 `console.log` / `console.error` 输出到终端；在生产请用进程管理器或日志收集系统（Filebeat/ELK）收集。
- 常见错误响应：
  - 参数校验失败：HTTP 400，响应含 `error` 字段。
  - 未授权：HTTP 401，示例 `{ "error": "Missing Authorization Bearer token" }`。
  - 服务器错误：HTTP 500，示例 `{ "error": "Internal server error" }`。
  - AI 分析错误：`ai_tags_worker` 在控制台打印详细上下文；可启用数据库表 `photo_ai_errors` 做持久化记录（`ensureAiErrorTable()` 提供建表 SQL）。

## 后续扩展与注意事项（Extension & Notes）
1. 新增算法模块：在 `ai_function/` 下新增子目录并导出 `analyze(imageUrl)` 函数，修改或扩展 `ai_tags_worker` 以支持调用。 
2. 提高吞吐：`ai_tags_worker` 默认为串行（`CONCURRENCY = 1`），如需更高吞吐需加入重试、限流、后退策略与监控。 
3. 数据库迁移：建议引入 migration 工具（如 `knex` / `sequelize` / `umzug`）以版本化管理 schema。 
4. 对象存储迁移：如果已有大量本地文件，需实现幂等迁移脚本（dry-run + commit 模式），将文件上传 COS 并更新 `photos.url` / `photos.thumb_url`。 
5. 密钥管理：生产环境优先使用 Secret Manager 或短期 STS，避免把长时效密钥写入仓库或 .env。 

---
如果你需要我继续：
- 提供 PM2 `ecosystem.config.js` 示例并说明如何注入环境变量；
- 或实现历史文件迁移脚本（支持 dry-run）；
- 或把 `db.js` 改为环境变量驱动并添加简单 migration。请选择要优先完成的项。
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