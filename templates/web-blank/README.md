# 项目说明

由 SuperDemo 生成的 Web 项目（空白骨架）。零第三方依赖：`sdk/` 提供路由、数据库、LLM、前端组件库（`_sd/sd.css`、`_sd/sd.js`）。

## 运行
```bash
npm start                         # Node >= 22.13
docker compose up -d --build      # 或 Docker，数据持久化在 ./data
```

## 结构
- `server.js` 入口、数据表与接口
- `public/` 页面（所有 URL 用相对路径）
- `data/app.db` 数据库
