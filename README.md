# OpenClaw Session Viewer

本地查看 OpenClaw 历史会话的小服务。

## 能看什么

- 默认读取 `~/.openclaw/agents/*/sessions` 下所有 agent 的会话
- 主 agent 与子 agent 会话
- 会话链路：基于 `sessions.json` 的 `spawnedBy` 关系
- JSONL 事件时间线：user / assistant / toolCall / toolResult / model 事件
- 基础全文搜索
- 用户消息中的时间 envelope / 子代理前缀会尽量自动清洗
- 自动刷新时，新增消息会有轻微淡入动画

## 当前架构

- 后端：Node.js + Express
- 前端：Vue 3 + Vite
- 构建产物：`dist/`
- 数据源：只读扫描 session 目录，不改 OpenClaw 数据
- 不依赖数据库

## 启动

```bash
cd ~/repo/openclaw-session-viewer
npm install
npm start
```

说明：

- `npm start` 会先执行前端构建，再启动服务
- 首页 HTML 走 `no-store`，前端 JS/CSS 走 Vite 哈希文件，避免浏览器吃到旧代码
- 默认地址：<http://127.0.0.1:3847>

## 开发

```bash
npm run build
node server.js
```

如果你改了前端源码，重新执行一次 `npm run build` 即可生成最新的 `dist/`。

## Session 目录配置

默认值：

- `~/.openclaw/agents`

如果你希望读取别的 session 根目录，可以在启动前设置环境变量：

```bash
OPENCLAW_SESSIONS_ROOT=/path/to/agents npm start
```

也兼容这个别名：

```bash
OPENCLAW_AGENTS_ROOT=/path/to/agents npm start
```

说明：

- 配置的是 **agents 根目录**，不是某个单独的 `sessions` 目录
- 服务会按 `${ROOT}/${agent}/sessions` 结构扫描
- 未配置时，仍然稳定回退到默认目录 `~/.openclaw/agents`
- 支持 `~/xxx` 这种写法

## 性能说明

这版做了几处优化：

- 打开单个会话时，只读取当前会话及其子会话子树，不再全量扫描所有事件
- session 文件解析结果按文件 `mtime + size` 做内存缓存
- 自动刷新增加防重入，且页面隐藏时跳过刷新
- 新会话请求会中断旧请求，避免慢响应覆盖新点击

## 仓库边界说明

本项目应位于独立仓库目录，例如：

```bash
~/repo/openclaw-session-viewer
```

不要在 `~/.openclaw/workspace` 内继续开发或直接发布，以免误把 agent 配置、memory、用户上下文等私有文件带入 Git 历史。
