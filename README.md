# MaMage Server

Node.js + Express + MySQL 的图片管理后端服务。

- 默认端口：`8000`
- 健康检查：`GET /api/health` -> `{ "status": "ok" }`
- 前端对接文档：[`docs/API.md`](./docs/API.md)

---

## 1. 你会得到什么

本服务当前提供：

- 用户注册/登录（JWT）
- RBAC 权限控制（`role_permissions`）
- 项目与照片管理
- 图片上传到腾讯 COS（含缩略图）
- 分享链接
- 相似图分组（基于 embedding）
- AI 新闻生成（可选）
- AI 图片打标（可选）

---

## 2. 快速启动（本地 5~10 分钟）

## 2.1 环境要求

- Node.js 18+
- MySQL 8.0+

可选（不影响服务启动）：

- Python 3（用于相似图 embedding 的本地提取脚本）
- Python 依赖（用于人脸检测自动推理）

## 2.2 安装依赖

```bash
npm install
```

如需启用后端自动人脸检测（`POST /api/faces/detect` 在不传 `faces` 时自动检测）：

```bash
npm run face:deps
```

如需把历史照片批量分析并写入 `photo_faces`：

```bash
npm run face:backfill -- --limit=100 --orgId=1
```

说明：
- 上传新照片后，会自动异步执行人脸检测与聚类匹配（写入 `photo_faces` 和 `person_id`）。
- 历史照片回填默认开启聚类匹配；如只想写框不做匹配，可加 `--withCluster=0`。
- 同人容易被拆分时，可调低 `FACE_CLUSTER_MATCH_THRESHOLD`（例如 `0.32~0.40`）。
- 若历史聚类结果已混乱，可用 `--resetOrg=1` 先清空该组织的人脸结果再全量重建。
- 支持手动人物合并：`POST /api/persons/merge`。
- 支持按组织在线调阈值（持久化 DB）：`GET/POST /api/faces/cluster/config`。

## 2.3 配置环境变量

复制示例文件：

```bash
cp .env.example .env
```

最小必填（缺失会导致启动失败）：

```env
JWT_SECRET=
DB_HOST=
DB_PORT=
DB_USER=
DB_PASSWORD=
DB_NAME=
```

建议补充：

```env
CORS_ORIGIN=http://localhost:5173
UPLOAD_BASE_URL=https://<your-cos-domain>
```

如果要使用上传接口（`POST /api/upload/photo`），还需要：

```env
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=
COS_BASE_URL=https://<your-bucket>.cos.<region>.myqcloud.com
```

如果要使用 AI：

```env
# 文本生成（AI 新闻）
OPENAI_API_KEY= 或 AI_TEXT_API_KEY=
AI_TEXT_MODEL=

# 视觉分析（AI 打标）
AI_VISION_API_KEY= 或 DASHSCOPE_API_KEY=
AI_VISION_MODEL=qwen2-vl-72b-instruct
```

## 2.4 初始化数据库（推荐：迁移 + 最小 Seed）

1. 创建数据库：

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"
```

2. 一键执行迁移与最小开发数据注入：

```bash
npm run db:bootstrap
```

这一步会执行：
- `npm run db:migrate`：按 `scripts/migrations/*.sql` 做幂等迁移
- `npm run db:seed`：注入最小开发数据（默认组织 + 默认开发管理员 + 角色权限）

如只想单独执行 seed，可运行：`npm run db:seed`

## 2.5 启动服务

```bash
node app.js
```

看到类似日志说明成功：

```txt
API server listening on http://localhost:8000
```

## 2.6 验证

```bash
curl http://localhost:8000/api/health
```

预期：

```json
{"status":"ok"}
```

---

## 3. 开发机快速调试（推荐）

执行：

```bash
npm run db:bootstrap
```

默认会准备以下开发账号（可直接登录）：
- `student_no`: `devadmin`
- `email`: `dev-admin@example.com`
- `password`: `Dev123456`
- `role`: `admin`

可通过环境变量覆盖：
- `DEV_SEED_ORG_NAME`
- `DEV_SEED_ORG_SLUG`
- `DEV_SEED_ADMIN_NAME`
- `DEV_SEED_ADMIN_STUDENT_NO`
- `DEV_SEED_ADMIN_EMAIL`
- `DEV_SEED_ADMIN_PASSWORD`
- `DEV_SEED_ADMIN_RESET_PASSWORD=1`（已存在账号时重置密码）

注意：`db:seed` 默认在 `NODE_ENV=production` 下拒绝执行；如确需执行，需显式设置 `SEED_ALLOW_IN_PROD=1`。

---

## 4. 常用接口（用于快速自测）

- 登录：`POST /api/users/login`
- 当前用户：`GET /api/users/me`
- 项目列表：`GET /api/projects/list`
- 项目详情：`GET /api/projects/:id`
- 上传图片：`POST /api/upload/photo`
- 相似图（简版）：`GET /api/similarity/groups/simple?projectId=<id>`

完整接口说明见：[`docs/API.md`](./docs/API.md)

---

## 5. 常见问题

## 5.1 启动直接失败（环境变量缺失）

现象：启动时报缺少 `JWT_SECRET` 或 DB 配置。

处理：检查 `.env` 最小必填项是否都配置。

## 5.2 接口大量 403

现象：登录成功但很多接口 `forbidden`。

处理：确认已导入 `db/role_permissions_seed.sql`，并检查用户 `role`。

## 5.3 上传返回 `COS_NOT_CONFIGURED`

现象：`POST /api/upload/photo` 返回 503。

处理：补全 COS 相关环境变量（`COS_SECRET_ID/KEY/BUCKET/REGION`）。

## 5.4 分享/项目/照片查不到数据

现象：数据库明明有数据，但接口返回空1。

处理：检查当前用户 `organization_id` 与数据的 `organization_id` 是否一致。

## 5.5 相似图为空

可能原因：

- 该项目照片尚未生成 embedding
- Python/torch 环境不可用导致 embedding 生成失败（不影响主流程，但相似图会无数据）

---

## 6. 部署提示（简版）

- 生产建议使用 PM2：`ecosystem.config.js`
- 已有 CI/CD 工作流：`.github/workflows`
- 部署前至少验证：
- `GET /api/health` 正常
- 登录正常
- 关键业务接口（项目列表、上传）正常

---

## 7. 目录说明

```txt![1773827659866](image/README/1773827659866.png)![1773827662212](image/README/1773827662212.png)![1773827663915](image/README/1773827663915.png)
app.js                    # 服务入口
routes/                   # 路由层
lib/                      # 权限/AI worker/相似度工具
ai_function/              # AI 适配实现
db/                       # 数据库结构与权限种子
scripts/                  # 迁移/导出/检查脚本
docs/API.md               # 前端接口文档
```
111
