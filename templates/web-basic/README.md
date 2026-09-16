# 项目说明

由 SuperDemo 生成的 B/S 项目。零第三方依赖，`sdk/` 内含 HTTP 路由、LLM、数据源、洞察分析能力。

## 独立运行
```bash
cp .env.example .env   # 填入模型配置；或直接 export 环境变量
export $(cat .env | xargs) && npm start   # Node >= 22.13（内置 SQLite）
```

## Docker
```bash
cp .env.example .env            # 填入模型配置
docker compose up -d --build    # 默认映射 3000 端口，数据持久化在 ./data
```
或手动：
```bash
docker build -t my-demo .
docker run -p 3000:3000 -v $PWD/data:/app/data --env-file .env my-demo
```

## 结构
- `server.js` 入口与 API 路由
- `public/` 前端页面（所有 URL 使用相对路径）
- `data/` 文件数据源目录（csv / json）与 SQLite 数据库 `app.db`（真实持久化存储，Docker 中挂载 /app/data）
- `sdk/` 内置能力（一般不需修改）
