# 表单收集与审批（示例：活动报名）

公开报名页 + 审核台的通用骨架：访客填写表单 → 获得报名编号 → 审核员通过/驳回 → 报名人凭编号和手机号查询进度。零第三方依赖，数据存在 `data/app.db`。

- `public/index.html` 报名页（手机优先）：填写表单、提交成功显示编号、查询进度
- `public/admin.html` 审核台：待审核/已通过/已驳回统计、按状态筛选、搜索、通过/驳回（驳回需填原因）、详情、导出名单
- `server.js` 活动信息与场次、字段校验、编号生成、审核与统计、示例数据

## 改成其它表单（请假申请、采购申请……）
1. **字段**：改 `server.js` 的 `FIELDS`（服务端校验、入库、导出）和 `public/fields.js` 的 `FIELDS`（表单渲染、详情展示），两边 `name` 保持一致；同步 `db.ensureTable('submissions', …)` 的列（已有数据库需删除 `data/app.db` 重新生成示例数据）。
2. **业务配置**：`server.js` 顶部的 `EVENT`、`SESSIONS`（下拉选项）、编号前缀 `BM`（`makeCode`）、重复提交规则（POST `api/submissions`）。
3. **状态流转**：`STATUSES` 与 `public/fields.js` 的 `STATUS_TONE`；如需多级审批，在 `review` 接口里按当前状态决定下一状态。
4. **文案**：页面标题、说明、示例数据（`seed`）换成新业务。

## 接口
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `api/info` | 项目名、活动信息、场次、状态列表 |
| POST | `api/submissions` | 提交（校验必填、手机号格式、同手机号同场次不可重复） |
| GET | `api/submissions/lookup?code=&phone=` | 报名人查询进度（只返回进度相关字段） |
| GET | `api/submissions?status=&q=&page=&pageSize=` | 审核列表 → `{ rows, total }` |
| POST | `api/submissions/:id/review` | `{ status: 已通过\|已驳回, note, reviewer }` |
| GET | `api/submissions/stats` | 各状态数量、今日新增、各场次统计 |
| GET | `api/submissions/export.csv?status=&q=` | 导出（带 BOM，Excel 可直接打开） |

## 运行
```bash
npm start                       # Node >= 22.13（内置 SQLite），默认 3000 端口
docker compose up -d --build    # 或 Docker 部署，数据持久化在 ./data
```
