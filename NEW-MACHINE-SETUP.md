# Clowder AI 新机器部署指南

## 1. 解压
```
# 把 clowder-ai-full.tar.gz 放到你想安装的目录，然后：
tar -xzf clowder-ai-full.tar.gz
# 得到 clowder-ai/ 目录
cd clowder-ai
```

## 2. 安装 Node.js + pnpm
```
# 需要 Node.js >= 20
# 安装 pnpm
npm install -g pnpm
```

## 3. 安装依赖
```
pnpm install
```

## 4. 构建
```
pnpm -C packages/shared build
pnpm -C packages/api build
```

## 5. 安装 Redis
```
# Windows: 下载 https://github.com/tporadowski/redis/releases
# 或使用 .cat-cafe/redis/ 里已有的 Windows Redis（需要补充二进制）
# 默认端口: 6399（见 .env REDIS_PORT）
#
# Linux/Mac:
# brew install redis
# 或 apt install redis-server
# 修改 .env 里的 REDIS_PORT=6379（默认）
```

## 6. 安装 Python TTS（可选 - 语音功能）
```
cd .cat-cafe
python -m venv tts-venv
tts-venv\Scripts\activate  # Windows
# source tts-venv/bin/activate  # Linux/Mac
pip install dashscope
```

## 7. 启动
```
# 启动 API（端口 3004）
cd packages/api
node dist/index.js

# 启动前端（端口 3003）
cd packages/web
pnpm dev
```

## 8. 访问
- 前端: http://localhost:3003
- API:  http://localhost:3004

## 关键文件位置
- 环境变量: `.env`
- 猫猫配置: `.cat-cafe/cat-catalog.json`
- 账号配置: `.cat-cafe/accounts.json`
- 认证凭据: `.cat-cafe/credentials.json`
