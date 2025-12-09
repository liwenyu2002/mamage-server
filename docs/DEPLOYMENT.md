<!-- docs/DEPLOYMENT.md -->
# CI/CD 部署指南

本文档说明如何配置 GitHub Actions CI/CD 并部署到 ECS。

## 总体流程

```
GitHub 推送到 main
  ↓
GitHub Actions 触发
  ├─ 运行测试和依赖检查
  ├─ 编译/验证代码
  └─ SSH 连接到 ECS
      ├─ 拉取最新代码 (rsync)
      ├─ 安装依赖
      ├─ 验证环境变量
      └─ PM2 重启应用
```

## 第 1 步：在 GitHub 配置 Secrets

在你的 GitHub 仓库设置中添加以下 Secrets（`Settings` → `Secrets and variables` → `Actions`）：

### 部署相关 Secrets（必需）

| Secret 名称 | 说明 | 示例 |
|----------|------|-----|
| `DEPLOY_SSH_KEY` | ECS 的 SSH 私钥（用于 GitHub Actions 连接） | `-----BEGIN RSA PRIVATE KEY-----...` |
| `DEPLOY_HOST` | ECS 的 IP 地址或域名 | `123.45.67.89` 或 `ecs.example.com` |
| `DEPLOY_USER` | ECS 上的用户名 | `liwy` 或 `ubuntu` |
| `DEPLOY_PORT` | SSH 端口 | `22`（默认）或其他端口 |

### 生成 SSH 密钥对

在本地运行：

```bash
# 生成 SSH 密钥（不设置密码）
ssh-keygen -t rsa -b 4096 -f ~/.ssh/deploy_key -N ""

# 查看私钥内容（用来配置 DEPLOY_SSH_KEY）
cat ~/.ssh/deploy_key

# 把公钥放到 ECS
ssh-copy-id -i ~/.ssh/deploy_key.pub user@your-ecs-ip
```

或在 ECS 上手动配置：

```bash
# 在 ECS 上
mkdir -p ~/.ssh
echo "YOUR_PUBLIC_KEY_CONTENT" >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

## 第 2 步：在 ECS 上配置环境变量

### 方式 A：编辑 .env 文件（推荐）

```bash
# 在 ECS 上登录后
cd /home/liwy/mamage-server
vim .env
```

填写必需的环境变量（参考 `.env.example`）：

```dotenv
# 必需
JWT_SECRET=your-secret-key-here
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=user
DB_PASSWORD=320911
DB_NAME=mamage

# 推荐
UPLOAD_BASE_URL=https://your-cos-bucket.cos.ap-beijing.myqcloud.com
UPLOAD_SKIP_LOCAL_FILE_CHECK=1

# COS（可选）
COS_SECRET_ID=your-cos-id
COS_SECRET_KEY=your-cos-key
COS_BUCKET=your-bucket
COS_REGION=ap-beijing
COS_BASE_URL=https://your-bucket.cos.ap-beijing.myqcloud.com

# AI（可选）
DASHSCOPE_API_KEY=your-api-key

# 前端 CORS
CORS_ORIGIN=http://your-frontend.com
```

### 方式 B：系统环境变量（可选）

编辑 `/etc/environment` 或 systemd service 文件：

```bash
# /etc/environment（全系统）
DB_HOST=127.0.0.1
DB_USER=user
DB_PASSWORD=320911
# ... 其他变量

# 或在 PM2 启动脚本中设置
# ecosystem.config.js 会自动读取这些变量
```

### 方式 C：使用 PM2 ecosystem.config.js（推荐）

PM2 配置文件已内置环境变量读取逻辑，会自动从系统和 .env 读取。启动时：

```bash
pm2 start ecosystem.config.js --env production
```

## 第 3 步：首次部署到 ECS

### 完全自动化部署（推荐）

```bash
# 在你的开发机上
git push origin main

# GitHub Actions 会自动：
# 1. 运行测试
# 2. SSH 连接到 ECS
# 3. 拉取代码
# 4. 安装依赖
# 5. 验证环境变量
# 6. 重启 PM2
```

### 手动首次部署

如果想手动执行首次部署，在 ECS 上运行：

```bash
# 下载启动脚本
curl -O https://raw.githubusercontent.com/liwenyu2002/mamage-server/main/scripts/ecs-startup.sh

# 运行启动脚本（会交互式询问配置）
bash ecs-startup.sh

# 或直接克隆和部署
git clone https://github.com/liwenyu2002/mamage-server.git
cd mamage-server

# 创建 .env 文件并填写配置
cp .env.example .env
vim .env

# 验证环境变量
node -e "require('./lib/validateEnv').validateEnvironment(true)"

# 安装依赖并启动
npm install --omit=dev
pm2 start ecosystem.config.js --name mamage-server
```

## 第 4 步：验证部署

### 检查应用状态

```bash
# 在 ECS 上
pm2 status

# 查看日志
pm2 logs mamage-server

# 测试 API
curl http://localhost:3000/api/projects

# 检查环境变量是否正确加载
curl http://localhost:3000/api/projects -H "X-Debug: 1"  # 如果实现了调试端点
```

### 常见问题排查

| 问题 | 原因 | 解决方案 |
|------|------|--------|
| `Error: Identifier 'keys' has already been declared` | 代码中重复导入 config/keys.js | 检查 db.js 中是否有重复的 require |
| `❌ 应用启动失败：缺少必需的环境变量` | .env 未配置或环境变量缺失 | 检查 .env 文件，确保填写所有必需字段 |
| `MySQL 连接失败` | 数据库配置错误或 MySQL 未启动 | 检查 DB_HOST/DB_PORT/DB_USER/DB_PASSWORD，确认 MySQL 服务运行 |
| `SSH 连接超时` | GitHub Actions 无法连接 ECS | 检查 DEPLOY_SSH_KEY、DEPLOY_HOST、DEPLOY_PORT 配置；检查 ECS 安全组入站规则 |

## 自动化更新部署

### 每次 git push main 时自动部署

无需额外操作，GitHub Actions 会自动：

1. 拉取最新代码
2. 验证代码和依赖
3. 连接到 ECS 并部署

### 手动触发部署

```bash
git push origin main
# GitHub Actions 自动运行
```

### 查看部署日志

在 GitHub 仓库 `Actions` 标签页查看每次部署的详细日志。

## PM2 常用命令

```bash
# 查看进程
pm2 status

# 查看日志（实时）
pm2 logs mamage-server

# 重启应用
pm2 restart mamage-server

# 停止应用
pm2 stop mamage-server

# 启动应用
pm2 start ecosystem.config.js

# 删除进程
pm2 delete mamage-server

# 保存进程列表（用于重启后自动恢复）
pm2 save

# 配置开机自启
pm2 startup systemd -u username --hp /home/username
pm2 save
```

## 环境变量验证

启动前会自动验证环境变量。如需手动验证：

```bash
cd /path/to/mamage-server
node -e "require('./lib/validateEnv').validateEnvironment(true)"
```

输出示例（成功）：

```
✅ 环境变量检查通过
   - JWT_SECRET: 已配置
   - 数据库: user@127.0.0.1:3306/mamage
   - COS 基础 URL: https://your-bucket.cos.ap-beijing.myqcloud.com
   - AI 分析: 已启用
```

输出示例（失败）：

```
❌ 应用启动失败：缺少必需的环境变量
缺失项：
  - JWT_SECRET
  - DB_PASSWORD

解决方案：
  1. 本地开发：复制 .env.example 为 .env 并填写所有值
  2. 部署到 ECS：在 ECS 环境变量中设置上述值
  ...
```

## 回滚部署

如需回滚到上一个版本：

```bash
# 在 ECS 上
cd /home/liwy/mamage-server
git reset --hard HEAD~1  # 回到上一个 commit
npm install --omit=dev
pm2 restart mamage-server
```

或：

```bash
# 查看 PM2 进程历史
pm2 resurrect  # 恢复上一个保存的进程列表
```

## 安全建议

1. **SSH 密钥管理**
   - 不要将私钥提交到 Git
   - 定期轮换 SSH 密钥
   - 在 ECS 上设置 SSH 密钥的文件权限 (`chmod 600`)

2. **GitHub Secrets**
   - 不要在代码中硬编码密钥
   - 使用 GitHub Secrets 存储敏感信息
   - 定期审查和轮换 Secrets

3. **环境隔离**
   - 本地开发、测试、生产使用不同的 .env 文件
   - 生产环境的 JWT_SECRET、数据库密码等应定期更换

4. **日志安全**
   - 不要在日志中输出敏感信息（密码、API Key）
   - 在生产环境使用日志收集系统（ELK、Datadog 等）

---

如有问题，请检查：
1. 日志：`pm2 logs mamage-server`
2. 环境变量：`node -e "console.log(process.env.DB_HOST)"`
3. GitHub Actions 日志：仓库 `Actions` 标签页
