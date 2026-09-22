## ADDED Requirements

### Requirement: Claude Code Goal 映射到原生 `/goal`
Claude Code Adapter SHALL 用原生 `/goal <objective>` 实现 `goal.set`，用 `/goal clear` 实现 `goal.clear`，并从原生证据（`/goal` 本地命令输出、错误通知、transcript `goal_status` 记录）推导 Goal 状态。Adapter MUST NOT 伪造 Claude 未报告的达成或失败。

#### Scenario: 确认后才起 Turn
- **WHEN** Claude 以 `Goal set:` 确认 `/goal`
- **THEN** Adapter SHALL 依次发出 `turn.started`、此前缓冲的 Turn 级事件与 `session.goal.changed`
- **WHEN** Claude 拒绝 `/goal`（超长、工作区不受信任或 hooks 受限）
- **THEN** `goal.set` SHALL 失败且 Host MUST NOT 收到该 Turn 的任何事件

#### Scenario: 确认等待期间的 Session 级事件
- **WHEN** `/goal` 回执尚未到达而 Session 级事件（state / usage / subagent）产生
- **THEN** Adapter SHALL 即时发出这些事件，MUST NOT 因随后的 Turn 撤回而丢失它们

#### Scenario: 回执异常
- **WHEN** `/goal` 命令的回执在超时窗口内未到达
- **THEN** Adapter SHALL abort 并关闭该 transport、切回 resume 模式，`goal.set` / `goal.clear` SHALL 以可重试错误失败
- **WHEN** 收到 `Goal cleared after an unrecoverable error (…)` 通知
- **THEN** 待定的 goal 命令 SHALL 立即以错误 settle，且 Goal 以 outcome `error` 结束

#### Scenario: Goal 终态
- **WHEN** Turn 结束
- **THEN** Adapter SHALL 有界退避读取 transcript `goal_status` 记录，以 `achieved` 或 `unachievable` 报告终态，或在 Goal 仍存在时保持不变

#### Scenario: 回执不产生 Assistant 输出
- **WHEN** transport 观察到 `/goal` 本地命令回执（`<synthetic>` Assistant 消息）
- **THEN** 该消息 MUST NOT 进入 Turn accumulator 或产生 Assistant Item

#### Scenario: 历史显示
- **WHEN** 历史读取遇到 `/goal <objective>` 命令记录
- **THEN** SHALL 显示为 `/goal <objective>`
- **WHEN** 遇到 `/goal` 状态查询或 `/goal clear`（含别名）记录
- **THEN** SHALL 作为控制记录隐藏
