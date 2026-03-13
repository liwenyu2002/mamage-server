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

## 2.2 安装依赖

```bash
npm install
```

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

## 2.4 初始化数据库

1) 创建数据库：

```bash
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"
```

2) 导入表结构：

```bash
mysql -u root -p mamage < db/mamage_schema_only.sql
```

3) 导入权限种子数据（必须）：

```bash
mysql -u root -p mamage < db/role_permissions_seed.sql
```

如果不导入第 3 步，很多接口会返回 `403 forbidden`。

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

## 3. 新开发者第一天建议流程

## 3.1 创建组织（若数据库为空）

`users.organization_id` 在当前 schema 为必填，建议先建组织：

```sql
INSERT INTO organizations(name, slug) VALUES ('默认组织', 'default-org');
```

## 3.2 注册一个账号

调用：`POST /api/users/register`，带上 `organization_id`。

示例：

```json
{
  "name": "dev-admin",
  "password": "abc12345",
  "student_no": "20260001",
  "email": "dev@example.com",
  "organization_id": 1
}
```

## 3.3 开发期提升为管理员（可选）

```sql
UPDATE users SET role = 'admin' WHERE email = 'dev@example.com';
```

然后重新登录拿新 token。

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

现象：数据库明明有数据，但接口返回空。

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

```txt
app.js                    # 服务入口
routes/                   # 路由层
lib/                      # 权限/AI worker/相似度工具
ai_function/              # AI 适配实现
db/                       # 数据库结构与权限种子
scripts/                  # 迁移/导出/检查脚本
docs/API.md               # 前端接口文档
```
111