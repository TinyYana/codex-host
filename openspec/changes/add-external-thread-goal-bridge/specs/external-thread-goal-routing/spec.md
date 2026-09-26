## ADDED Requirements

### Requirement: 外部 Thread 的 Goal 方法由 Harness 拥有的 Goal 服务
Host SHALL 显式处理指向外部 Thread 的 `thread/goal/set`、`thread/goal/get` 与 `thread/goal/clear`，并把 Harness 拥有的 Goal 投影为 Codex `ThreadGoal`。Host MUST NOT 为没有原生 Goal 的 Harness 模拟续跑循环。

#### Scenario: Harness 没有原生 Goal
- **WHEN** Desktop 对不暴露 Goal 能力的外部 Thread 发送 `thread/goal/set` 或 `thread/goal/clear`
- **THEN** Host SHALL 返回 `-32078`
- **AND** `thread/goal/get` SHALL 返回 `{goal: null}`

#### Scenario: 设置 Goal
- **WHEN** Desktop 对空闲的外部 Thread 发送带 objective 的 `thread/goal/set`
- **THEN** Host SHALL 通过 Harness Goal 能力起一个没有用户输入的 Turn
- **AND** 响应 SHALL 包含状态为 `active` 的 `ThreadGoal`
- **AND** Host SHALL 发出携带该 Turn ID 的 `thread/goal/updated`

#### Scenario: Desktop 在设置 Goal 前更新下一 Turn 设置
- **WHEN** Desktop 对外部 Thread 发送 `thread/settings/update`（每次 composer 设置 Goal 前都会发送，失败即放弃该 Goal）
- **THEN** Host SHALL 以 `{}` 确认；这些 Codex Turn 设置与 `turn/start` 中的同名字段一样不作用于 Harness
- **AND** 携带不属于 Codex 或该 Thread Harness 的 Model carrier 时 SHALL 以 `-32602` 失败

#### Scenario: 新 Thread 以 `/goal <objective>` 作为第一个 Turn
- **WHEN** 暴露 Goal 能力的外部 Thread 收到文本为 `/goal <objective>` 的 `turn/start`
- **THEN** Host SHALL 通过 Harness Goal 设置起这个 Turn，而不是按普通 command 解析
- **AND** 随后 Desktop 以同一 objective 发送的 `thread/goal/set` SHALL 在该 Goal Turn 运行时直接返回当前 Goal，MUST NOT 再次调用 Harness

#### Scenario: Harness 拒绝 Goal
- **WHEN** Harness Goal 设置失败，且原因不是 Session 忙碌或已关闭
- **THEN** `thread/goal/set` SHALL 以错误响应（Desktop 只显示固定的 "Failed to set goal"）
- **AND** Host SHALL 再投影一个携带 Harness 原因的失败 Turn；该 Turn 不写入 Mapping Store
- **AND** 来自 `turn/start` 的 `/goal <objective>` SHALL 返回该失败 Turn 而非请求错误，Thread 之后可正常发送普通消息

#### Scenario: Thread 忙碌时更改 objective
- **WHEN** 目标 Thread 有活跃 Turn、待处理 steering 或 command
- **THEN** 带 objective 的 `thread/goal/set` SHALL 以 `-32072` 失败

#### Scenario: 暂停与恢复
- **WHEN** Desktop 发送 `thread/goal/set {status:"paused"}`
- **THEN** Host SHALL 仅更新 Host 侧状态并发出 `thread/goal/updated`，MUST NOT 调用 Harness
- **WHEN** Desktop 对已暂停或已阻塞的 Goal 发送 `thread/goal/set {status:"active"}` 且 Thread 空闲
- **THEN** Host SHALL 用存储的 objective 重新调用 Harness Goal 设置并起新 Turn

#### Scenario: Harness 报告 Goal 变化
- **WHEN** Harness 发出 `session.goal.changed` 且 Goal 仍存在
- **THEN** Host SHALL 把状态视为 `active` 并在可观察字段变化时发出 `thread/goal/updated`
- **WHEN** Harness 报告 Goal 以 `achieved` 结束
- **THEN** Host SHALL 发出状态 `complete` 的 `thread/goal/updated`，随后的 `thread/goal/clear` SHALL 直接成功且 MUST NOT 再调用 Harness
- **WHEN** Harness 报告 `unachievable` 或 `error`
- **THEN** Host SHALL 发出状态 `blocked` 的 `thread/goal/updated`
- **WHEN** Harness 报告 `cleared`
- **THEN** Host SHALL 发出 `thread/goal/cleared`

#### Scenario: Goal Turn 终态
- **WHEN** 处于 `active` 的 Goal 所在 Turn 以失败结束
- **THEN** Host SHALL 把状态改为 `blocked`
- **WHEN** 该 Turn 被取消
- **THEN** Host SHALL 把状态改为 `paused`

#### Scenario: 读取与补水
- **WHEN** Desktop 首次对外部 Thread 发送 `thread/goal/get`
- **THEN** Host SHALL 通过 Harness 的只读 Goal 读取补水，恢复的 Goal 先标为 `paused`，并以会话累计 token 减去设置时基线作为 `tokensUsed`
- **WHEN** 多个 `thread/goal/*` 请求并发触发补水
- **THEN** 补水读取 MUST NOT 覆盖更快路径（另一次补水或 `session.goal.changed`）已经记录的状态
