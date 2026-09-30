# AGENT_LINK_PROTOCOL v1

普瑞塞斯桌宠与各 Agent 之间的**唯一接口契约**。

> 设计铁律：**上层永不接触任何 Agent 的原始日志格式。**
> DSH 的会话日志是 zstd 压缩的、Codex 的 rollout 是明文 JSONL、将来还会有 Claude/Gemini——
> 这些差异全部封死在 adapter 里。adapter 之上只认本文定义的事件。

---

## 1. 为什么是文件而不是 WebSocket

| 方案 | 结论 | 理由 |
|---|---|---|
| **JSONL 文件（选定）** | ✅ 主通道 | 天然解耦、可离线重放、断电可恢复、**不要求桌宠先启动**、Agent 崩溃后残留状态可重建 |
| 直连 DSH `/api/remote.mux` | ❌ 否决 | 内部 Typert RPC：需要 trust 握手、要复刻生成式 codec、随版本漂移且无兼容承诺 |
| 回环 WebSocket 回写 | ❌ 改为回环 HTTP | 回写是低频请求-响应式，WS 的心跳/重连/半开连接全是净成本 |
| 轮询 | ✅ 保底 | 主通道失效时仍能感知，**不是可选优化而是必需的三层结构之一** |

三层结构：

```
主通道    adapter 追加 JSONL（亚秒级、语义最全，含审批等待）
保底      500ms 轮询：mtime 检查 + HTTP 快照
健康检查  heartbeat 超时 → 自动降级到轮询，设置页显示"DEGRADED"
```

---

## 2. 传输

```
%APPDATA%\presage-pet\events\
    dsh.jsonl        一行一个 JSON 对象，只追加
    codex.jsonl
    <agent>.snapshot.json    可选：启动时的状态快照，避免重放整份日志
```

规则：
- **只追加（append-only）**，永不原地改写。
- 写入方必须把**单行一次性写完**（先拼完整字符串，再一次 write + flush），避免读到半行。
- 读取方必须容忍**最后一行不完整**（JSON 解析失败即丢弃该行，下次从该行起点重读）。
- 文件轮转：读取方若发现 `size < lastOffset`，视为被截断/轮转，从 0 重读。
- 编码 UTF-8，无 BOM，`\n` 结尾。

---

## 3. 行格式

```jsonc
{
  "v": 1,                       // 协议版本，整数
  "seq": 1024,                  // 每个 agent 内单调递增，用于去重和检测丢行
  "ts": 1789615529123,          // Unix epoch 毫秒
  "agent": "codex",             // "dsh" | "codex" | 未来的 provider
  "sessionId": "01a0ad65-...",  // Agent 侧会话标识；可为 null（如 agent 级事件）
  "kind": "turn/start",         // 见第 4 节
  "payload": { },               // kind 专属，见第 4 节
  "actions": []                 // 预留：v1 恒为空数组，见第 6 节
}
```

`seq` 语义：读取方记录 `lastSeq`；若收到 `seq <= lastSeq` 则丢弃（重复）；若 `seq > lastSeq + 1` 则记录一次丢行告警（不阻塞）。

> **seq 的所有权（实测踩到的坑）**：`seq` 必须由**事件的产生者**（桥接层 / adapter 边界）分配，
> 每 agent 单调递增。**绝不能直接沿用源日志自带的行号**：
> Codex 的 `ordinal` 是**按会话分文件、各自从 0 开始**的，第二个会话的 `ordinal=1` 会被
> 全局去重逻辑当成重复而整段丢弃。源行号请放进 `payload.srcOrdinal` 仅供排查。

---

## 4. 事件类型（v1）

| kind | 含义 | payload |
|---|---|---|
| `agent/hello` | Agent 侧桥接启动 | `{pid, version, cwd?}` |
| `agent/heartbeat` | 存活心跳，建议 10s 一次 | `{uptimeMs}` |
| `agent/gone` | 桥接正常退出 | `{reason}` |
| `session/start` | 新会话 | `{title?, cwd?}` |
| `session/end` | 会话结束 | `{reason: "done"｜"aborted"｜"disposed"}` |
| `turn/start` | 回合开始（**→ 忙**） | `{turnId, model?}` |
| `turn/end` | 回合结束 | `{turnId, status: "ok"｜"aborted"｜"error", durationMs?}` |
| `tool/call` | 工具调用开始 | `{turnId, tool, callId, summary?}` |
| `tool/result` | 工具调用返回 | `{callId, ok: bool, durationMs?, summary?}` |
| `approval/request` | **请求人工审批**（最高优先级） | `{turnId, approvalId, kind: "command"｜"patch"｜"network", summary, risk?}` |
| `approval/resolved` | 审批已处理 | `{approvalId, decision: "allow"｜"deny"｜"timeout"}` |
| `message/assistant` | Assistant 输出了一条消息 | `{turnId, textSummary?}` |
| `plan/update` | 计划/待办更新（可选） | `{items: [{text, status}]}` |
| `usage/update` | 用量/余额数据（数据层专用） | `{provider, window, used, limit, unit, balance?}` |
| `error` | 出错 | `{turnId?, message, fatal: bool}` |
| `notice` | 其他值得冒个泡的事件 | `{level, text}` |

**关键取舍**：`approval/request` 是一等事件，不靠"推断"。DSH 侧插件能直接拿到审批请求；Codex 侧若拿不到（见第 5 节），则该状态**宁可不报也不要猜错**——错误地显示"在等你"会让用户白跑一趟。

---

## 5. 各 Agent 的映射（已实测）

### Codex — 直接 tail `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`（纯文本，无需插件）

| rollout 事件 | → kind |
|---|---|
| `session_meta` | `session/start` |
| `event_msg/task_started` | `turn/start`（带 `turn_id`） |
| `event_msg/task_complete` | `turn/end` status=ok |
| `event_msg/turn_aborted` | `turn/end` status=aborted |
| `response_item/function_call` · `custom_tool_call` · `web_search_call` · `tool_search_call` | `tool/call` |
| `response_item/function_call_output` · `custom_tool_call_output` · `*_output` | `tool/result` |
| `event_msg/agent_message` | `message/assistant` |
| `event_msg/token_count` · `token_usage_record` | `usage/update`（**本地推导用量，不依赖任何外部接口**） |

> 实测补充：`event_msg/task_complete` 带 `error` 字段（**是对象不是字符串**）时表示回合失败，
> 这是 `turn/end` 状态取 `error` 的唯一依据；成功的回合带 `duration_ms` 与 `last_agent_message`。
> `turn_aborted` 的 `reason` 实测为 `"interrupted"`。
> `token_count.info.total_token_usage` 给出累计用量（入/出/缓存/总计），
> 在真实日志上验证：单会话可达 1900 万 tokens 累计——**这条路径不需要中转站提供任何查询接口**。
| `event_msg/patch_apply_end` | `tool/result` |
| `event_msg/context_compacted` | `notice` |
| `event_msg/user_message` | （忽略，是用户输入） |
| 进程消失 / 文件长时间不更新 | `agent/gone`（兜底） |

**已知空缺（已实测确认，不是猜测）**：扫描本机 22 个真实 rollout 文件（约 1.1 万行）后确认，
**Codex 不在日志里发出任何「请求审批」事件**。所有 `approval` / `permission` / `sandbox` 关键字命中
都落在两类位置：① `turn_context` 与 `event_msg/thread_settings_applied` 里的**配置字段**
（`approval_policy`、`permission_profile`、`sandbox_policy`），是策略声明不是事件；
② `function_call.arguments` / `function_call_output` 里的**命令文本**恰好包含这些词。

因此：**Codex 侧不上报 `approval/request`**。若将来确实要感知"Codex 在等你审批"，
只能走钩子（`notify` 已被 computer-use 占用，需包装转发）或 UI 层探测——
但那属于误报风险最高的状态，**宁可不报也不要猜错**（错误地显示"在等你"会让用户白跑一趟）。

### DSH —— 两条通道，**优先用零安装那条**

#### 通道 A（零安装，已实测验证）：轮询会话投影快照

DSH 会把每个会话的**投影快照**实时写到：

```
~/.dsh/storages/session_projcache/sessions/<session>.json
```

实测该文件在会话活动期间**亚秒级刷新**，且包含我们需要的全部信号：

| 投影字段 | 用途 | 实测形状 |
|---|---|---|
| `turnBoundary.openTurnStartSeq` | 非 null = 回合开着 | `2420` |
| `turnBoundary.lastStepBoundary.kind` | `start`/`end` = 步骤级忙碌 | `{"kind":"start","seq":2442}` |
| `sessionStats.pendingCalls` | **正在跑的工具**（键即 callId，值是开始时间戳） | `{"call_00_ET_...":1790778887964}` |
| `sessionStats.openStep.firstTokenTime` | 为 null = 模型还没出第一个 token（在想） | `null` |
| `userQuestions.questions.active` | **正在等你回答**（Codex 侧拿不到） | `[{id, question, header}]` |
| `tokenUsage.totals` | 用量（含缓存读） | `{uncachedInputTokens, outputTokens, cacheReadTokens}` |
| `permissions` | `{preset, sandbox, approval}` | 配置，不是事件 |

它是**状态快照而不是事件流**，所以由 adapter 做 diff 产生边沿事件
（`turn/start`、`tool/call`、`tool/result`、`approval/request`、`turn/end`、`usage/update`）。
首次读取**只对齐基线、不补历史**，否则桌宠一启动就会被陈旧事件炸出一屏气泡。

**取舍**：好处是完全不用装东西、也不用改 DSH 配置；代价是延迟取决于文件落盘，
且字段是 DSH 的内部投影、会随版本漂移 —— 所以全部隔离在 `app/src/adapters/dsh.js` 里。

#### 通道 B（增强）：cordis 桥接插件

延迟更低、语义更全（能拿到真正的审批请求），需要往 profile 里加一条 YAML。
见 `dsh-bridge/README.md`。两条通道可以同时开着，靠 `seq` 去重。

| DSH 扩展点 | → kind |
|---|---|
| `agent/session-start` | `session/start` |
| `agent/pre-step` | `turn/start` |
| `tools/pre-execute` | `tool/call` |
| `tools/post-execute` | `tool/result` |
| `agent/turn-stopping` | `turn/end` |
| 审批请求 / 结果（`dsh-user-approval`） | `approval/request` / `approval/resolved` |

**桥接插件是可选增强，不是硬依赖**：未安装时桌宠自动走通道 A，
两条都没有时 DSH 侧显示"需要安装桥接或检查投影目录"。

---

## 6. `actions`：为将来的双向控制预留

v1 **只读**：桌宠只消费事件、只输出画面，从不向 Agent 发指令（不调审批接口、不写配置、不起回环服务、不持 token）。

但数据模型从第一天就留好口子，使"加控制"成为**纯增量**而非重构：

| 预留项 | v1 行为 | 加控制时 |
|---|---|---|
| 事件带 `sessionId` + `agent` | 只用于分组显示 | 直接就是回写目标 |
| `actions` 字段 | 恒为 `[]` | 填 `["approve","reject","jump"]`，前端循环渲染按钮 |
| Rust 侧 `ActionSink` trait | `NoopSink` 什么都不做 | 换 `HttpSink`，**仲裁层与渲染层一行不改** |

将来 `actions` 的元素形如 `{"id":"approve","label":"批准","target":{"agent":"dsh","sessionId":"...","approvalId":"..."}}`。

---

## 7. 读取方（桌宠）状态机

```
原始行 → adapter 规范化 → 会话聚合(per sessionId)
       → 新鲜度衰减（活跃态超时 → 降级 idle）
       → 全局仲裁（优先级表 + 自动/锁定DSH/锁定Codex）
       → 输出 {animState, bubbles[], counts, health}
```

优先级（高 → 低）：
`approval/request` > `turn/start`/`tool/call`（忙）> `error` > `turn/end`（完成）> `idle` > 长时间无事件（doze→sleep）

规则：
- **等待类状态不可被覆盖**：DSH 在等审批、Codex 在报错时，两者**同时存在于气泡层**，角色动画只表现最高优先级。
- **新鲜度衰减是保险丝**：任何"活跃"状态超过 45s 无新事件 → 强制回落 `idle`，防止 Agent 崩溃导致永久转圈。
- **锁定模式是硬开关**：锁定某 Agent 时，另一侧只更新数据、不参与仲裁（但保留在自己的气泡里）。

---

## 8. 版本策略

- `v` 字段只在**破坏性变更**时 +1。
- 读取方遇到 `v > 自己支持的版本` → 记录一次告警并**尽力解析**（未知 kind 忽略，不崩）。
- 新增字段是兼容的，读取方必须忽略不认识的字段。
- 新增 kind 是兼容的。
