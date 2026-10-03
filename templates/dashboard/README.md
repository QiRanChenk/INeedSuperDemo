# 数据看板

由 SuperDemo 生成的经营数据看板（示例：连锁门店销售看板）。零第三方依赖，电脑和手机都能看。

- 顶部 4 个指标：销售额、订单数、客单价、毛利率，自动和上一周期对比
- 销售趋势、品类占比、门店排行、渠道构成、热销商品 TOP10
- 按 近7天 / 近30天 / 近90天、门店筛选
- 「AI 解读」：把汇总后的数字交给大模型，生成亮点、风险和行动建议（需配置模型）

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

## 结构
- `server.js` 指标口径、统计查询、AI 解读、示例数据
- `public/` 前端页面（`index.html` 布局、`app.js` 渲染、`style.css` 看板样式；所有 URL 使用相对路径）
- `data/app.db` SQLite 数据库，首次启动且 `orders` 表为空时写入 120 天示例订单
- `sdk/` 内置能力（一般不需修改）

## 改成自己的数据
1. **口径集中在 `server.js` 顶部「数据口径」一段**：`TABLE` / `DATE` / `DIMS` 指向你的表和列，`METRICS` 里改金额、成本列的 SQL 表达式，`KPIS` 决定四个指标卡。前端按返回的名称和格式自动渲染。
2. **导入真实数据**：删掉 `seedOrders()` 的调用，改为从 CSV 导入，例如
   ```js
   import fs from 'node:fs';
   import { parseCSV } from './sdk/index.js';
   if (!db.count(TABLE)) db.importTable(TABLE, parseCSV(fs.readFileSync('data/orders.csv', 'utf8')), { mode: 'append' });
   ```
   CSV 列名与表结构一致即可；日期列须为 `YYYY-MM-DD`。统计区间以数据中最新日期为终点，历史数据也能直接看。
3. **换维度**：比如把「门店」换成「区域」「销售员」，改 `DIMS.store` 和 `index.html` 里对应卡片标题即可。
4. **主题色**：在 `public/style.css` 里覆盖 `:root { --sd-brand: #0f9d58; --sd-brand-soft: #e6f4ea; }`。
