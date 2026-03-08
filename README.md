# OpenClaw Show

一个基于 `Phaser + 原生 HTML/CSS/JS + Node.js` 的 OpenClaw 像素监控页。

页面会根据后端返回的 `zone / scene / task / alertLevel / position` 实时切换场景：

- `work`：进入工作区办公室
- `rest + room`：进入休息区卧室
- `rest + outdoor`：停留在室外闲逛
- `alarm`：进入警报控制室

同时右侧栏展示：

- 当前状态
- 机器人遥测
- 接口连接状态
- 现场日志
- 任务数
- 任务运行摘要

![页面预览](./docs/preview.png)

## 技术栈

- `Node.js`
- `ws`
- `Phaser 3`
- 原生 `HTML / CSS / JavaScript`

## 目录结构

```text
.
├── app.js                 # 前端状态同步与渲染
├── phaser-map.js          # Phaser 地图与场景逻辑
├── server.js              # 本地聚合服务与 WS 推送
├── index.html             # 页面入口
├── styles.css             # 页面样式
├── openclaw.config.js     # 前端默认配置
├── assets/                # Phaser 地图与角色资源
├── vendor/                # 前端依赖
└── docs/preview.png       # README 展示图
```

## 本地启动

```bash
npm install
npm run start
```

默认地址：

- 页面：[http://127.0.0.1:3008/](http://127.0.0.1:3008/)
- 状态接口：`http://127.0.0.1:3008/api/openclaw/status`
- WebSocket：`ws://127.0.0.1:3008/ws/openclaw/status`
- 任务统计：`http://127.0.0.1:3008/api/tasks/stats`
- 任务运行态：`http://127.0.0.1:3008/api/tasks/runtime`

## 已接入接口

### 1. OpenClaw 状态

- `GET /api/openclaw/status`
- `WS /ws/openclaw/status`

说明：

- HTTP 默认返回缓存
- `?refresh=1` 会触发强制刷新
- WebSocket 首帧为快照，后续支持 merge-patch 增量推送与 replay

### 2. 任务统计

- `GET /api/tasks/stats`

当前页面会读取：

- `data.total`
- `data.todo`
- `data.doing`
- `data.blocked`
- `data.done`

### 3. 任务运行态

- `GET /api/tasks/runtime`

当前页面会读取：

- `data.currentTask`
- `data.nextTask`
- `data.queueSummary`

如果上游暂时没有提供 `/api/tasks/runtime`，本地聚合层会自动用 `/api/tasks/stats` 合成一份运行摘要，保证页面先能显示排队/运行/失败统计。

## 可配置环境变量

- `PORT`
- `HOST`
- `OPENCLAW_STATUS_TIMEOUT_MS`
- `OPENCLAW_STATUS_POLL_INTERVAL_MS`
- `OPENCLAW_STATUS_REFRESH_DEBOUNCE_MS`
- `OPENCLAW_STATUS_REFRESH_MIN_INTERVAL_MS`
- `OPENCLAW_TASK_STATS_URL`
- `OPENCLAW_TASK_RUNTIME_URL`
- `OPENCLAW_TASK_STATS_AUTH_TOKEN`
- `OPENCLAW_CORS_ORIGIN`
- `OPENCLAW_WS_PATH`

## 上传 GitHub 前说明

仓库已通过 `.gitignore` 排除了这些本地开发产物：

- `node_modules/`
- `.venv/`
- `.idea/`
- `.DS_Store`
- 本地调试截图与临时图片

保留入库的图片只包括：

- `assets/` 下运行必需资源
- `docs/preview.png` 这张 README 预览图
