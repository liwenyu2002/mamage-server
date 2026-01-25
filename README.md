# MaMage Server (mamage-server)

Node.js + Express + MySQL 的图库管理后端：提供登录鉴权（JWT）、项目/照片管理、上传与缩略图、本地或腾讯云 COS 存储、RBAC 权限控制，以及（可选）AI 新闻生成/图片打标的异步任务。

- 默认端口：`8000`
- Health：`GET /api/health` → `{"status":"ok"}`

---

## 快速开始（本地开发 5–10 分钟）

### 1) 环境要求
- Node.js：建议 18+（LTS）
- MySQL：建议 8.0+（Windows可以在官网下载https://dev.mysql.com/downloads/mysql/，需要注册登录）
### 2) 安装依赖
```bash
npm install
```
### 3) 配置环境变量（.env）
在项目根目录复制一份：
```bash
复制代码
cp .env.example .
```
填写正确AI相关的key、数据库的账号密码等信息
# 本地建议配置，否则返回的图片 URL 可能不指向本机
UPLOAD_BASE_URL=http://localhost:8000

### 4) 初始化数据库
首先你需要安装好mysql，然后在mysql中新建一个空库
库的账号密码端口等需要填在环境变量.env中才能保证后端正确链接数据库
```
DB_HOST=
DB_PORT=
DB_USER=
DB_PASSWORD=
DB_NAME=
```
建好库后，导入表结构 + 导入 role_permissions 权限数据
```bash
# 1) 创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS mamage DEFAULT CHARACTER SET utf8mb4;"
# 2) 导入表结构（schema-only）
mysql -u root -p mamage < db/mamage_schema_only.sql
# 3) 导入权限数据（只包含 role_permissions 表的数据）
mysql -u root -p mamage < db/role_permissions_seed.sql
```
说明：如果你只导入 schema-only，不导入 `db/role_permissions_seed.sql`，很多需要 RBAC 的接口会因为没有权限数据而返回 403。

Windows配置mysql可能会遇到很多问题，可以让ai协助解决

### 5) 启动服务
```bash
复制代码
node app.js
```
### 6) 验证（health）
```bash
curl http://localhost:8000/api/health
```