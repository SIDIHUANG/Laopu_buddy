# dsh-presage-bridge

把 **DSH 的 agent 状态**写给[普瑞塞斯桌宠](../README.md)。

## 为什么需要它

DSH 的会话日志落盘为 `session.v4.jsonl.zstd`（**zstd 压缩**），tail 它既要写流式解压、又拿不到
最全的语义。而 DSH 提供了现成的一等扩展点，插件挂在上面**主动**把状态写成明文 JSONL 即可——
尤其是「**等待审批**」这类关键状态，主动 emit 比事后猜日志可靠一个数量级。

> **它是可选增强，不是硬依赖。** 没装这个插件时，桌宠必须优雅降级：
> Codex 部分照常工作，DSH 侧显示「需要安装桥接」。装与不装都不该报错。

## 它做什么

| DSH 扩展点 | 产出的事件 |
|---|---|
| `agent/session-start` | `session/start`（带 cwd） |
| `agent/pre-step` | `turn/start`（同一 turn 只发一次） |
| `tools/pre-execute` | `tool/call`（工具名 / callId / 命令摘要） |
| `tools/post-execute` | `tool/result`（成功与否 + 输出摘要） |
| `agent/turn-stopping` | `turn/end` status=ok |
| `agent/disposed` | `agent/gone`（进程退出兜底） |
| 定时 | `agent/heartbeat`（供桌宠判断「主通道是否还活着」） |

事件格式见 [`docs/AGENT_LINK_PROTOCOL.md`](../docs/AGENT_LINK_PROTOCOL.md)。
默认写入 `%APPDATA%\presage-pet\events\dsh.jsonl`。

## 安装

在 DSH profile 的补丁层（例如 `~/.dsh/profiles/desktop/cordis.patch.yml`）加一条：

```yaml
- id: presage-bridge
  name: dsh-presage-bridge
  config:
    # outDir: ''            # 留空则用 %APPDATA%\presage-pet\events
    heartbeatMs: 10000
    summaryMaxChars: 160
```

并让该包可以被解析到（放到 profile 的 `node_modules`，或用 workspace 依赖引用本目录）。

**⚠️ 安装后通常需要重载 DSH 才会生效**，而重载会中断当前会话。所以请确认没有正在跑的
长任务时再装。

## 配置项

| 字段 | 默认 | 含义 |
|---|---|---|
| `outDir` | `%APPDATA%\presage-pet\events` | 事件输出目录 |
| `heartbeatMs` | `10000` | 心跳间隔 |
| `summaryMaxChars` | `160` | 摘要字段截断长度 |

## 安全与稳定性约定

- **绝不干扰 agent**：每个回调都包在 `try/catch` 里；写文件失败只累计计数，不抛错、不阻断流程。
- **waterfall 正确性**：`agent/pre-step`、`tools/pre-execute`、`tools/post-execute` 是 waterfall，
  插件处理后原样 `return next()`，不会掐断后续监听器。
- **只写不读**：插件不读取桌宠的任何东西，也不接受桌宠的指令（v1 只读）。
- **目录不可写即自动停用**，只打一条 warning，不影响 DSH 启动。
