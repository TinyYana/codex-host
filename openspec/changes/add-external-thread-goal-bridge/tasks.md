## 1. 契约

- [x] 1.1 `HarnessGoalCapability`、`HostGoal`、`SessionGoalChangedEvent` 与 `HarnessSession.goal?`。
- [x] 1.2 `FakeHarnessSession` / `FakeHarnessAdapter` 的 Goal 支持与模拟辅助。

## 2. Claude Code Adapter

- [x] 2.1 SDK 流上的 Goal 信号解析（命令输出、错误通知）与 transport 层回执过滤。
- [x] 2.2 transcript `goal_status` 读取与推导（`claude-goal.ts`、`readClaudeGoalRecords`）。
- [x] 2.3 `goal.set` 确认前只缓冲 Turn 级事件、拒绝静默撤回、命令超时释放 transport、`clearedByError` 立即 settle；`goal.clear` 静默；`goal.read`；Turn 结束有界退避对账。
- [x] 2.4 历史读取识别 `/goal` 记录。

## 3. Host Runtime

- [x] 3.1 `thread/goal/set|get|clear` 显式路由、能力门、状态映射与通知。
- [x] 3.2 `session.goal.changed` 与 Turn 终态对 Host Goal 状态的影响；补水的并发安全。

## 4. 验证与文档

- [x] 4.1 Adapter、历史、Host 聚焦测试（含并发补水、超时、拒绝撤回、Session 级事件放行）。
- [x] 4.2 `docs/harnesses/claude-code/claude-code-goal.md`、`docs/index.md`、术语表。
- [ ] 4.3 真实 Desktop 验收（`/goal`、达成自动清除、中断 → Resume、重启后补水）。
