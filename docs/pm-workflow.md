# PM 工作模式：事件驱动，不轮询

> **核心原则**：PM（主 agent）通过 **inbox 通知** 被动接收任务完成事件，**不主动轮询任务状态**。这是平台设计的正确用法，所有部署都必须遵循。

## 问题背景

早期开发中，PM（ZCode/人）习惯手动 `curl` 查每个任务状态——这绕过了平台的 inbox 通知机制，导致：
- 浪费 API 调用（每 30s 查每个任务）
- 延迟感知（轮询间隔内不知道任务已完成）
- 不规模化（10 个任务 = 10 次 curl/轮）

## 正确流程（事件驱动）

```
PM 派活（POST /orchestrations + /tasks）
    ↓
worker claim → 执行 → complete
    ↓
平台自动往 PM inbox 写 task_ready_for_review 事件
    ↓
PM executor daemon（30s 查 inbox）自动发现 → review + merge
    ↓
PM 只需：merge 完成后同步代码到三环境
```

**PM 不查询任务状态**。PM executor 处理 inbox 通知。

## PM executor daemon

```bash
# 启动 PM executor（pm-only 模式：自动 review/merge）
python3 executor.py --base-url <platform> --api-key <PM key> --pm-only --interval 30
```

PM executor 每 30s：
1. `GET /v1/agent/inbox?unread=true` — 查未读通知
2. 发现 `task_ready_for_review` → PATCH review（approved）
3. POST merge changeset
4. ack inbox 通知

## 已知限制

1. **auto-create changeset 无 orchestrationId**：worker executor 的 auto-create（"Task deliverable"）changeset 没有 orchestrationId，PM executor 不能 merge（canReviewChangeset 要求 orchestrationId）。**这是设计如此**——auto-create 的 changeset 不是真正的代码改动，应该跳过。

2. **worker 手动提交的 changeset（有 orchestrationId）**：PM executor 能正确 review + merge。

3. **PM executor 没有 invoke endpoint**：平台不能主动唤醒 PM（只能靠 inbox 轮询）。R7 的 presence tri-state + wake_channel 正在解决这个问题。

## 部署 checklist

每个部署这个平台的人/agent 都需要知道：

- [ ] **启动 PM executor daemon**（`--pm-only` 模式），不要手动 review/merge
- [ ] **不要轮询任务状态**——信任 inbox 通知 + PM executor
- [ ] **PM executor 用 agent API key**（不是 user JWT），能 review 但 merge 受 canReviewChangeset 限制
- [ ] **auto-create changeset 会被正确跳过**（无 orchestrationId）
- [ ] **PM heartbeat daemon 也要启动**（60s 间隔，保持 PM online）

## 相关文件

- `deploy/nas/agent-executors/main-pm-heartbeat.py` — PM heartbeat keepalive
- `cli/zz_cli/executor.py` — executor daemon（支持 `--pm-only`）
- `backend/src/services/event-stream.service.ts` — SSE 事件流（未来推送）
- `docs/multi-agent-parallel.md` — 多 agent 并行派活
