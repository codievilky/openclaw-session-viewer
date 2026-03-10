# OpenClaw Session Viewer

本地查看 OpenClaw 历史会话的小服务。

## 能看什么

- 默认读取 `~/.openclaw/agents/*/sessions` 下所有 agent 的会话
- 主 agent 与子 agent 会话
- 会话链路：基于 `sessions.json` 的 `spawnedBy` 关系
- JSONL 事件时间线：user / assistant / toolCall / toolResult / model 事件
- 基础全文搜索
- 用户消息中的时间 envelope / 子代理前缀会尽量自动清洗
- 自动刷新时，新增消息会有轻微丝滑淡入动画

## 启动

```bash
cd ~/repo/openclaw-session-viewer
npm install
npm start
```

默认地址：

- <http://127.0.0.1:3847>

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

## 设计说明

- 后端：Node.js + Express
- 前端：原生 HTML/CSS/JS
- 数据源：只读扫描 session 目录，不改 OpenClaw 数据
- session 根目录通过环境变量配置，默认不改现有行为
- 不依赖数据库

## 本地开发示例

```bash
OPENCLAW_SESSIONS_ROOT=~/.openclaw/agents npm run dev
```

## 仓库边界说明

本项目应位于独立仓库目录，例如：

```bash
~/repo/openclaw-session-viewer
```

不要在 `~/.openclaw/workspace` 内继续开发或直接发布，以免误把 agent 配置、memory、用户上下文等私有文件带入 Git 历史。

## 后续可增强

- 更强的全文索引
- 会话折叠 / 虚拟滚动
- tool call / tool result 成对展示
- delivery-mirror 与真实回复去重
- nginx 反代与开机自启
