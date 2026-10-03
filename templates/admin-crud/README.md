# 管理后台（增删改查）

由 SuperDemo 生成的 B/S 项目骨架：一个带统计卡片、搜索筛选、分页、新增/编辑/删除、详情查看和导出的列表管理页，示例业务为「客户管理」。零第三方依赖，电脑和手机都能用。

## 结构
- `server.js` 入口与接口：`FIELDS` 一处定义字段，同时决定建表、校验、新增和修改；首次启动表为空时写入示例数据（`seed()`）
- `public/index.html` 页面骨架（顶栏 → 标题与按钮 → 统计卡片 → 筛选栏 + 列表 + 分页）
- `public/app.js` 前端逻辑：`FIELDS` 一处定义字段，同时驱动表单弹窗、列表列和详情弹窗
- `public/style.css` 主题色与少量布局微调；通用样式与组件来自 `_sd/sd.css`、`_sd/sd.js`（见 `sdk/README.md`）
- `data/app.db` SQLite 数据库（自动创建，Docker 中挂载 /app/data）
- `sdk/` 内置能力（一般不需修改）

## 接口（均为相对路径）
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `api/info` | 项目名称 |
| GET | `api/customers?q=&status=&level=&page=1&pageSize=10&sort=-created_at` | 列表 → `{ rows, total }`；`sort` 前加 `-` 为倒序 |
| POST | `api/customers` | 新增，校验失败返回 400 `{ error }` |
| PUT | `api/customers/:id` | 修改（只校验传入的字段） |
| DELETE | `api/customers/:id` | 删除 |
| GET | `api/customers/stats` | 总数、各状态数量、已成交金额、本月新增 |
| GET | `api/customers/export.csv?q=&status=&level=` | 按当前筛选导出（带 BOM，Excel 直接打开中文不乱码） |

## 改成别的业务（如订单、商品、工单）
1. `server.js`：改 `TABLE`、`FIELDS`（必填 / 可选值 / 数字 / 格式）、`SEARCH`、`FILTERS`，统计接口里的口径，以及 `seed()` 的示例数据。已有旧表时删除 `data/app.db` 让它重新建表。
2. `public/app.js`：改 `ENTITY`、`API`、`FIELDS`（与服务端字段名一致；`list: true` 显示为列表列，`render` 自定义显示），以及 `renderStats()` 的四张统计卡。
3. `public/index.html`：改标题、说明文字和筛选栏控件。

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
