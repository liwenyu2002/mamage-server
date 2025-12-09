#!/bin/bash
# scripts/ecs-startup.sh
# ECS 启动脚本：在 ECS 上首次部署时运行此脚本
# 用法：ssh user@ecs-ip < ecs-startup.sh

set -e

echo "🚀 MaMage Server ECS 部署启动脚本"

# ============ 第 1 步：检查系统依赖 ============
echo "📦 检查系统依赖..."
if ! command -v node &> /dev/null; then
  echo "❌ Node.js 未安装，请先安装 Node.js 18+"
  exit 1
fi

if ! command -v npm &> /dev/null; then
  echo "❌ npm 未安装"
  exit 1
fi

if ! command -v git &> /dev/null; then
  echo "❌ git 未安装，请先安装 git"
  exit 1
fi

if ! command -v mysql &> /dev/null; then
  echo "⚠️  mysql 客户端未安装（可选，若需数据库操作再装）"
fi

echo "✅ Node.js: $(node --version)"
echo "✅ npm: $(npm --version)"
echo "✅ git: $(git --version)"

# ============ 第 2 步：克隆/更新代码 ============
PROJECT_PATH=${PROJECT_PATH:-/home/liwy/mamage-server}
REPO_URL=${REPO_URL:-https://github.com/liwenyu2002/mamage-server.git}

echo "📁 项目路径: $PROJECT_PATH"

if [ -d "$PROJECT_PATH/.git" ]; then
  echo "更新现有代码..."
  cd "$PROJECT_PATH"
  git fetch origin main
  git checkout main
  git pull origin main
else
  echo "克隆新代码..."
  git clone -b main "$REPO_URL" "$PROJECT_PATH"
  cd "$PROJECT_PATH"
fi

# ============ 第 3 步：安装依赖 ============
echo "📦 安装依赖..."
npm ci --omit=dev || npm install --omit=dev

# ============ 第 4 步：检查和导入数据库（如需要） ============
read -p "是否需要初始化数据库？(y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
  if [ -f "$PROJECT_PATH/db/backup.sql" ]; then
    echo "📊 导入数据库备份..."
    read -p "请输入 MySQL root 用户密码: " -s MYSQL_ROOT_PASS
    echo
    mysql -h "${DB_HOST:-127.0.0.1}" -u root -p"$MYSQL_ROOT_PASS" < "$PROJECT_PATH/db/backup.sql" || {
      echo "❌ 数据库导入失败"
      exit 1
    }
    echo "✅ 数据库导入成功"
  else
    echo "⚠️  未找到 db/backup.sql，跳过数据库初始化"
  fi
fi

# ============ 第 5 步：创建环境变量文件（或提示修改） ============
ENV_FILE="$PROJECT_PATH/.env"

if [ ! -f "$ENV_FILE" ]; then
  echo "🔑 创建 .env 文件..."
  cat > "$ENV_FILE" << 'ENVEOF'
# 必需的环境变量（请修改为实际值）
JWT_SECRET=please-change-this-secret-in-production

# 数据库
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=user
DB_PASSWORD=320911
DB_NAME=mamage

# 上传配置
UPLOAD_BASE_URL=https://your-cos-bucket.cos.ap-beijing.myqcloud.com
UPLOAD_SKIP_LOCAL_FILE_CHECK=1

# COS 配置（可选，若使用对象存储）
COS_SECRET_ID=
COS_SECRET_KEY=
COS_BUCKET=
COS_REGION=
COS_BASE_URL=

# AI 配置（可选，若使用 AI 图像分析）
DASHSCOPE_API_KEY=

# CORS
CORS_ORIGIN=http://your-frontend-domain.com
ENVEOF
  
  echo "⚠️  已创建 .env 文件，请编辑并填入实际的密钥和配置:"
  echo "   vim $ENV_FILE"
  read -p "配置完成后按 Enter 继续..."
else
  echo "ℹ️  .env 已存在，跳过创建"
fi

# ============ 第 6 步：安装/配置 PM2 ============
echo "⚙️  配置 PM2..."

if ! command -v pm2 &> /dev/null; then
  echo "📦 安装 PM2..."
  npm install -g pm2
fi

# 从 .env 加载环境变量
set -a
source "$ENV_FILE"
set +a

# 验证环境变量
echo "🔍 验证环境变量..."
node -e "require('./lib/validateEnv').validateEnvironment(true)" || {
  echo "❌ 环境变量验证失败，请检查 .env 文件"
  exit 1
}

# 启动/重启应用
echo "🚀 启动应用..."
pm2 delete mamage-server || true
pm2 start ecosystem.config.js --name mamage-server

# 保存 PM2 进程列表
pm2 save

# 配置 PM2 开机自启（可选）
echo "📋 配置 PM2 开机自启..."
pm2 startup systemd -u "$(whoami)" --hp "$HOME"

# ============ 第 7 步：验证应用启动 ============
sleep 2
echo "✅ 检查应用状态..."
pm2 logs mamage-server --lines 20

echo ""
echo "🎉 部署完成！"
echo ""
echo "常用命令："
echo "  pm2 logs mamage-server          # 查看应用日志"
echo "  pm2 restart mamage-server       # 重启应用"
echo "  pm2 stop mamage-server          # 停止应用"
echo "  pm2 delete mamage-server        # 删除应用"
echo ""
echo "手动更新部署："
echo "  cd $PROJECT_PATH"
echo "  git pull origin main"
echo "  npm install --omit=dev"
echo "  pm2 restart mamage-server"
echo ""
