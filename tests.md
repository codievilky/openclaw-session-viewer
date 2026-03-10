# Manual regression checklist

- [ ] 默认根目录为 ~/.openclaw/agents
- [ ] 可通过 OPENCLAW_SESSIONS_ROOT / OPENCLAW_AGENTS_ROOT 覆盖
- [ ] 总会话列表仅显示主会话
- [ ] sessions.json 中登记但缺少 jsonl 的 session 仍可见
- [ ] 主/子会话按时间合并，子会话默认折叠
- [ ] 点击会话链路可跳转并展开子会话
- [ ] 默认隐藏系统噪音事件
- [ ] 显示系统事件后，tool call/result 以小方块展示并可点开详情
- [ ] 文本清洗不会误删正常正文
- [ ] 每秒自动刷新不闪烁，尽量保持滚动与展开状态
