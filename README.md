# Agent Collaboration OS

> 让任意本地 AI 模型（kimi / claude / codex / mimo / hermes / deepseek …）自动协作完成软件项目——像 GitHub 团队一样派活、干活、审核、合并。

[English](README_EN.md)

**Agent Collaboration OS** 是一个多 agent 协作操作系统。它把一台（或多台）机器上的本地 AI 模型组织成一个自驱动的开发团队：**PM agent 拆解需求并派活 → worker agent 调用本地模型实例干活 → 平台自动审核 + 合并 → CI 门禁验证**。全程通过真实 Git 后端 + MD 驱动工作流 + 持久化 inbox，可审计、可私有部署、可观测。

核心链路是**自驱动循环（autonomous loop）**：派活 → 执行 → 提交变更集 → 自动合并 → 验证，平台在多个 worker、多个 harness 之间调度、验证、合并和恢复，无需人工逐轮聊天。

## 这是什么 / 不是什么

**是**：多 agent 协作的**治理平台**——编排、路由、审核、合并一群 AI agent 的产出，并让它们 7×24 自驱动运转。

**不是**：又一个单 agent 编程助手（那是 Cursor / Copilot 的赛道）。这里管的是“一群 agent 怎么协作”。

**与同类项目的区别**：

| 项目 | 定位 | 我们的不同 |
|------|------|-----------|
| LangChain / LangGraph | 构建/编排 agent 的框架 | 不管怎么构建 agent，管的是多个 agent **如何被调度、验证、合并、观测、恢复** |
| AutoGen / CrewAI | 多 agent 对话/角色扮演 | 不做对话，做**可追踪的 changeset + PM executor 自动审核** |
| OpenHands / SWE-agent | 单 agent autonomous coding | 管**多** agent 的协作，不是单个 agent 的能力 |
| **Agent Collaboration OS** | **Agent Collaboration OS** | **可调度 + 可验证 + 可合并 + 可观测 + 可恢复** 的协作操作系统 |

## 快速开始

### 1. 部署平台（NAS / 任意内网服务器）

```bash
git clone https://github.com/ozxc44/cattlehorses.git && cd cattlehorses
bash deploy/setup.sh        # 一键：自检 Docker → 生成密钥 → 检测 IP → 启动 → 健康检查
# 平台启动在 http://<your-platform-host>:18080/agent
```

`setup.sh` 会自动生成 `.env`（JWT / DB / Webhook 密钥），无需手动编辑。Gitea 网关默认不启用，需要时加 `SKIP_GITEA=0`。

### 2. 安装 CLI 并注册账号/agent

```bash
pip install -e cli/        # 或 pip install zz-agent-cli
zz init --base-url http://<your-platform-host>:18080/agent
```

`zz init` 交互式完成：连接平台 → 注册账号 → 创建项目 → 注册 worker / PM agent → 打印 API key（`zzk_...`）和保活命令。

### 3. 注册 worker 并启动 executor

把 executor 脚本拷到装模型的机器上，为每个 agent 身份生成保活配置（launchd / systemd），agent 就会自动轮询 inbox、领活、调用本地 CLI、回传结果：

```bash
mkdir -p ~/.zz-agent
cp deploy/nas/agent-executors/*.py ~/.zz-agent/

# 以 kimi 为例（支持 codex / kimi / mimo / claude，也支持自定义 CLI）
./deploy/nas/agent-executors/generate-executor-config.sh kimi \
    --base-url http://<your-platform-host>:18080/agent \
    --key zzk_<your-agent-key> \
    --project-dir /tmp/zz-workspace \
    --install
```

> **macOS ⚠️ 工作目录不能在 `~/Documents` 下**：macOS TCC 会阻止 launchd 进程访问 Documents。executor 工作目录请放在 TCC 保护范围外，如 `/tmp/zz-workspace`。同时需要给 agent CLI 二进制一次性 Full Disk Access 授权（`generate-executor-config.sh` 会引导）。详见 [deploy/nas/agent-executors/README.md](deploy/nas/agent-executors/README.md)。

在 dashboard 或 `zz agents list --project <id>` 中确认 agent 显示为 `online / healthy`。

### 4. PM 派活，模型自动执行

```bash
# 创建 orchestration
zz orchestrations create --project <id> --title "实现登录" \
    --objective "用 JWT 实现用户登录" \
    --main-agent <pm-id> --workers <worker-id>

# 直接派发给指定 worker
zz tasks create -p <project> -o <orchestration> \
    -t "实现用户登录接口" -g "用 JWT 实现 /login 和 /me" -a <worker-agent-id>

# 或让平台按能力 + 负载智能派发
zz tasks smart-dispatch -p <project> -o <orchestration> \
    -t "写 API 文档" -g "补充 docs/api-cookbook.md" --required-capability docs
```

worker 完成后自动提交 changeset，PM executor 自动审核并合并，最终触发 CI / post-merge verify。你也可以在 dashboard 里手动审批。

## 架构概览

平台、worker runtime、NAS/部署主机、CI 验证四层组成。完整架构说明见 [docs/architecture.md](docs/architecture.md)。

```text
┌──────────────── Platform (Node.js + Postgres + isomorphic-git) ───────────────┐
│  PM 派活 → 智能路由 → 持久 inbox → 变更集审核 → Git 合并 → post-merge verify   │
│       │  X-ZZ-Agent-Id                                                         │
└───────┼───────────────────────────────────────────────────────────────────────┘
        │ HTTP(S)
        ▼
┌─── Worker Host (Mac / Linux) ────────────────────────────────────────────────┐
│  Unified Runtime (cli/zz_cli)  ──▶  invoke server (:7788)  ◀──  本地 LLM CLI │
│  Executor daemon (launchd/systemd)  轮询/认领/执行/检测变更/提交              │
└───────────────────────────────────────────────────────────────────────────────┘
```

典型数据流（autonomous loop）：

```text
dispatch ──▶ worker ──▶ changeset ──▶ auto-merge ──▶ CI
```

1. PM 通过 `POST .../tasks` 派任务，平台路由到 worker 的 durable inbox 并发送签名 invoke。
2. Worker executor 认领任务，读取 `.worker_task.md` / `.worker_context.md`，调用本地模型 CLI。
3. 模型完成工作、修改文件后，executor 检测 `git diff`。
4. Executor 提交 `result_md`、`evidence` 和 `status=ready_for_review`。
5. 平台自动创建 changeset；PM executor 审核并 `auto_merge=true` 合并。
6. CI / post-merge verify 运行构建与测试，结果回写到平台。

## 核心特性

| 特性 | 说明 |
|------|------|
| 🧠 **Smart Dispatch** | 按 `required_capability` + worker 在线/健康/负载自动选择最佳 agent；无匹配时返回 `409 NO_ELIGIBLE_WORKER`。 |
| 🤖 **自驱动 PM Executor** | PM agent daemon 自动轮询 inbox → review → auto-merge，事件驱动，无需人工守 chat。 |
| 🔀 **Auto-merge** | Changeset 审核通过默认自动合并；合并服务带冲突守卫与回归守卫，防止脏覆盖。 |
| 🛡️ **Health Gate** | 派活前强制检查：worker 在线、可派发、smoke healthy；死 worker 会被 staleness sweep 标记并通知 PM。 |
| 📊 **Observability** | `loop-status` / `metrics` / `worker-load` / `timeline` / `audit-log` / `alerts` 多维度观测面。 |
| 🌳 **真实 Git 后端** | 基于 isomorphic-git 的真版本控制，每项目独立 bare repo，支持分支/合并/历史，可对接 Gitea/Forgejo。 |
| 📝 **MD 驱动工作流** | `goal.md → TASK.md → RESULT.md → REVIEW.md`——人机可读的协作契约。 |
| 🔒 **私有部署** | 数据不出内网，NAS Docker Compose 一键部署，对抗云端 Devin 的数据出境风险。 |
| ⚡ **统一本地 Runtime** | 一台机器上所有本地模型（kimi/codex/mimo/claude/hermes）统一发现、路由、实例化、保活。 |

## API 参考

- **[docs/api-cookbook.md](docs/api-cookbook.md)** — 可复制的 `curl` 食谱：注册、登录、创建项目/agent/orchestration、派发任务、认领、完成、审核合并、观测接口。
- **[docs/autonomous-loop.md](docs/autonomous-loop.md)** — 自驱动循环的完整 API 参考：auth 方式、worker 生命周期、PM 生命周期、状态机、安全链、常见陷阱。

端点速览：

| 能力 | 端点 |
|------|------|
| 注册/登录 | `POST /v1/auth/register`, `POST /v1/auth/token` |
| 项目/agent | `POST /v1/projects`, `POST /v1/projects/:pid/agents` |
| 派活 | `POST /v1/projects/:pid/orchestrations/:oid/tasks` |
| 智能派活 | `POST /v1/projects/:pid/orchestrations/:oid/tasks/smart-dispatch` |
| 认领/完成 | `PATCH .../tasks/:tid/claim`, `POST .../tasks/:tid/complete` |
| 审核合并 | `PATCH /v1/projects/:pid/changesets/:cid/review` |
| 观测 | `GET /v1/projects/:pid/loop-status`, `GET .../metrics`, `GET .../worker-load`, `GET .../timeline` |

## Worker 配置

已内置 codex / kimi / mimo / claude 的 executor wrapper + handler。也支持 gemini / aider / 任意自定义 CLI。

| 模型 | 启动方式 | 说明 |
|------|----------|------|
| **kimi** | `generate-executor-config.sh kimi --key ... --install` | 调用 `~/.kimi-code/bin/kimi` |
| **mimo** | `generate-executor-config.sh mimo --key ... --install` | 调用 `mimo` CLI |
| **codex** | `generate-executor-config.sh codex --key ... --install` | 调用 `codex` CLI，支持身份文件 |
| **claude** | 手动运行 `python3 ~/.zz-agent/claude-worker-executor-wrapper.py` | 调用 `claude` CLI |
| **gemini / aider** | `generate-executor-config.sh gemini|aider --key ... --install` | 生成器也内置了对应模板 |
| **自定义** | 复制 `kimi-worker-handler.py` 写新 handler | 任意 stdin→stdout CLI 都可接入 |

统一 runtime 还支持三种调用模式：

- `cli:<model>` — 一次性 chat（快速 ack）
- `instance:<model>` — 持久 tmux 实例（多轮上下文、读写文件、调用工具）
- `api` — OpenAI 兼容 HTTP（deepseek / openai / moonshot / GLM 等）

详见 [`cli/zz_cli/RUNTIME.md`](cli/zz_cli/RUNTIME.md) 和 [`deploy/nas/agent-executors/README.md`](deploy/nas/agent-executors/README.md)。

## Dashboard

平台自带原生 HTML 仪表盘，部署后访问：

```text
http://<your-platform-host>:18080/agent/
```

入口文件为 [`dashboard/index.html`](dashboard/index.html)，可查看 orchestrations、tasks、approvals、agents、仓库浏览器等页面。后续计划重构为 React/Vue 前端。

## 项目结构

```
backend/          Node.js + TypeScript 后端 (197 API, 37 实体)
  src/routes/     API 路由 (orchestrations, versioning, agents, inbox ...)
  src/services/   核心服务 (git, gitea-sync, session-dispatch, runtime-adapter, health monitor)
  src/entities/   TypeORM 实体
dashboard/        前端 HTML UI
cli/              Python CLI + 统一 runtime
  zz_cli/runtime.py       统一本地模型 runtime
  zz_cli/executor.py      agent executor daemon
  zz_cli/invoke_server.py HTTP invoke 端点 (runtime.v1)
sdk/              Python SDK
deploy/           Docker Compose + 部署脚本 + agent executor 模板
docs/             文档 + 产品规划
```

## 路线图

- [x] 核心闭环：PM 派活 → 模型实例化 → 提交 → PM 自动审核合并 → CI 验证
- [x] 统一 runtime：多模型发现 + 精确路由 + 持久实例
- [x] 真实 Git 后端 + Gitea 网关
- [x] Smart-dispatch + auto-merge + health gate + observability
- [ ] 前端重构（当前原生 HTML → React/Vue）
- [ ] 多租户 + 团队 RBAC + SSO
- [ ] 托管平台（open-core 商业化）

## 开发

```bash
cd backend && npm install && npm run build && npm start
cd cli && pip install -e .
```

## License

MIT

## 致谢

本项目的统一 runtime 吸收了以下 agent 框架的非交互实例化方式：
- [Claude Code](https://code.claude.com) (Anthropic) — print mode + interactive agent
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research)
- [kimi-code](https://kimi.com) / [mimocode](https://mimocode.com) / [Codex](https://github.com/openai/codex)
