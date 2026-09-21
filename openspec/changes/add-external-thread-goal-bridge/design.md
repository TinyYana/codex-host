## Context

Desktop renderer 的行为：`/goal <text>` → `thread/goal/set {objective, status:"active"}` 后本地合成一条 `/goal <objective>` 记录并期待服务端自行起 Turn（原生续跑 Turn 的 `params.input` 为空）；`thread/resume` 后调 `thread/goal/get` 补水；用户中断时先 `set {status:"paused"}`（500ms 超时）再 `turn/interrupt`；"Resume goal" 发 `set {status:"active"}`；收到 `updated {status:"complete"}` 显示 "Goal achieved" 后自己发 `thread/goal/clear`；`blocked` 显示 "Goal stalled" 与 Resume。

Claude Code（PR #221 时期以 2.1.263 spike，本次以 2.1.278 二进制字符串核实；Agent SDK 0.3.220 相同）：

- `/goal <cond>` 的本地输出是 `model: "<synthetic>"` 的 Assistant 消息 `Goal set: …`，随后模型在同一 query loop 内工作；整个 Goal loop 只有一个 `result`。
- 纯文本本地命令（裸 `/goal`、`/goal clear`）同样发 `result`（`num_turns: 0`）。
- SDK 宿主收不到 `active_goal`：CLI 仅在 `CLAUDE_CODE_REMOTE` 下发送，headless 输出白名单排除了它。
- 达成 / 不可能 / 清除只体现在 transcript 的 `attachment.goal_status`（设置与清除 sentinel、每轮判定、`met: true`、`failed: true`）。
- 中断不清除 Goal；Goal 跨进程 resume 保留；不可恢复错误发 `system/informational` 警告。

## Goals / Non-Goals

- Goals：让 Desktop `/goal` 对 Claude Code 线程可用且语义忠实于 Claude 的原生 Goal；机制通用，按能力开放。
- Non-Goals：Host 侧续跑循环、token 预算强制、mapping-store 持久化、Renderer 改动、file-change 相关改动（main 已用 `diffScope:"fragment"` 路线）。

## Decisions

- **能力形态**：`HarnessSession.goal?: HarnessGoalCapability` + `session.goal.changed`，而非 `execute` 新命令；避免修改全部 Session 实现（含 Broker 代理），与 `commands?` 精确对齐。
- **goal.set 起 Turn**：Harness 自行开始 Goal Turn，Host 投影空输入 Turn；Claude Adapter 在 `Goal set:` 确认前只缓冲 Turn 级事件（Session 级 state / usage / subagent 事件即时放行，撤回不丢失），拒绝时静默撤回，保证 Host 在失败路径上没有见过该 Turn。
- **终态来源**：Turn 结束后 Adapter 以 `[0,100,250,500,1000]ms` 有界退避读 transcript `goal_status` 对账；`goal.read()` 同源，供 resume 后补水。
- **不持久化**：原生 transcript 是事实源；Host 只在内存中保留 `paused`、预算与 `tokensAtStart`，`thread/goal/get` 首次访问时补水；`#loadExternalGoal` 在 await 后重查 `goalLoaded`，防止并发 `thread/goal/*` 或 `session.goal.changed` 被过期读覆盖。
- **状态映射**：achieved → complete，unachievable / error → blocked，cleared → cleared 通知；Goal Turn failed → blocked，cancelled → paused；`paused` 仅 Host 侧；Resume 重新 `goal.set`。
- **忙碌处理**：objective 变更需空闲（`-32072`），Desktop 自己会先 pause+interrupt；`paused` 不受忙碌限制。
- **回执超时**：`/goal` 命令 15s 未见回执 → abort + close 该 transport 并切回 resume 模式，不 await 永不 settle 的 Turn promise；`clearedByError` 通知立即 settle 待定的 goal 命令，不等超时。
- **transport 过滤**：`/goal` 回执（synthetic Assistant）在 transport 层跳过 Turn accumulator，避免幻影 Assistant Item。

## Risks / Trade-offs

- transcript 写入晚于 `result` 时，Host 会短暂保持 `active`；有界退避覆盖常见延迟。
- `tokenBudget` 只回显不强制。
- `/goal` 回执文本是 CLI 私有输出；识别不了的 `<synthetic>` `/goal` 回执按保守 fallback 归为 `unsupported` 拒绝，升级 Claude Code 后需按文档重新核实锚点文本。
