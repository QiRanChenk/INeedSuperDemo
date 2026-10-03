<p align="center">
  <h1 align="center">⚡ SuperDemo 制造器</h1>
  <p align="center">接入任意 OpenAI 兼容大模型，用对话创建、运行并持续改造多个可独立部署的 Demo 项目。<br>
  <b>面向业务人员改「正在运行的系统」，而不是面向开发者产代码。</b></p>
</p>

<p align="center">
  <img src="docs/screenshot.jpg" alt="SuperDemo 界面" width="920">
</p>

## 它是什么

SuperDemo 是一个 **AI agent 壳**：

- 左侧管理多个项目，中间和 AI 对话，右侧是项目的实时预览。
- 告诉 AI「我想要一个 ×× 工具」，它直接改正在运行的项目：写文件 → 自动重启 → 预览刷新，全过程可见（工具调用、模型思考、重启日志）。
- 每个项目都是一个**自包含目录**：`node server.js` 就能独立运行，自带 `Dockerfile`，不依赖壳。
- 项目内置 SDK：HTTP 路由、LLM 调用、**真实数据库（SQLite）**、数据源（文件 / 数据库 / API）、AI 数据洞察。
- 目标用户：小白、初创团队、企业内部——想法验证的第一个可用 Demo，并能逐步演进到可部署系统。

与 Claude Code / Codex 等编码工具的区别：它们产出代码交给开发者部署；SuperDemo 直接运行、直接改、直接给业务人员用。

## 快速开始

需要 **Node.js ≥ 22.13**（使用内置 `node:sqlite`，项目零第三方依赖）。

```bash
git clone https://github.com/QiRanChenk/INeedSuperDemo.git
cd INeedSuperDemo
npm install
npm start          # http://localhost:3000
```

首次打开在左下「模型设置」选择预设、填入 API Key：

| 预设 | Base URL | 默认模型 |
|---|---|---|
| DeepSeek | `https://api.deepseek.com` | `deepseek-chat` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-5.3-flash` |
| Qwen Coding Plan | `https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` |
| Qwen DashScope | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen3-coder-plus` |
| Ollama 本地 | `http://127.0.0.1:11434/v1` | 任意 |
| 自定义 | 任何 OpenAI 兼容端点 | — |

也可以复制 `.env.example` 为 `.env` 配置。模型需支持 tool calling。

然后点「新建项目」，写一句需求，AI 先给出一份**方案**（页面、数据字段、关键流程、示例数据、演示亮点、这一版不做什么、起步骨架），你可以逐条修改后再让它开工，例如：

> 做一个门店库存预警工具：录入商品和库存，低于阈值标红，并让 AI 给补货建议

AI 从最贴近的骨架（管理后台 / 表单收集与审批 / 数据看板 / 数据洞察 / 空白页）起步，按方案改成你要的东西，做完会在电脑和手机两种尺寸下自查一遍。之后继续对话迭代即可。

### 访问安全

壳可以通过 AI 在本机执行命令，因此默认只监听 `127.0.0.1`，并拒绝非本机域名（防 DNS rebinding）与跨站写请求。需要让局域网 / 公网访问时，必须同时设置访问口令，否则拒绝启动：

```bash
HOST=0.0.0.0 SUPERDEMO_PASSWORD='一个足够长的随机口令' npm start   # 浏览器弹出登录框，用户名随意
```

壳内运行的项目同样只监听 `127.0.0.1`，只能经由壳的 `/p/<id>/` 访问（受同一口令保护）；导出 / Docker 部署后照常监听所有网卡。

### 部署到服务器 / NAS

壳本身也能用 Docker 运行（项目作为容器内子进程，经 `/p/<id>/` 访问）：

```bash
cp .env.example .env    # 填 SUPERDEMO_PASSWORD（必填）、可选 HOST_PORT（默认 18788）
docker compose up -d --build
```

`data/`（模型设置与 Key）和 `projects/`（项目、数据库、会话、版本）挂载在宿主机。`deploy/fnos-deploy.py` 是一键部署到飞牛 fnOS 的脚本：本机构建对应架构的镜像后传过去，依赖不变时只同步代码并重启；首次部署会带上本机的模型设置与项目。容器内不能再「构建 Docker 镜像」，zip 导出照常可用。

## 内置样例：数据洞察助手

新建 B/S 项目默认得到一个可用的「数据洞察助手」：

- 选择数据源（内置 120 行销售 CSV、SQLite 数据表、示例公开 API，或上传自己的 CSV/JSON）
- 上传的数据自动导入 SQLite 表；提问 + 勾选建议方向（增长机会 / 风险预警 / 成本优化 / 客户洞察 / 下一步行动）
- AI 基于程序统计出的数据画像（而非原始行）输出阅读友好的 Markdown 结论与建议
- 分析结果持久化到项目数据库，可回看

## 功能一览

- **多项目**：创建 / 启动 / 停止 / 重启 / 删除，每项目独立端口与子进程，壳内通过 `/p/<id>/` 反向代理访问
- **在线热更新**：AI 改完文件自动重启，启动日志回灌给模型自行排错
- **完整过程回放**：对话历史逐条落盘，切换项目再切回，思考过程（reasoning、工具调用、结果、重启记录）完整保留
- **多会话**：一个项目可开多个会话，代码共享、对话记忆隔离；旧会话可回看、重命名、删除
- **随时停止 / 插话 / 排队**：处理中按 Esc 或「停止」立即中断（已生成的内容保留）；直接输入 Enter 是插话，AI 在当前步骤完成后就会看到；⌘/Ctrl+Enter 排队，等本轮结束后所有排队消息合并为下一轮自动发出
- **方案先行 + 骨架模板**：新建时先出可编辑的方案卡片，确认后才开工；按方案自动选择起步骨架（管理后台、表单收集与审批、数据看板、数据洞察、空白页），都基于统一组件库
- **统一组件库**：项目 SDK 自带 `_sd/sd.css` + `_sd/sd.js`（布局、表单、弹窗、提示、手机端自动变卡片的表格、指标卡、无依赖 SVG 图表等），普通 HTML 即有专业观感，AI 写得更少、观感更稳定
- **电脑 / 手机双尺寸**：预览区一键切换手机视图；AI 的 `page_view` / `page_act` 支持 `device=mobile`；改了界面却没看过实际效果时，收尾前会被要求在两种尺寸下自查
- **分享链接**：「分享」为项目生成独立链接（`/s/<随机串>/`，可设有效期、随时关闭）；访问者无需口令，只能使用这个 Demo，看不到对话、代码、设置和其他项目；项目未运行时访问会自动启动；每个链接有访问统计（访客数、近 14 天趋势、常看页面）
- **访客导览**：AI 根据方案和页面写一张「怎么体验这个 Demo」小卡片（3–5 步，可直接跳到对应页面），访客第一次打开分享链接时显示，可在分享面板修改或关闭
- **访客留言 → AI 修改**：分享页右下角有「💬 提意见」，留言汇总到项目的「反馈」里，勾选后一键交给 AI 逐条处理
- **演示数据快照**：把整理好的数据保存为演示初始状态，被访客改乱后一键恢复，或每天 4 点自动恢复
- **复制项目**：复制出一个变体尝试另一种方案（代码与数据一起复制，对话从头开始）
- **版本与一键回滚**：每轮对话前自动保存代码版本（本轮没改代码则不保留），对话里直接「撤销本轮」，或在「版本」中回滚到任意一轮之前；只回滚代码，业务数据（`data/`、数据库）不受影响，回滚前的状态也另存一份
- **精准改代码**：agent 用 `edit_file` 精确替换片段、`grep` 定位、`read_file` 分段读取，写 `.js` 后自动语法检查；用 `http_request` 自测接口（自动应用未生效的修改并等服务就绪）；只读命令不会触发重启
- **AI 看得见、点得动页面**：agent 用 `page_view` 查看预览的实际效果（页面结构 + 自动布局检查：横向溢出、遮挡、截断、低对比度、图片失败；模型支持图片时附带截图），用 `page_act` 像用户一样点击、填表、选择、提交，走一遍业务流程验证；截图在对话里可回看。页面由你打开的 SuperDemo 浏览器标签页代为渲染（服务器无需安装浏览器），没打开时自动改用接口自测；模型是否支持图片会自动检测
- **前端报错回传**：预览页面里的 JS 报错、未处理的 Promise 异常、资源加载失败、5xx 请求自动上报为 `[web]` 日志并交给 AI 修复（由代理注入，不写入项目文件）；项目崩溃后自动拉起（每分钟最多 3 次），运行日志落盘
- **上下文自动瘦身**：只保留最近两轮的完整工具结果与文件内容，更早的压成一行摘要；长轮次内部也会把过期的文件读取、大段输出分批收起（分批移动边界，保持提示缓存命中）；超过阈值进一步压缩，避免 token 平方增长与上下文溢出
- **Token 统计**：本会话 / 项目累计的输入、输出、缓存命中率、合计；侧栏常显今日 / 累计消耗，点击打开折线图，支持今日 / 昨天 / 7 天 / 本周 / 30 天 / 本月 / 今年 / 去年 / 全部及自定义起止日期，按项目汇总
- **项目内 AI 可独立配置**：默认 Demo 复用壳的模型；取消勾选后可为 Demo 单独指定端点 / 模型 / Key（如 agent 用编码模型、Demo 用便宜的对话模型），保存即自动重启项目生效
- **真实存储**：项目 SDK 提供 `openDb()`（SQLite），Agent 被要求所有持久化数据必须入库
- **独立部署**：项目目录即部署单元，`npm start`，或 `docker compose up -d --build`（自带 Dockerfile 与 docker-compose.yml，数据卷持久化）
- **一键导出**：「导出」下载项目 zip（代码 + sdk + 数据 + Dockerfile，不含 API Key）；本机装了 Docker 时可直接构建镜像、查看构建日志、下载镜像 `.tar.gz`，附带目标服务器上的 `docker load` / `docker run` 命令
- **项目类型**：B/S Web 应用、无界面服务；C/S 桌面应用（规划中）

## 目录结构

```
shell/        壳：Express 服务、项目注册与进程管理、反向代理、agent 循环、Web UI
sdk/          注入到每个项目的零依赖 SDK（http / llm / db / datasource / insights）
templates/    项目模板：web-basic（B/S，内置数据洞察样例）、headless-basic（无界面服务）
projects/     生成的项目（已 gitignore），每个目录 = 一个可独立部署的应用
data/         壳设置（settings.json，已 gitignore，含 API Key）
```

## 项目契约

每个项目目录包含：

- `project.json`：id / name / type / entry / port / autoStart
- 入口 `server.js` 监听 `process.env.PORT`
- LLM 配置通过环境变量 `SUPERDEMO_LLM_BASE_URL / SUPERDEMO_LLM_API_KEY / SUPERDEMO_LLM_MODEL` 注入（独立部署时写 `.env`）
- 前端使用相对 URL，既能在壳的子路径下运行，也能独立在根路径运行
- `sdk/` 由壳维护，项目启动时自动同步最新版本
- 运行时数据放 `data/`（含 SQLite）：版本回滚不会触碰
- 支持 WebSocket（壳的代理会转发 `/p/<id>/` 下的 upgrade 请求）

SDK API 详见 [`sdk/README.md`](sdk/README.md)。

## 路线图

- [x] B/S 项目、无界面服务、壳内运行、自动重启热更新、Dockerfile
- [x] SQLite 真实存储、数据源统一契约（文件 / 数据库 / API）
- [x] 思考过程持久化回放、Token 统计、启动/停止
- [x] 多会话管理、上下文自动瘦身
- [x] 每轮版本快照与一键回滚、前端报错回传、精准编辑工具集
- [ ] C/S 桌面项目模板（Electron / Tauri）
- [ ] 项目间协作（服务发现 + 壳内 HTTP 网关）
- [x] docker-compose 一键部署
- [x] 一键导出 zip / 构建 Docker 镜像 / 下载镜像 tar
- [ ] Postgres / MySQL 数据源
- [ ] 多用户与权限

## 许可证

[MIT](LICENSE)
