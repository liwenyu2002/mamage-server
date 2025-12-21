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

## 提交时同步数据库结构与 role_permissions

目标：每次提交代码时，同时把 **数据库表结构（schema）** 和 **`role_permissions` 的初始化数据** 一起更新并提交到仓库，便于团队同步。

本项目提供了导出脚本，会生成/更新两个文件：

- `db/mamage_schema_only.sql`（全库 schema-only）
- `db/role_permissions_seed.sql`（仅 `role_permissions` 表的数据）

### 方式 A：手动（推荐先用这个验证一次）

确保本机已安装 MySQL Client 工具，并且 `mysqldump` 在 PATH 里（或设置 `MYSQLDUMP_PATH` 为 mysqldump.exe 的完整路径）。然后运行：

```bash
npm run db:export
```

之后正常提交即可：

```bash
git add db/mamage_schema_only.sql db/role_permissions_seed.sql
git commit -m "..."
```

### 方式 B：自动（pre-commit hook，每次 commit 自动导出并 stage）

在项目根目录运行一次（Windows PowerShell）：

```powershell
.\scripts\install-git-hooks.ps1
```

安装完成后，每次 `git commit` 都会自动执行：

1) `node scripts/export_db_artifacts.js`
2) `git add db/mamage_schema_only.sql db/role_permissions_seed.sql`

> 注意：导出脚本依赖你本地能连上数据库（使用 `.env` 里的 `DB_*` 变量）。

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
# ✅ 实际读取过的关键文件清单（仅文件名）

- package.json
- app.js
- db.js
- ecosystem.config.js
- keys.js
- validateEnv.js
- validateAi.js
- permissions.js
- users.js
- upload.js
- photos.js
- projects.js
- ai_news.js
- organizations.js
- db/mamage_schema_only.sql
- mamage_db_20251208.sql
- run_create_ai_tables.js
- create_ai_tables.sql
- check_env_vars.js
- DEPLOYMENT.md
- ENV_MANAGEMENT.md
- 20251212_make_projects_org_nullable.sql

---

# MaMage Server（mamage-server）

一个基于 Node.js + Express + MySQL 的图片管理后端：提供用户鉴权（JWT）、项目/照片管理、上传与缩略图生成、本地或腾讯云 COS 存储、RBAC 权限控制，以及 AI 新闻稿生成与图片打标的异步任务能力。

适用场景：校园新闻中心/活动相册/社团宣传等，需要“上传-归档-检索-筛图-生成文案”的后端服务。

---

## 0) ⚠️ 待补充（仓库缺失/不一致项，但不影响按本文启动）

- ⚠️ 未找到任何 `.env` / `.env.example` 文件（但代码强依赖 `.env`，启动前会校验变量）。本文提供可直接复制的 `.env` 模板，变量来源于代码读取点（`process.env.*`）。
- ⚠️ `docs/DEPLOYMENT.md` 中示例出现 `3000` 端口，但真实服务端口在 `app.js` 硬编码为 `8000`（本文以 `8000` 为准）。
- ⚠️ 旧文档里提到 `scripts/restore-db.ps1`，但当前 `scripts/` 目录中不存在该脚本；本文给出等价的手动导入 SQL 方式。

---

## 1) 快速开始（新人 10 分钟能跑起来）

> 目标：安装依赖 → 配置环境 → 初始化数据库 → 启动服务 → curl 验证接口
>
> 默认 API 端口：`8000`（来自 `app.js`）

### 1.1 安装依赖

```bash
npm install
```

### 1.2 配置环境变量（创建 .env）

在项目根目录新建 `.env`（与 `lib/validateEnv.js` 的读取路径一致），复制下面内容并按你的 MySQL 改值：

```dotenv
# 必填（启动会检查：lib/validateEnv.js）
JWT_SECRET=dev-secret-change-me

DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=mamage_user
DB_PASSWORD=mamage_pass
DB_NAME=mamage

# 推荐：本地开发建议指向本服务，用于拼接 /uploads 的完整访问地址（db.js）
# 否则会使用 db.js 里的默认 UPLOAD_BASE_URL（可能指向线上 COS 域名，导致本地返回的图片 URL 不对）
UPLOAD_BASE_URL=http://localhost:8000

# 可选：允许前端跨域来源（app.js）
CORS_ORIGIN=http://localhost:5173

# 可选：自定义上传根目录（upload.js/app.js）
# 说明：若你填写的是父目录，服务会自动拼成 <UPLOAD_ABS_DIR>/uploads
# UPLOAD_ABS_DIR=C:\\ALL\\MaMage

# 可选：在“文件已迁移到 COS、部署环境没有本地 uploads”时跳过本地文件存在性检查（photos.js/projects.js）
UPLOAD_SKIP_LOCAL_FILE_CHECK=1

# 可选：腾讯云 COS（upload.js）
# COS_SECRET_ID=
# COS_SECRET_KEY=
# COS_BUCKET=
# COS_REGION=ap-beijing
# COS_BASE_URL=https://<bucket>.cos.<region>.myqcloud.com

# 可选：AI 文本模型（ai_for_news.js / validateAi.js）
# OPENAI_API_KEY=
# AI_TEXT_API_KEY=
# AI_TEXT_MODEL=gpt-3.5-turbo
# DASHSCOPE_BASE_URL=（可选，兼容 OpenAI 协议的自定义 baseURL）
# AI_TEXT_BASE_URL=（可选）

# 可选：AI 视觉打标（ai_for_tags.js / validateAi.js）
# DASHSCOPE_API_KEY=
# AI_VISION_API_KEY=
# AI_VISION_MODEL=qwen2-vl-72b-instruct

# 可选：AI 请求行为（ai_for_news.js）
# AI_REQUEST_TIMEOUT_MS=15000
# AI_JSON_MAX_ATTEMPTS=3
```

### 1.3 初始化数据库（两种方式任选其一）

本项目使用 MySQL（连接来自 `db.js` + `config/keys.js`），默认库名 `mamage`。

#### 方式 A（推荐，新人最快）：导入带示例数据的全量 SQL

文件：`mamage_db_20251208.sql`

优点：包含 `role_permissions` 初始数据，减少权限相关报错。

**Windows（PowerShell + cmd 重定向）：**

```powershell
# 1) 创建数据库
mysql -h 127.0.0.1 -P 3306 -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"

# 2) 导入（注意：重定向在 cmd 下执行更稳定）
cmd /c "mysql -h 127.0.0.1 -P 3306 -u root -p mamage < mamage_db_20251208.sql"
```

**macOS/Linux：**

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"
mysql -h 127.0.0.1 -P 3306 -u root -p mamage < mamage_db_20251208.sql
```

> 说明：全量 SQL 里可能包含历史数据（如用户/项目/照片）。用于本地开发没问题；生产环境请自行审计后再用。

#### 方式 B：只导入表结构（更“干净”）

文件：`db/mamage_schema_only.sql`

```bash
mysql -h 127.0.0.1 -P 3306 -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"
mysql -h 127.0.0.1 -P 3306 -u root -p mamage < db/mamage_schema_only.sql
```

> 注意：schema-only 不包含 `role_permissions` 初始化数据，部分接口会因权限不足而返回 `403 forbidden`。建议随后从 `mamage_db_20251208.sql` 中复制 `role_permissions` 的 INSERT 语句执行，或手动补齐权限表。

### 1.4 初始化 AI 相关表（可选，但 AI 新闻功能需要）

若你要使用 `/api/ai/news/*`，需要 `ai_jobs/ai_results/ai_templates/ai_audit_log` 表。可直接运行仓库脚本：

```bash
node scripts/run_create_ai_tables.js
```

### 1.5 启动服务

```bash
node app.js
```

启动后，服务会：

- 校验环境变量（`lib/validateEnv.js`）
- 尝试校验 AI Key/模型（不会阻止启动，仅输出 ok/警告）（`lib/validateAi.js`）
- 在 `8000` 端口监听（`app.js`）

### 1.6 验证接口（curl）

健康检查（无需鉴权）：

```bash
curl http://localhost:8000/api/health
```

期望输出：

```json
{"status":"ok"}
```

---

## 2) 环境要求

### Node.js

- 仓库未提供 `engines` / `.nvmrc`（依据不足）。
- 依赖使用 `express@5.1.0`（见 `package.json`），建议使用 **Node.js 18+（LTS）**。

### MySQL

- schema dump 标识来自 MySQL `8.0.44`（见 `db/mamage_schema_only.sql` 头部），建议使用 **MySQL 8.0**。
- 代码使用 `mysql2/promise`。

### 其他可选依赖

- 腾讯云 COS：如需上传到 COS，需配置 COS 相关变量（见 `upload.js`、`keys.js`）。
- AI 服务：
  - 新闻稿生成：`OPENAI_API_KEY` 或 `AI_TEXT_API_KEY`（见 `ai_for_news.js`）
  - 图片打标：`DASHSCOPE_API_KEY` / `AI_VISION_API_KEY`（见 `ai_for_tags.js`）

---

## 3) 配置说明（环境变量表）

> 修改 `.env` 后需要重启 Node 进程。敏感信息（密钥/密码）不要提交到 Git。

| 变量 | 作用 | 示例 | 必填 |
|---|---|---|---|
| `JWT_SECRET` | JWT 签名密钥（用户登录 token） | `dev-secret-change-me` | 是 |
| `DB_HOST` | MySQL 主机 | `127.0.0.1` | 是 |
| `DB_PORT` | MySQL 端口 | `3306` | 是 |
| `DB_USER` | MySQL 用户名 | `mamage_user` | 是 |
| `DB_PASSWORD` | MySQL 密码（注意：空字符串会被判定为缺失并拒绝启动） | `mamage_pass` | 是 |
| `DB_NAME` | 数据库名 | `mamage` | 是 |
| `UPLOAD_BASE_URL` | 用于把 `/uploads/...` 拼成完整可访问 URL（返回给前端） | `http://localhost:8000` | 否（强烈建议） |
| `UPLOAD_ABS_DIR` | 上传根目录（可指向外置磁盘/共享目录） | `C:\\ALL\\MaMage` | 否 |
| `UPLOAD_SKIP_LOCAL_FILE_CHECK` | 跳过本地文件存在性检查（适用于“只存 COS、不落本地盘”的部署） | `1` | 否 |
| `CORS_ORIGIN` | 允许的前端 Origin（CORS） | `http://localhost:5173` | 否 |
| `COS_SECRET_ID` | 腾讯云 COS SecretId | `AKIDxxxx` | 否 |
| `COS_SECRET_KEY` | 腾讯云 COS SecretKey | `xxxx` | 否 |
| `COS_BUCKET` | COS bucket | `mamage-img-123456` | 否 |
| `COS_REGION` | COS region | `ap-beijing` | 否 |
| `COS_BASE_URL` | COS 访问域名（可选，默认按 bucket+region 拼） | `https://<bucket>.cos.<region>.myqcloud.com` | 否 |
| `OPENAI_API_KEY` | 文本模型 Key（新闻稿生成） | `sk-...` | 否 |
| `AI_TEXT_API_KEY` | 文本模型 Key（优先于 OPENAI_API_KEY） | `sk-...` | 否 |
| `AI_TEXT_MODEL` | 文本模型名 | `gpt-3.5-turbo` | 否 |
| `DASHSCOPE_BASE_URL` | OpenAI 兼容 baseURL（可用于 DashScope 等） | `https://dashscope.aliyuncs.com/compatible-mode/v1` | 否 |
| `AI_TEXT_BASE_URL` | 文本模型 baseURL（备用） | `https://.../v1` | 否 |
| `DASHSCOPE_API_KEY` | 视觉模型 Key（图片打标） | `sk-...` | 否 |
| `AI_VISION_API_KEY` | 视觉模型 Key（优先于 DASHSCOPE_API_KEY） | `sk-...` | 否 |
| `AI_VISION_MODEL` | 视觉模型名 | `qwen2-vl-72b-instruct` | 否 |
| `AI_REQUEST_TIMEOUT_MS` | AI 请求超时（新闻稿生成） | `15000` | 否 |
| `AI_JSON_MAX_ATTEMPTS` | 强制 JSON 输出的重试次数（新闻稿生成） | `3` | 否 |

---

## 4) 数据库说明

### 使用的数据库

- MySQL
- 默认库名：`mamage`（来自 `db.js` 默认值与 `lib/validateEnv.js` 校验）

### 建表/迁移方式

当前项目不使用 ORM/迁移框架（无 Sequelize/Prisma 等），采用 SQL 文件导入/手动执行：

- 表结构（schema-only）：`db/mamage_schema_only.sql`
- 全量数据（含权限等 seed）：`mamage_db_20251208.sql`
- AI 表创建脚本：`scripts/create_ai_tables.sql` + `scripts/run_create_ai_tables.js`
- 迁移示例（仅包含 projects 的一个迁移）：`db/migrations/20251212_make_projects_org_nullable.sql`

### db 目录约定

- `db/` 用于存放 SQL 文件与导出产物，便于团队同步。
- `npm run db:export` 会更新：`db/mamage_schema_only.sql` 与 `db/role_permissions_seed.sql`。
- 如有备份文件，可放到 `db/backup.sql`（或按你自己的命名），再用 README 里的 `mysql` 导入方式恢复。

### 核心表（5~10 个）与关系

来自 `db/mamage_schema_only.sql` 与代码查询：

- `users`：用户表，`role` 决定权限；接口登录/注册使用该表（`users.js`）
- `role_permissions`：RBAC 权限表，按 `role + permission` 授权（`permissions.js`）
- `organizations`：组织/单位（`organizations.js`）
- `projects`：项目/活动（`projects.js`）
- `photos`：照片，关联 `projects.id`；上传后生成缩略图并写入（`upload.js` / `photos.js`）
- `invitations`：邀请码，用于给用户提升角色（`users.js`）
- `ai_jobs` / `ai_results`：AI 新闻稿生成异步任务与结果（`ai_news.js`、`ai_job_worker.js`）
- `ai_templates` / `ai_audit_log`：AI 模板与审计（`create_ai_tables.sql`；前者存 Prompt 模板，后者做调用审计/排查）

### 多环境连接方式

- 代码统一通过环境变量 `DB_*` 连接（`keys.js`、`db.js`）
- 生产推荐使用 PM2 注入（`ecosystem.config.js`）或服务器 `.env`（见 `ENV_MANAGEMENT.md`）

---

## 5) API 概览（面向使用者）

### 基础地址

- 本地：`http://localhost:8000`
- API 前缀：`/api`（来自 `app.js`）

### 鉴权方式（JWT Bearer）

- 登录成功返回 `token`（`users.js`）
- 请求头携带：`Authorization: Bearer <token>`
- 权限校验：基于 `role_permissions`（`permissions.js`）

### 常用接口（按模块）

#### Health

- `GET /api/health`：健康检查

#### Users（登录/注册/个人信息）

- `POST /api/users/register`：注册（默认 role 为 `visitor`，可带 `invite_code` 提升角色）
- `POST /api/users/login`：登录（email 或 student_no + password）
- `GET /api/users/me`：获取当前用户（需 Bearer token）
- `PUT /api/users/me`：更新资料（需 Bearer token）
- `PUT /api/users/me/password`：修改密码（需 Bearer token）
- `POST /api/users/invitations`：管理员创建邀请码（需要权限 `users.invitations.create`）
- `POST /api/users/me/invite`：使用邀请码提升角色

登录示例：

```bash
curl -X POST http://localhost:8000/api/users/login \\
  -H "Content-Type: application/json" \\
  -d "{\\"email\\":\\"admin@example.com\\",\\"password\\":\\"YourPassword123\\"}"
```

> 注意：旧版 README 写了 `Admin@1234`，但在代码与 SQL 中找不到该明文密码的依据；如果你导入了全量 SQL，请自行重置密码（见 FAQ）。

#### Projects（项目）

- `GET /api/projects?limit=10`：项目列表（会按用户 `organization_id` 做隔离）
- `GET /api/projects/scenery`：获取 “scenery” 项目集合（若 DB 无 `type` 字段会回退）

#### Photos（照片）

- `GET /api/photos?limit=10&projectId=<id>&random=1&type=normal`（需要权限 `photos.view`）
- `POST /api/photos/delete`（需要权限 `photos.delete`）
- `POST /api/photos/zip`（需要权限 `photos.view`，打包下载）

#### Upload（上传）

- `POST /api/upload/photo`（需要权限 `upload.photo`）
  - 表单字段：`file`（必填），`projectId`（可选），`title`、`type`、`tags`（JSON 字符串）
  - 返回示例：
```
{ "id": 172, "projectId": 4, "url": "/uploads/2025/12/08/xxx.jpg", "thumbUrl": "/uploads/2025/12/08/thumbs/thumb_xxx.jpg", "title": "", "type": "normal" }
```
  - 说明：若 COS 可用且上传成功，`url`/`thumbUrl` 会是完整 COS 地址（`https://...`），否则为 `/uploads/...` 相对路径。
- `GET /api/projects` — 首页项目列表（返回包含 `coverUrl` / `coverThumbUrl` 的项目数组）
- `GET /api/projects/:id` — 项目详情，包含 `photos` 数组（每张图含 `fullUrl` / `fullThumbUrl`）
- `GET /api/photos` — 照片列表（支持 `projectId`、`limit`、`random`、`type`）

---

## 6) 上传/静态资源/对象存储

### 本地上传目录与访问方式

- 上传落盘目录（默认）：项目根的 `uploads/`（见 `upload.js`）
- 静态访问前缀：`/uploads`（见 `app.js`）
- 文件路径组织：
  - `projectId=1`：`uploads/scenery/*`
  - 其他：按日期分目录 `uploads/YYYY/MM/DD/*`，缩略图放在同目录的 `thumbs/` 子目录

### COS（腾讯云对象存储）如何启用

在 `.env` 配置以下变量（见 `upload.js`）：

- `COS_SECRET_ID`
- `COS_SECRET_KEY`
- `COS_BUCKET`
- `COS_REGION`
- （可选）`COS_BASE_URL`

行为：

- 若 COS 配置完整：上传后会把原图和缩略图上传到 COS，并尝试删除本地文件；数据库写入 COS 的完整 URL。
- 若 COS 未配置：保留本地 `/uploads/...` 路径。

### 常见问题要点

- URL 生成：建议在本地开发显式设置 `UPLOAD_BASE_URL=http://localhost:8000`，否则可能指向默认域名导致图片 URL 不指向本机。
- 跨域：前端域名与端口变更时设置 `CORS_ORIGIN`（见 `app.js`）。

---

## 7) 部署与运维

### 生产启动（PM2）

仓库提供 PM2 配置：`ecosystem.config.js`

```bash
npm install --omit=dev
pm2 start ecosystem.config.js --env production
pm2 logs mamage-server
```

PM2 日志默认写到：

- `/var/log/mamage-server/out.log`
- `/var/log/mamage-server/error.log`

> Windows 部署：可继续使用 `node app.js` 或自行配置 NSSM/Windows Service；仓库未提供官方 Windows service 脚本。

### 反向代理（通用建议）

仓库未提供 nginx 配置文件。通用要点：

- `/api/*` 反代到 `127.0.0.1:8000`
- `/uploads/*` 静态（若你把 uploads 交给 nginx 直出，需要指到同一目录）
- 适当配置：
  - `client_max_body_size`（避免上传 413）
  - `gzip`（可选）
  - CORS（尽量由后端控制，见 `CORS_ORIGIN`）

### 常用排障命令

- 检查 env 是否正确加载（不泄露密钥）：

```bash
node scripts/check_env_vars.js
```

- 检查某个用户的权限（默认 userId=8）：

```bash
node scripts/check_permissions.js 8
```

- 扫描并处理 pending 的 AI jobs（用于异步补偿/手工跑）：

```bash
node scripts/process_pending_ai_jobs.js
```

---

## 8) 常见问题 FAQ（贴合仓库）

1) 启动直接报：`❌ 应用启动失败：缺少必需的环境变量`

- 原因：启动时会在 `lib/validateEnv.js` 校验 `JWT_SECRET/DB_*`；并且 `DB_PASSWORD` 不能为空字符串。
- 排查：
  - 确认项目根目录存在 `.env`
  - 确认 `.env` 中 `DB_PASSWORD` 非空且与 MySQL 账号匹配
  - 运行：`node -e "require('./lib/validateEnv').validateEnvironment(true)"`

2) 端口不通/你以为是 3000 但实际是 8000

- 原因：真实监听端口在 `app.js` 固定 `8000`。
- 排查：访问 `http://localhost:8000/api/health`；别用旧文档里的 `3000`。

3) 数据库连不上（`ER_ACCESS_DENIED_ERROR` / `ECONNREFUSED`）

- 排查：
  - 检查 MySQL 服务是否启动、端口是否是 `3306`
  - 检查 `.env` 的 `DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME`
  - 连接测试：`mysql -h 127.0.0.1 -P 3306 -u <user> -p`

4) 注册接口返回：`DB_SCHEMA_ORG_FIELD` 或提示 organization_id 必填/无默认值

- 原因：你的数据库 schema 里 `users.organization_id` 可能是 `NOT NULL`，但注册时没传 `organization_id`。
- 解决方案（任选）：
  - 注册时在 body 里带 `organization_id`（需要该 organization 存在）：`POST /api/users/register`
  - 或将列改为可空（开发环境常用）：

```sql
ALTER TABLE users MODIFY COLUMN organization_id INT UNSIGNED NULL;
```

5) 接口返回 `401 Missing Authorization Bearer token`

- 原因：路由使用 `permissions.js` 的 `requirePermission()`，需要 `Authorization: Bearer <token>`。
- 排查：
  - 先登录 `POST /api/users/login` 拿 token
  - 请求头加上：`Authorization: Bearer ...`

6) 接口返回 `403 forbidden`（尤其是上传/AI）

- 原因：RBAC 权限来自 `role_permissions` 表（`permissions.js`）。
- 排查：
  - 确认导入了 `mamage_db_20251208.sql`（包含 role_permissions seed）
  - 或用 `node scripts/check_permissions.js <userId>` 查看当前用户权限
  - 上传需要 `upload.photo`；AI 新闻需要 `ai.generate`

7) 本地上传成功，但前端图片打不开/URL 指向奇怪域名

- 原因：URL 拼接使用 `UPLOAD_BASE_URL`（见 `db.js`）；若未设置，会使用代码里的默认值（可能是线上 COS 域名）。
- 解决：本地开发把 `.env` 里 `UPLOAD_BASE_URL` 设为 `http://localhost:8000`。

8) 上传报 413 / 大文件失败

- 后端当前未显式设置上传大小限制（上传走 multer），但如果你在 nginx/网关前面，常见是代理限制。
- 解决：提高 nginx 的 `client_max_body_size`，或在上游网关调整限制。

9) AI 新闻生成一直 pending/没有结果

- 原因：
  - 你没创建 AI 表（`ai_jobs/ai_results/...`）
  - 或没有配置 `OPENAI_API_KEY/AI_TEXT_API_KEY`，会回退到 mock（仍应返回结果，但内容为示例）
- 排查：
  - 先跑：`node scripts/run_create_ai_tables.js`
  - 再检查：`SELECT * FROM ai_jobs ORDER BY id DESC LIMIT 5;`
  - 手工处理 pending：`node scripts/process_pending_ai_jobs.js`

10) AI 图片打标报错/超时

- 原因：图片打标读取 `DASHSCOPE_API_KEY` / `AI_VISION_API_KEY`，并且会先拉图转 base64（可能受网络影响）（见 `ai_for_tags.js`）。
- 排查：
  - 配好 `DASHSCOPE_API_KEY` 和 `AI_VISION_MODEL`
  - 检查上传返回的 `thumbUrl` 是否可被服务器访问（本地建议 `UPLOAD_BASE_URL=http://localhost:8000`）
  - 看服务端日志输出 `[ai_for_tags] failed to fetch & encode image...`

---

## 9) 贡献与许可证

### 贡献方式

- 新功能/修复建议走 PR
- 代码风格：仓库未配置 eslint/prettier/test runner（见 `package.json`），提交前建议至少：
  - 本地跑 `node app.js` 做一次启动自检
  - 核心路径（登录/上传/列表）用 curl 走一遍

### License

- ISC（见 `package.json`）

---

如果你希望我把 “⚠️ 缺失的 .env.example” 也补齐成文件（并确保不包含任何真实密钥），我可以直接在仓库里创建一个可提交的 `.env.example` 模板。

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
AI_VISION_MODEL=
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