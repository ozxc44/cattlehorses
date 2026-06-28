# Agent Collaboration OS

> 让任意本地 AI 模型（kimi / claude / codex / hermes / mimo / deepseek …）自动协作完成软件项目——像 GitHub 团队一样派活、干活、审核、合并。

[English](README_EN.md)

**Agent Collaboration OS** 是一个多 agent 协作平台。它把一台（或多台）机器上的本地 AI 模型组织成一个开发团队：**主 agent（PM）拆解需求并派活 → worker agent 用各自模型实例干活 → PM 审核变更集 → 合并**。全程通过真实 Git 后端 + MD 驱动工作流，可审计、可私有部署。

## 这是什么 / 不是什么

**是**：多 agent 协作的**治理平台**——编排、路由、审核、合并一群 AI agent 的产出。

**不是**：又一个单 agent 编程助手（那是 Cursor / Copilot 的赛道）。这里管的是"一群 agent 怎么协作"。

## 核心能力

| 能力 | 说明 |
|------|------|
| 🤖 **统一本地模型 runtime** | 一个进程服务一台机器上**所有**本地模型（kimi/mimo/codex/claude/hermes），按 agent 身份精确路由。`--discover` 一键发现并接入每个模型，每个模型一个独立 agent 身份。 |
| 📋 **PM/worker 编排** | 主 agent 拆解目标为任务、派发给 worker、worker 提交结果、PM 审核验收（类 GitHub PR 流程）。 |
| 🌳 **真实 Git 后端** | 基于 isomorphic-git 的真版本控制（不是数据库模拟），支持分支/合并/历史，可对接 Gitea/Forgejo。 |
| 📝 **MD 驱动工作流** | `goal.md → TASK.md → RESULT.md → REVIEW.md`——人机可读的协作契约。 |
| 🔒 **私有部署** | 数据不出内网。企业可自托管，对抗 Devin/Azure 的数据出境问题。 |
| ⚡ **自启动 + 热缓存** | macOS launchd / systemd 自启动；本地模型按需实例化、热缓存，跨任务保持上下文。 |

## 快速开始

### 1. 部署平台（Docker Compose）

```bash
git clone <repo-url> && cd agent-collaboration-os
cd deploy/nas
# 编辑 .env (数据库/JWT 密钥/Gitea 配置)
cp .env.example .env
docker compose --env-file .env up -d
# 平台启动在 http://<your-platform-host>:18080/agent
```

### 2. 接入本地模型（agent 侧）

在装有本地模型（kimi/claude/codex/hermes/mimo）的机器上：

```bash
# 下载统一 runtime（纯 Python 标准库，无依赖）
curl -s http://<your-platform-host>:18080/agent/v1/agent/bootstrap/runtime.py -o runtime.py

# 一键发现本机所有模型 + 自启动
python3 runtime.py --discover --install-launchd --port 7788
```

runtime 会扫描本机的 kimi/mimo/codex/claude/hermes + API 模型（deepseek/openai/moonshot/GLM），为**每个模型生成一个独立 agent 身份**，并打印注册命令。

### 3. 注册模型到平台

按 `--discover` 打印的命令，把每个模型注册成平台上的 agent：

```bash
zz agents register -p <project-id> -n kimi-agent \
  --endpoint-url http://<your-host>:7788/zz/v1/invoke \
  --invoke-secret <secret-from-agents.json>
```

### 4. PM 派活，模型干活

PM（主 agent）通过平台派任务，平台按 agent 身份精确路由到对应模型实例化执行：

```bash
zz tasks create -p <project> -o <orchestration> \
  -t "实现用户登录" -g "用 JWT 实现登录" -a <worker-agent-id>
```

## 架构

```
┌──────────────── Platform (Node.js + Postgres + isomorphic-git) ───────────────┐
│  PM 派活 → 任务路由 → 变更集审核 → Git 合并                                     │
│       │  X-ZZ-Agent-Id                                                         │
└───────┼───────────────────────────────────────────────────────────────────────┘
        ▼
┌─── Unified Runtime (per host, pure Python) ──────────────────────────────────┐
│  agent_id → backend 路由表 (agents.json)                                       │
│   ├─ cli:kimi / cli:claude / cli:codex / cli:hermes / cli:mimo  (一次性 chat) │
│   ├─ instance:claude / instance:hermes / ...  (持久 agent 实例, tmux)         │
│   └─ api  (deepseek/openai/moonshot/GLM, OpenAI 兼容)                         │
└───────────────────────────────────────────────────────────────────────────────┘
        ▼
   本地模型实例化 → 读文件/写代码/用工具 → 提交结果 → PM 验收
```

## 支持的模型后端

| 后端 | 模型 | 模式 |
|------|------|------|
| `instance:<model>` | claude/hermes/kimi/mimo/codex | **持久 agent 实例**（tmux，读/写/工具/多轮上下文） |
| `cli:<model>` | 同上 | 一次性 chat（快速 ack） |
| `api` | deepseek/openai/moonshot/GLM | OpenAI 兼容 HTTP |
| `echo` | — | 测试模式 |

详见 [`cli/zz_cli/RUNTIME.md`](cli/zz_cli/RUNTIME.md)。

## 项目结构

```
backend/          Node.js + TypeScript 后端 (197 API, 37 实体)
  src/routes/     API 路由 (orchestrations, versioning, agents, inbox ...)
  src/services/   核心服务 (git, gitea-sync, session-dispatch, runtime-adapter)
  src/entities/   TypeORM 实体
dashboard/        前端 (原生 HTML, 计划重构为 React/Vue)
cli/              Python CLI + 统一 runtime
  zz_cli/runtime.py       统一本地模型 runtime (发现/路由/实例化/自启动)
  zz_cli/executor.py      agent executor daemon (搬运 TASK.md + PM 审核)
  zz_cli/invoke_server.py HTTP invoke 端点 (runtime.v1)
sdk/              Python SDK
deploy/           Docker Compose + 部署脚本
docs/             文档 + 产品规划
```

## 路线图

- [x] **核心闭环**：PM 派活 → 模型实例化 → 提交 → PM 验收
- [x] **统一 runtime**：多模型发现 + 精确路由 + 持久实例
- [x] **真实 Git 后端** + Gitea 网关
- [ ] **前端重构**（当前原生 HTML → React/Vue）
- [ ] **多租户** + 团队 RBAC + SSO
- [ ] **托管平台**（open-core 商业化）

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
