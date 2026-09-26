# Claude Code Goal 桥接

来源、贡献 lineage 与许可证统一记录在 [Credits / provenance](../../../CREDITS.md)；本文维护当前行为与设计。

Codex Desktop 的 `/goal` 输入框和「Pursuing goal / Goal achieved / Goal stalled」状态条通过 app-server 方法 `thread/goal/set`、`thread/goal/get`、`thread/goal/clear` 与通知 `thread/goal/updated`、`thread/goal/cleared` 工作。codexhost 此前对外部 Thread 一律返回 `-32076`，Desktop 因此提示 "Failed to set goal"，并在每次 `thread/resume` 后记录 "Failed to hydrate thread goal"。

codexhost 把这组方法**桥接到 Harness 自己的 Goal**，不在 Host 侧自造续跑循环：Harness 拥有 Goal 是否存在、如何评估、何时结束；Host 只补足 Desktop 需要而 Harness 没有原生表示的状态（`paused`、token 预算与用量基线），并把原生证据投影成 Codex 的 `ThreadGoal`。

## 所有权与契约

- `HarnessSession.goal?: HarnessGoalCapability`（`set` / `clear` / `read`）与 `session.goal.changed` 事件是唯一的公共契约，形态与 `commands?` 一致：没有原生 Goal 的 Harness 不暴露它，Host 对其 `thread/goal/set|clear` 返回 `-32078`，`thread/goal/get` 返回 `{goal: null}`。
- `goal.set({turnId, objective})` 由 Harness 以自己的方式开始 Goal 的第一个 Turn 并复用普通 Turn 生命周期；objective 不是可见的用户输入，Host 投影的 Turn 没有 `userMessage`（Desktop 已在本地合成 `/goal <objective>` 记录，与原生 Codex 的续跑 Turn 一致）。
- `goal.read()` 只读原生证据，不启动进程；`goal.clear()` 是静默原生操作，不向 Host 投影 Turn。
- `session.goal.changed` 携带 Harness 中立的 `HostGoal`（objective、setAtMs）；`goal: null` 时用 `outcome` 说明去向：`achieved` / `unachievable` / `cleared` / `error`。

## Host 状态映射

Desktop 实际的调用顺序（Codex Desktop 26.924 renderer）：

- 既有 Thread：composer 先 `thread/settings/update`（下一 Turn 的 model / effort 等），成功后才发 `thread/goal/set{objective, status:"active"}`；任一步失败只弹固定的 "Failed to set goal"，不显示服务端消息。
- 新 Thread：先 `thread/start`，再以 `turn/start` 发送文本 `/goal <objective>` 作为第一个 Turn，被接受后再发同一 objective 的 `thread/goal/set`。

| Desktop 请求 | Host 处理 |
|---|---|
| `thread/settings/update`（外部 Thread） | 与 `turn/start` 相同：只校验 Model carrier 属于 Codex 或该 Harness（否则 `-32602`），其余 Codex Turn 设置不作用于 Harness，回 `{}`。此前返回 `-32076`，Desktop 因此在发出 `thread/goal/set` 前就放弃了 Goal。 |
| `turn/start` 文本 `/goal <objective>`（Harness 有 Goal 能力） | 走 `goal.set` 起 Turn，回 `{turn}`，确认后发 `thread/goal/updated`。不再按普通 command 解析（`goal` 在公共排除清单中，此前返回 `-32078`，Desktop 提示「已建立任务，但未送出第一则讯息」）。单独的 `/goal` 或其它文本仍走 command 路径。 |
| `set{objective}`，线程空闲 | 调 `goal.set` 起 Turn；状态 `active`；同 objective 保留 `createdAt`；`tokensAtStart` 取会话累计 token；回 `{goal}` 后发 `thread/goal/updated`（带 `turnId`）。 |
| `set{objective}`，同 objective 的 Goal Turn 正在运行 | 新 Thread 流程的第二步：直接返回当前 Goal（可更新 `tokenBudget`），不再调 Harness。 |
| `set{objective}`，线程忙（其它运行中 / steering / command） | `-32072`。Desktop 自己会先 pause 再 interrupt。 |
| `goal.set` 被 Harness 拒绝（非 busy / 已关闭） | `thread/goal/set` 以 `-32602`（超长）或 `-32073` 失败；随后投影一个不落盘的失败 Turn，`error.message` 即 Harness 给出的原生原因，Desktop 在对话里显示它。来自 `turn/start` 的 `/goal` 直接以该失败 Turn 作为响应。Host 状态随失败 Turn 正常复位，之后普通消息可照常发送。 |
| `set{status:"paused"}` | 仅 Host 侧，不调 Harness、不等待 Turn（Desktop 在 interrupt 前用 500ms 预算发送它）。 |
| `set{status:"active"}` 无 objective（Resume） | 需已有 Goal；空闲 → 用存储的 objective 重新 `goal.set`（Harness 重新注册并开始工作）；运行中 → 仅改状态。 |
| `set{tokenBudget}` | 存储并回显，不强制（Harness 无预算概念）。 |
| 其它 status、`objective:null`、空参数 | `-32602`。 |
| `clear` | 无 Goal → `{cleared:false}`；Harness 已自行放弃（`nativeCleared`）→ 直接删并发 `thread/goal/cleared`，不再调 Harness；运行中 → `-32072`；否则 `goal.clear()`。 |

Harness 事件到 Desktop 状态：`goal` 非空 → `active`（若 Host 为 `paused` 且有 Turn 在跑则视为已恢复）；`achieved` → `complete`（Desktop 显示 "Goal achieved" 后自己发 `thread/goal/clear`）；`unachievable` / `error` → `blocked`（Desktop 显示 "Goal stalled"，Resume 会重新注册）；`cleared` → `thread/goal/cleared`。Goal Turn 以失败结束 → `blocked`；被取消 → `paused`；成功结束不改状态，以 Harness 的评估结论为准。

`tokensUsed = 会话累计 token − tokensAtStart`，`timeUsedSeconds` 自 `createdAt` 起计（含 paused 时段）。Host 不持久化 Goal：`thread/goal/get` 首次访问时通过 `goal.read()` 从原生证据补水；补水读取与并发的 `thread/goal/*` 请求互不覆盖（await 后重查 `goalLoaded`）；恢复出的 Goal 先显示为 `paused`，由用户 Resume 后重新交给 Harness 执行，之后由 `session.goal.changed` 纠偏。

## Claude Code 接入

Claude Code 2.1.139+ 自带 `/goal`：设置后立即以条件为指令开始 Turn，每个 Turn 结束由 Stop hook 评估器判定，未达成则在**同一个 query loop** 内继续，直到达成、判定不可能、无进展熔断或用户中断；中断不清除 Goal，下一条 prompt 后评估恢复；Goal 跨进程 resume 保留。

Agent SDK 宿主拿不到 `active_goal` 帧（CLI 只在 `CLAUDE_CODE_REMOTE` 下发送，headless 输出过滤了它），Adapter 因此从以下原生证据推导：

- `/goal` 本地命令输出：`model: "<synthetic>"` 的 Assistant 消息，文本为 `Goal set: …` / `Goal cleared: …` / `No goal set` / `Goal active: …` / `Goal condition is limited to 4000 characters …` / `/goal is only available in trusted workspaces…` / `/goal can't run while hooks are restricted…`。识别不了的 `<synthetic>` `/goal` 回执按保守 fallback 归为 `unsupported` 拒绝。
- 不可恢复错误：`system/informational` 的 `Goal cleared after an unrecoverable error (…)`，映射为 outcome `error`。
- 终态：会话 transcript 中的 `attachment.goal_status` 记录（设置 / 清除 sentinel、`met: true` 达成、`failed: true` 不可能）。Turn 结束后 Adapter 以 `[0,100,250,500,1000]ms` 有界退避重读这些记录对账，`goal.read()` 也由此回答 resume 后的补水。

`goal.set` 发送 `/goal <objective>`（objective ≤ 4000 字符，超限在 Adapter 侧直接拒绝），在收到 `Goal set:` 之前只缓冲 **Turn 级**事件：Session 级事件（state / usage / subagent）即时放行，因此拒绝撤回不会丢失它们；被 Claude 拒绝时整个 Turn 静默撤回，Host 不会看到任何 Turn 事件；确认后再依次发出 `turn.started`、缓冲事件和 `session.goal.changed`。`/goal` 回执本身在 transport 层被过滤，不进入 Turn accumulator，不会产生幻影 Assistant 消息。`goal.clear` 发送 `/goal clear`，只等待本地命令回执（`No goal set` 也视为已清除），不投影 Turn。命令回执 15s 未到达时 Adapter abort 并关闭该 transport、切回 resume 模式，不会让 Session 永久卡死；错误消息区分「15s 内未回执」与「原生 Turn 已结束却没有回执」，便于判断是 transport 卡住还是回执形态变化。历史读取把 `/goal <objective>` 显示为 `/goal <objective>`，把状态查询和 clear（含别名）记录当作控制记录隐藏。

### 当前兼容边界

- 依据 Codex Desktop **26.924** renderer 的 `thread/goal/*` / `thread/settings/update` 行为（见上文调用顺序；resume 后补水、中断前 pause、achieved 后自动 clear）与 Claude Code **2.1.283**（Adapter 通过 `pathToClaudeCodeExecutable` 使用本机 CLI，而非 Agent SDK **0.3.220** 自带的 2.1.220）的输出形态。2026-09-26 以真实 SDK 流核实：`/goal <condition>` 先回 `model: "<synthetic>"` 的 `Goal set: …`，同一 query loop 内继续模型工作；`/goal clear` 回 `No goal set` 或 `Goal cleared: …`；`goal_status` 记录形态未变。更新任一方后需重新核实这些文本与消息形态。
- Claude 的 `/goal` 受 hooks 设置约束：`disableAllHooks` 或 `allowManagedHooksOnly` 生效时回 `<synthetic>` 的 `/goal can't run while hooks are restricted (…)`（已用隔离 `CLAUDE_CONFIG_DIR` 的真实 SDK 会话确认），Host 以失败 Turn 显示该原因。经 Agent SDK 运行时未观察到工作区信任拒绝（未信任目录同样 `Goal set:`）；Adapter 仍按原文识别该文本。
- 达成与不可能只能在 transcript 里区分；若 transcript 尚未写入，Host 会短暂保持 `active`，直到下一次原生证据到达。
- `tokenBudget` 只存储不强制。

## 验证

- `packages/adapters/claude-code/test/claude-goal.test.ts`：信号解析、命令输出分类、transcript 推导。
- `packages/adapters/claude-code/test/claude-code-adapter.test.ts`：确认后才起 Turn、拒绝时静默撤回、Session 级事件放行、错误通知立即 settle、命令超时恢复、静默 clear、transcript 补水。
- `packages/adapters/claude-code/test/sdk-transport.test.ts`：`/goal` 回执不进 Turn accumulator。
- `packages/adapters/claude-code/test/claude-history.test.ts`：`/goal` 记录的历史显示与隐藏。
- `packages/host-runtime/test/external-thread-goal.test.ts`：参数校验、状态映射、`ThreadGoal` 投影纯函数。
- `packages/host-runtime/test/app-server-host.test.ts`：Desktop 路由、状态映射、失败 → blocked、Resume 重注册、achieved 后 clear 不再调 Harness、并发补水读取、无能力 Harness 的拒绝。

- `packages/host-runtime/test/app-server-host.goal.test.ts` 另覆盖 `thread/settings/update` 确认、`/goal <objective>` 第一 Turn 与后续幂等 `set`、拒绝投影为失败 Turn 后普通消息仍可发送。

合成测试不替代真实 Desktop 验收。2026-09-26 以 `npm start` 启动的真实 Desktop（Claude Code 2.1.283）确认：修复前新 Thread 的 `/goal` 以 `-32078` 失败、既有 Thread 因 `thread/settings/update` 的 `-32076` 从未发出 `thread/goal/set`，而失败后普通消息仍可正常发送；修复后新 Thread 与既有 Thread 均显示「已设为目标」并开始 Turn，达成后 Desktop 自动 clear，暂停 → 中断 → 恢复会以原生 `/goal` 重新注册，清除写入原生 `goal_status` sentinel。尚未在真实 Desktop 中验收：重启 codexhost 后的补水，以及原生拒绝在 Desktop 中的显示（原生拒绝的消息形态已由真实 SDK 会话确认，显示路径由上述 Host 测试覆盖）。
