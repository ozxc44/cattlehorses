# Agent Executors (本机 Mac, 三路 worker+PM)

把平台派活给本机的 codex / kimi / mimo，让它们**真正同步执行**任务并回传结果。

## 架构

```
平台 orchestrations/tasks (派活)
        ↓ dispatch
平台 inbox (task_dispatched 事件)
        ↓ 本机常驻 executor 轮询 claim
ExecutorDaemon (worker+PM)
        ↓ handler (stdin: task JSON, stdout: {"content": result})
各自 CLI 真正执行
  - codex-invoke-handler.py  → codex exec (gpt-5.5 high)
  - mimo-invoke-handler.py   → mimo run (mimo-v2.5)
  - kimi-worker-handler.py   → kimi -p (kimi)
        ↓ submit
平台 task → ready_for_review (主 agent 验收)
```

## 关键设计点

1. **同步真执行**（非 ACK-only）：handler 调 CLI 真正干活，产出完整结果
2. **worker+PM 双模式**：一个 executor 进程既消费 worker 任务又做 PM review/merge
3. **长超时**：handler 超时 1500s（25 分钟），适配 codex 调 gk 委员会（约 15 分钟）
4. **launchd 托管**：KeepAlive，崩溃/重启自动恢复

## 部署位置

| 文件 | 运行位置 |
|------|----------|
| `*-wrapper.py` + `executor.py` | `/Users/z/.zz-agent/` |
| `*-handler.py` | `/Users/z/.zz-agent/` |
| `com.zz-agent.*.plist` | `~/Library/LaunchAgents/` |
| agent identity/key | wrapper 内或 `MIMO_AGENT_KEY`/`KIMI_AGENT_KEY` 环境变量 |

## 三路 agent 身份

| agent | id | CLI | handler |
|-------|-----|-----|---------|
| codex-mac-watch | 4c15b1af | codex (gpt-5.5 high) | codex-invoke-handler.py |
| mimocode-agent | f0a0042d | mimo run | mimo-invoke-handler.py |
| kimi-agent | 47d2c58a | kimi -p | kimi-worker-handler.py |

## 安装/重启

```bash
# 复制脚本
cp *.py /Users/z/.zz-agent/
cp com.zz-agent.*.plist ~/Library/LaunchAgents/

# 重启某路
launchctl unload ~/Library/LaunchAgents/com.zz-agent.codex-pm-executor.plist
launchctl load ~/Library/LaunchAgents/com.zz-agent.codex-pm-executor.plist
```

## 排查

- 任务卡 `dispatched`：executor 没在跑 → 检查 `ps aux | grep wrapper`
- 任务卡 `running` 不产出：handler 超时 → 调大 `TIMEOUT_SECONDS`（gk 类任务需 1500s+）
- `unknown_agent`：invoke server registry 没配 → 检查 `codex-invoke-agents.json`
- executor.py `--base-url required`：self-update re-exec 丢参数 → wrapper 内传 `no_self_update=True`
