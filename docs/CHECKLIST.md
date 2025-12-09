<!-- docs/CHECKLIST.md -->
# CI/CD 部署检查清单

使用此清单确保 CI/CD 和密钥管理配置完成。

## 本地开发环境

- [ ] 复制 `.env.example` 为 `.env`
- [ ] 填写所有必需的环境变量（见下方表格）
- [ ] 运行 `node app.js` 验证应用启动
- [ ] 验证环境变量：`node -e "require('./lib/validateEnv').validateEnvironment(true)"`

## 必需的环境变量

| 变量 | 必需 | 开发值示例 | 生产值 |
|------|------|----------|--------|
| `JWT_SECRET` | ✅ | `dev-secret` | 强随机字符串 |
| `DB_HOST` | ✅ | `127.0.0.1` | ECS IP |
| `DB_PORT` | ✅ | `3306` | `3306` |
| `DB_USER` | ✅ | `user` | `user` |
| `DB_PASSWORD` | ✅ | `320911` | 强随机密码 |
| `DB_NAME` | ✅ | `mamage` | `mamage` |
| `UPLOAD_BASE_URL` | ⚠️  | `http://localhost:3000` | COS URL |
| `COS_SECRET_ID` | ❓ | - | 从腾讯云获取 |
| `COS_SECRET_KEY` | ❓ | - | 从腾讯云获取 |
| `COS_BUCKET` | ❓ | - | 你的 COS bucket |
| `COS_REGION` | ❓ | - | `ap-beijing` |
| `DASHSCOPE_API_KEY` | ❓ | - | 从阿里云获取 |
| `CORS_ORIGIN` | ⚠️  | `http://localhost:5173` | 前端域名 |

**图例**：✅ 必需 | ⚠️  推荐 | ❓ 可选（按需）

## GitHub 仓库配置

- [ ] 仓库名称：`mamage-server`
- [ ] 分支：`main`（保护分支，避免直推）

### GitHub Secrets（Settings → Secrets and variables）

- [ ] `DEPLOY_SSH_KEY` — ECS SSH 私钥
- [ ] `DEPLOY_HOST` — ECS IP 地址
- [ ] `DEPLOY_USER` — ECS 登录用户（例如 `liwy`）
- [ ] `DEPLOY_PORT` — SSH 端口（默认 `22`）

**配置 SSH 密钥对**：

```bash
# 在本地生成
ssh-keygen -t rsa -b 4096 -f ~/.ssh/deploy_key -N ""

# 查看私钥
cat ~/.ssh/deploy_key

# 复制公钥到 ECS
ssh-copy-id -i ~/.ssh/deploy_key.pub user@ecs-ip
```

## ECS 服务器准备

- [ ] Node.js 已安装（`node --version` 检查）
- [ ] npm 已安装（`npm --version` 检查）
- [ ] git 已安装（`git --version` 检查）
- [ ] MySQL 已运行（`mysql --version` 检查）
- [ ] PM2 已安装（`pm2 --version` 检查）
  - 如未安装：`npm install -g pm2`
- [ ] SSH 公钥已添加到 `~/.ssh/authorized_keys`

### ECS 上的项目目录

- [ ] 项目路径：`/home/liwy/mamage-server`（可自定义，保持一致）
- [ ] `.env` 文件已创建并填写所有必需值
- [ ] 数据库已创建（`mamage` 数据库存在）
- [ ] 数据库用户已创建（`user` 用户有权限）

**验证 ECS 配置**：

```bash
# SSH 连接到 ECS
ssh -i ~/.ssh/deploy_key user@ecs-ip

# 检查环境
node --version
npm --version
git --version
mysql --version
pm2 --version

# 检查项目目录
cd /home/liwy/mamage-server
ls -la

# 检查 .env 文件
cat .env | grep -E "^[A-Z_]"

# 验证数据库连接
mysql -h 127.0.0.1 -u user -p -e "SELECT 1;"
```

## 首次部署（自动）

- [ ] 代码已推送到 GitHub `main` 分支
- [ ] GitHub Actions 工作流已启用（`.github/workflows/deploy.yml` 存在）
- [ ] 所有 Secrets 已配置
- [ ] 在 GitHub 仓库 `Actions` 标签页检查部署日志

**检查部署状态**：

```
Actions 标签页 → 最新工作流 → 检查绿色 ✅ 或红色 ❌
```

## 部署后验证

- [ ] 应用已启动：`pm2 status` 显示 `online`
- [ ] 日志无错误：`pm2 logs mamage-server` 无红色错误
- [ ] 环境变量正确：查看启动日志中的配置信息
- [ ] API 可访问：
  ```bash
  curl http://localhost:3000/api/projects
  ```
- [ ] 数据库连接正常：日志中无数据库错误

## 自动部署流程验证

- [ ] 修改代码并 `git push origin main`
- [ ] GitHub Actions 自动触发部署
- [ ] 部署完成后检查应用状态

## 回滚计划

如需回滚：

```bash
# SSH 进 ECS
ssh -i ~/.ssh/deploy_key user@ecs-ip

# 回到上一个版本
cd /home/liwy/mamage-server
git reset --hard HEAD~1
npm install --omit=dev
pm2 restart mamage-server

# 或查看日志
pm2 logs mamage-server
```

## 定期维护

- [ ] 每月检查一次 SSH 密钥是否有效
- [ ] 定期更新依赖：`npm update --save-prod`
- [ ] 检查 PM2 进程日志：`pm2 logs`
- [ ] 备份数据库：`mysqldump -u user -p mamage > backup.sql`

## 故障排查

如遇问题，按下列顺序检查：

1. **环境变量缺失**
   ```bash
   node -e "require('./lib/validateEnv').validateEnvironment(true)"
   ```

2. **数据库连接失败**
   ```bash
   mysql -h 127.0.0.1 -u user -p320911 -e "SELECT 1;"
   ```

3. **GitHub Actions 部署失败**
   - 查看 Actions 日志
   - 检查 SSH Secrets 配置
   - 验证 ECS 网络连接

4. **PM2 进程崩溃**
   ```bash
   pm2 logs mamage-server --lines 50
   pm2 restart mamage-server
   ```

5. **应用启动缓慢**
   - 检查日志：`pm2 logs mamage-server`
   - 检查 CPU/内存：`pm2 monit`

## 检查完成

- [ ] 以上所有项目已完成
- [ ] 应用成功部署到 ECS
- [ ] CI/CD 流程已验证
- [ ] 团队成员都了解部署流程

---

如需帮助，参考：
- 完整指南：`docs/DEPLOYMENT.md`
- 代码结构：`README.md`
- 环境变量模板：`.env.example`
