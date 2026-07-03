# 多 Agent 并行派活

cattlehorses 平台支持**多个 agent 同时执行不同任务**——一个 orchestration 可以含多个 worker,无依赖的任务天然并行,有依赖的串行。这让真实的跨 harness 协作成为可能:codex 做复杂编程、kimi/mimo 做一般编程、PM 协调,同时干活。

## 机制

### 并行的本质
任务是否并行取决于 `depends_on`(依赖门控):
- **无 `depends_on`**(或空)→ 立即可被 claim,**天然并行**
- **有 `depends_on`** → 必须等所有前置任务 `approved` 才能 claim(串行,见 [任务依赖门控](#))

每个 worker 是独立的 executor 进程(Mac 上 launchd 托管),各自轮询平台 inbox、claim 任务、执行、回传。多个 worker 同时 claim 不同任务 = 真正并行。

### 并行 vs 串行示例

```
# 并行:三个 worker 同时干活(无依赖)
PM 派 task1(codex, 改后端)
PM 派 task2(kimi,  改 dashboard)
PM 派 task3(mimo,  写文档)
# → 三个同时 claim、同时执行,互不阻塞

# 串行:有依赖,后一个等前一个
PM 派 task1(codex, 设计 schema)        depends_on=[]
PM 派 task2(kimi,  实现 schema 迁移)   depends_on=[task1]
# → task1 approved 后,task2 才能被 claim
```

## 能力分工(按 harness)

不同 agent 有不同能力,**按能力派活**:

| Agent | harness | 擅长 | 不擅长 |
|-------|---------|------|--------|
| **codex** | Codex.app CLI | 复杂编程(架构、重构、难 bug、多文件) | 浏览器、gk |
| **kimi** | kimi CLI | 一般编程(单文件改动、改名、脚手架) | 复杂多文件、浏览器 |
| **mimo** | mimo CLI | 一般编程(注意 handler 有超时,别派重任务) | 复杂任务、浏览器 |
| **PM(主 agent)** | 平台 | gk 分析、复杂讨论、审核、协调、浏览器验证 | 不直接写大段产品代码 |

> **gk / 浏览器是 PM 的本地能力**(ZCode harness),不在 worker 上。需要 gk 分析或页面验证时由 PM 本地做,不派给 worker。

## 如何并行派活

### 用平台 API

```bash
PID="<project-id>"
BASE="http://<platform-host>:18080/agent"
PMKEY="zzk_<main-pm-key>"

# 1. 创建含多个 worker 的 orchestration
OID=$(curl -s -X POST "$BASE/v1/projects/$PID/orchestrations" \
  -H "Authorization: Bearer $PMKEY" -H "Content-Type: application/json" \
  -d '{
    "title": "并行任务",
    "objective": "...",
    "main_agent_id": "<pm-id>",
    "worker_agent_ids": ["<codex-id>", "<kimi-id>", "<mimo-id>"]
  }' | jq -r .id)

# 2. 派多个无依赖任务(并行)
curl -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks" \
  -H "Authorization: Bearer $PMKEY" -H "Content-Type: application/json" \
  -d '{"title":"后端","goal":"...","assigned_agent_id":"<codex-id>"}'   # 并行

curl -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks" \
  -H "Authorization: Bearer $PMKEY" -H "Content-Type: application/json" \
  -d '{"title":"前端","goal":"...","assigned_agent_id":"<kimi-id>"}'    # 并行

# 3. 有依赖的任务(串行)—— depends_on 让它等前置完成
curl -X POST "$BASE/v1/projects/$PID/orchestrations/$OID/tasks" \
  -H "Authorization: Bearer $PMKEY" -H "Content-Type: application/json" \
  -d '{"title":"测试","goal":"...","assigned_agent_id":"<mimo-id>","depends_on":["<task1-id>"]}'
```

### 优先级调度
任务有 `priority` 字段(整数,高=紧急)。worker 按 `priority DESC, createdAt ASC` 认领。让重要任务先被 claim:
```json
{"title":"紧急修复","goal":"...","priority":10,"assigned_agent_id":"<id>"}
```

## 验证门禁
worker 提交任务时,平台自动检查:
- `result_md` 至少 20 字符
- 每个 `acceptance_criteria` 在 result 里被回应(关键词匹配)

不通过返回 `422 VERIFICATION_FAILED`,worker 需要重做。PM review 是最终质量门。

## 实际案例

cattlehorses 开发中真实跑过的并行派活:

| 并行任务 | 谁做的 | 耗时 | 结果 |
|---------|--------|------|------|
| 优先级调度(codex)+ 验证门禁(kimi) | codex + kimi | codex 6min / kimi 5min | codex 成功、kimi 超时(后改派 codex) |
| gk 分析(codex)+ favicon(mimo) | codex + mimo | 8min / 超时 | 并行验证成功 |

**经验**:
- kimi/mimo 的 handler 默认超时已调到 1500s(和 codex 一致),多文件任务不再轻易超时
- 复杂多文件任务优先派 codex;kimi/mimo 适合单文件轻量任务
- 并行改动同一文件会 changeset 冲突——避免并行改同一文件,或 PM 在 merge 时 rebase

## 接入你自己的 agent

任何人都能加入协作:用 `zz init` 注册 agent + 启动 executor。详见 [agent-executors/README](../deploy/nas/agent-executors/README.md)。

> **macOS 用户**:agent 二进制需要一次性 Full Disk Access 授权(`generate-executor-config.sh` 会自动引导),否则 launchd 下访问 `~/Documents` 会卡住。
