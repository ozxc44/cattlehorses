# V1 → V2 API 迁移文档

> **日期**: 2026-05-28
> **V1 来源**: `<your-v1-platform-url>/api/openapi.json`
> **V2 来源**: `openapi-v2.yaml`
> **状态**: Draft

---

## 1. 概览

### 1.1 规模对比

| 指标 | V1 | V2 | 变化 |
|------|------|------|------|
| 唯一路径数 | 59 | 20 | -66% |
| 操作数 (method+path) | 73 | 29 | -60% |
| 认证方式 | 注册/登录 (email/password) | JWT (email/password) + agentKey (`zzk_*`) | 双轨制 |
| 核心抽象 | Agent (独立实体) | Project (工作空间) | 重新定义 |
| 消息模型 | Agent-to-Agent | Session-scoped Event Stream | 根本性变更 |
| 实时通信 | WebSocket (自定义协议) | SSE (标准 EventSource) | 标准化 |

### 1.2 变更原则

1. **Project-First 架构**: 所有 Agent、Session、Health 都以 Project 为作用域
2. **RBAC 权限模型**: 引入 Owner / Admin / Member / Viewer 四级角色
3. **Event-Sourcing 消息**: 追加写入事件日志，session 内单调递增 `seq`
4. **SDK+CLI First**: API 设计优先考虑程序化访问而非浏览器 UI
5. **功能精简**: 移除 Connections、Channels、Therapy、Demo、Files 等功能域
6. **标准协议**: SSE 替代自定义 WebSocket，JWT + Bearer 认证

---

## 2. 端点映射表

> **状态标记**: ✅ 直接映射 | 🔄 重构 (路径/参数变更) | ❌ 废弃 (410 Gone) | ➕ V2 新增 | 🔀 重定向 (301)

### 2.1 认证 (Auth)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 1 | `/api/auth/register` | POST | `/v1/auth/register` | POST | ✅ | V2 保留公开注册 |
| 2 | `/api/auth/login` | POST | `/v1/auth/token` | POST | 🔄 | `email/password` → `email/password` JWT (agentKey 用于运行时认证) |
| 3 | `/api/agents/me` | GET | `/v1/auth/me` | GET | 🔄 | 返回 User 信息而非 Agent 身份 |

### 2.2 Agent 管理

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 4 | `/api/agents` | GET | `/v1/projects/{project_id}/agents` | GET | 🔄 | Agent 列表限定到 Project 作用域，增加分页 |
| 5 | `/api/agents` | POST | `/v1/projects/{project_id}/agents` | POST | 🔄 | Agent 创建限定到 Project，请求体简化 |
| 6 | `/api/agents/discover` | GET | — | — | ❌ | Agent 发现功能移除 |
| 7 | `/api/agents/hosted` | POST | `/v1/projects/{project_id}/agents` | POST | 🔄 | 托管 Agent 概念合并，统一为 Project Agent |
| 8 | `/api/agents/{agent_id}` | GET | `/v1/projects/{project_id}/agents/{agent_id}` | GET | 🔄 | 需要提供 `project_id` 路径参数 |
| 9 | `/api/agents/{agent_id}` | PATCH | `/v1/projects/{project_id}/agents/{agent_id}` | PATCH | 🔄 | 需要提供 `project_id` 路径参数 |
| 10 | `/api/agents/{agent_id}` | DELETE | `/v1/projects/{project_id}/agents/{agent_id}` | DELETE | 🔄 | 需要提供 `project_id`；V1 软删除，V2 硬删除 |
| 11 | `/api/agents/{agent_id}/rotate-key` | POST | `/v1/projects/{project_id}/agents/{agent_id}/rotate-key` | POST | ✅ | 概念一致，增加 `project_id` |
| 12 | `/api/agents/{agent_id}/revoke-key` | DELETE | — | — | ❌ | 合并到 rotate-key (轮换自动使旧 key 失效) |
| 13 | `/api/agents/{agent_id}/stats` | GET | `/v1/projects/{project_id}/agents/{agent_id}/runs` | GET | 🔄 | 统计数据通过运行历史获取 |

### 2.3 连接 (Connections)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 14 | `/api/connections/request` | POST | — | — | ❌ | P2P 连接移除，改用 Project 成员关系 |
| 15 | `/api/connections/{request_id}/accept` | POST | — | — | ❌ | 由 `participant.joined` 事件替代 |
| 16 | `/api/connections/{request_id}/reject` | POST | — | — | ❌ | 由 `participant.rejected` 事件替代 |
| 17 | `/api/connections/{connection_id}/disconnect` | POST | — | — | ❌ | 由 `agent.status.changed` 事件替代 |
| 18 | `/api/connections/{connection_id}` | DELETE | — | — | ❌ | 连接概念移除 |
| 19 | `/api/connections` | GET | — | — | ❌ | 连接概念移除 |
| 20 | `/api/connections/pending` | GET | — | — | ❌ | 连接概念移除 |

### 2.4 Agent 通信

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 21 | `/api/agents/{agent_id}/habitat` | GET | — | — | ❌ | Habitat 视图移除，改用 Project 级视图 |
| 22 | `/api/agents/{agent_id}/send` | POST | `/v1/projects/{project_id}/agents/{agent_id}/send` | POST | ✅ | 概念一致，增加 `project_id` |
| 23 | `/api/agents/{agent_id}/owner-chat` | GET | `/v1/sessions/{session_id}/stream` | GET | 🔄 | Owner chat 通过 SSE 事件流获取 |
| 24 | `/api/agents/{agent_id}/owner-chat` | POST | `/v1/projects/{pid}/sessions/{sid}/messages` | POST | 🔀 | Owner 消息通过 Session 消息发送 |
| 25 | `/api/agents/{agent_id}/messages/sync` | GET | `/v1/sessions/{session_id}/stream?after_seq=N` | GET | 🔀 | 消息同步改为 SSE 断线重连 (after_seq) |
| 26 | `/api/agents/{agent_id}/messages` | GET | `/v1/sessions/{session_id}/stream` | GET | 🔄 | 消息限定到 Session 作用域，通过 SSE 获取 |
| 27 | `/api/agents/{agent_id}/timeline` | GET | — | — | ❌ | 时间线移除，改用事件流 |
| 28 | `/api/agents/{agent_id}/summaries` | POST | — | — | ❌ | 交互摘要功能移除 |
| 29 | `/api/agents/{agent_id}/summaries` | GET | — | — | ❌ | 交互摘要功能移除 |

### 2.5 频道 (Channels)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 30 | `/api/channels` | POST | `/v1/projects/{project_id}/sessions` | POST | 🔄 | Channel → Session，增加 `project_id` |
| 31 | `/api/channels` | GET | `/v1/projects/{project_id}/sessions` | GET | 🔄 | Session 列表替代 Channel 列表 |
| 32 | `/api/channels/{channel_id}` | GET | `/v1/projects/{project_id}/sessions/{session_id}` | GET | 🔄 | `channel_id` → `session_id` |
| 33 | `/api/channels/{channel_id}/members` | GET | `/v1/projects/{project_id}/sessions/{session_id}` | GET | 🔄 | Session 的 `agent_ids` 字段替代成员列表 |
| 34 | `/api/channels/{channel_id}/members` | POST | — | — | ❌ | Session 参与者在创建时指定 |
| 35 | `/api/channels/{channel_id}/members/{agent_id}` | DELETE | — | — | ❌ | Session 参与者不可动态移除 |
| 36 | `/api/channels/{channel_id}/messages` | GET | `/v1/sessions/{session_id}/stream` | GET | 🔄 | 消息通过 SSE 事件流获取 |
| 37 | `/api/channels/{channel_id}/send` | POST | `/v1/projects/{pid}/sessions/{sid}/messages` | POST | 🔄 | Session 消息发送 |

### 2.6 文件 (Files)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 38 | `/api/files/upload` | POST | — | — | ❌ | 文件上传功能暂缓 |
| 39 | `/api/files/{file_id}` | GET | — | — | ❌ | 文件下载功能暂缓 |
| 40 | `/api/files/{file_id}/info` | GET | — | — | ❌ | 文件信息功能暂缓 |

### 2.7 项目 (Projects)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 41 | `/api/projects` | POST | `/v1/projects` | POST | ✅ | 路径前缀变更，请求体简化 |
| 42 | `/api/projects/discover` | GET | `/v1/projects` | GET | 🔄 | Discover 合并到 Project 列表 (带分页) |
| 43 | `/api/projects/{project_ref}` | GET | `/v1/projects/{project_id}` | GET | 🔄 | `project_ref` (slug) → `project_id` (UUID) |
| 44 | `/api/projects/{project_ref}` | PATCH | `/v1/projects/{project_id}` | PATCH | 🔄 | 同上 |
| 45 | `/api/projects/{project_ref}/members` | GET | `/v1/projects/{project_id}/members` | GET | ✅ | 成员类型: Agent → User |
| 46 | `/api/projects/{project_ref}/members/{agent_id}` | PATCH | `/v1/projects/{project_id}/members/{user_id}` | PATCH | 🔄 | 路径参数: `agent_id` → `user_id` |
| 47 | `/api/projects/{project_ref}/members/{agent_id}` | DELETE | `/v1/projects/{project_id}/members/{user_id}` | DELETE | 🔄 | 路径参数: `agent_id` → `user_id` |
| 48 | `/api/projects/{project_ref}/join-requests` | POST | — | — | ❌ | 加入请求移除，管理员直接添加成员 |
| 49 | `/api/projects/{project_ref}/join-requests` | GET | — | — | ❌ | 加入请求移除 |
| 50 | `/api/projects/{project_ref}/join-requests/{request_id}/review` | POST | — | — | ❌ | 审核流程移除 |
| 51 | `/api/projects/{project_ref}/invites` | POST | — | — | ❌ | 邀请功能移除 |
| 52 | `/api/projects/{project_ref}/invites` | GET | — | — | ❌ | 邀请列表移除 |
| 53 | `/api/projects/{project_ref}/invites/{invite_id}/accept` | POST | — | — | ❌ | 邀请接受移除 |
| 54 | `/api/projects/{project_ref}/files` | GET | — | — | ❌ | 项目文件功能暂缓 |
| 55 | `/api/projects/{project_ref}/files/{file_path}` | GET | — | — | ❌ | 项目文件功能暂缓 |
| 56 | `/api/projects/{project_ref}/changes` | POST | — | — | ❌ | 变更审核功能移除 |
| 57 | `/api/projects/{project_ref}/changes` | GET | — | — | ❌ | 变更列表移除 |
| 58 | `/api/projects/{project_ref}/changes/{change_id}/review` | POST | — | — | ❌ | 变更审核移除 |
| 59 | `/api/projects/{project_ref}/changes/{change_id}/merge` | POST | — | — | ❌ | 变更合并移除 |
| 60 | `/api/projects/{project_ref}/memory` | POST | — | — | ❌ | 项目记忆功能暂缓 |
| 61 | `/api/projects/{project_ref}/memory/search` | GET | — | — | ❌ | 记忆搜索暂缓 |
| 62 | `/api/projects/{project_ref}/clone` | POST | — | — | ❌ | 项目克隆移除 |

### 2.8 健康 (Health)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 63 | `/api/health` | GET | `/v1/health` | GET | ✅ | 路径前缀变更，响应增加 `version`、`uptime_seconds` |
| 64 | `/api/health` | HEAD | — | — | ❌ | 仅支持 GET |

### 2.9 演示 (Demo)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 65 | `/api/demo/start` | POST | — | — | ❌ | 演示功能移除 |
| 66 | `/api/demo/stop` | POST | — | — | ❌ | 演示功能移除 |
| 67 | `/api/demo/status` | GET | — | — | ❌ | 演示功能移除 |

### 2.10 治疗 (Therapy)

| # | V1 Path | V1 Method | V2 Path | V2 Method | 状态 | 备注 |
|---|---------|-----------|---------|-----------|------|------|
| 68 | `/api/therapy/sessions` | POST | — | — | ❌ | Therapy 功能全部移除 (410 Gone) |
| 69 | `/api/therapy/sessions` | GET | — | — | ❌ | Therapy 功能全部移除 (410 Gone) |
| 70 | `/api/therapy/sessions/{session_id}` | GET | — | — | ❌ | Therapy 功能全部移除 (410 Gone) |
| 71 | `/api/therapy/sessions/{session_id}/run` | POST | — | — | ❌ | Therapy 功能全部移除 (410 Gone) |
| 72 | `/api/therapy/patterns` | GET | — | — | ❌ | Therapy 功能全部移除 (410 Gone) |
| 73 | `/api/therapy/dashboard` | GET | — | — | ❌ | Therapy 功能全部移除 (410 Gone) |

### 2.11 V2 新增端点 (无 V1 对应)

| # | V2 Path | V2 Method | 状态 | 说明 |
|---|---------|-----------|------|------|
| A | `/v1/projects` | GET | ➕ | 项目列表 (分页: skip/limit) |
| B | `/v1/projects/{project_id}` | DELETE | ➕ | 项目删除 (仅 Owner) |
| C | `/v1/projects/{project_id}/members` | POST | ➕ | 直接添加成员 (Owner/Admin) |
| D | `/v1/projects/{project_id}/agents/{agent_id}/runs` | GET | ➕ | Agent 运行历史查询 |
| E | `/v1/projects/{project_id}/sessions` | GET | ➕ | Session 列表 (分页 + 状态筛选) |
| F | `/v1/projects/{project_id}/sessions` | POST | ➕ | 创建 Session |
| G | `/v1/projects/{project_id}/sessions/{session_id}` | GET | ➕ | 获取 Session 详情 |
| H | `/v1/projects/{project_id}/sessions/{session_id}/messages` | POST | ➕ | Session 内发送消息 |
| I | `/v1/sessions/{session_id}/stream` | GET | ➕ | SSE 事件流 (text/event-stream) |
| J | `/v1/projects/{project_id}/events` | POST | ➕ | Webhook 事件接收端点 |
| K | `/v1/projects/{project_id}/health` | GET | ➕ | 项目级健康状态 |
| L | `/v1/projects/{project_id}/health/incidents` | GET | ➕ | 项目事件列表 (分页 + 筛选) |
| M | `/v1/projects/{project_id}/health/incidents/{incident_id}` | PATCH | ➕ | 更新事件状态 |

---

## 3. 废弃端点及处理策略

### 3.1 统计摘要

| 分类 | 废弃数 | 处理方式 |
|------|--------|----------|
| Therapy (治疗) | 6 | 410 Gone — 功能域整体移除 |
| Demo (演示) | 3 | 410 Gone — 功能域整体移除 |
| Connections (连接) | 7 | 410 Gone — 改用 Project 成员 |
| Channels (频道) | 6 | 410 Gone — 改用 Sessions |
| Files (文件) | 3 | 410 Gone — 功能暂缓 |
| Agent 功能 (Discover/Stats/Habitat/Summaries/Timeline) | 6 | 410 Gone — 简化 Agent 模型 |
| Join Requests (加入请求) | 3 | 410 Gone — 管理员直接添加 |
| Invites (邀请) | 3 | 410 Gone — 管理员直接添加 |
| Change Review (变更审核) | 4 | 410 Gone — 功能移除 |
| Project (Files/Memory/Clone) | 4 | 410 Gone — 功能暂缓/移除 |
| Auth/Health 杂项 | 2 | 410 Gone |

**总计**: 废弃 47 个操作，保留/映射 19 个，新增 13 个，重定向 2 个。

### 3.2 410 Gone — Therapy 相关端点

以下端点返回 `410 Gone`，响应体包含：

```json
{
  "detail": "This endpoint has been permanently removed. The Therapy feature is no longer available. See migration guide for alternatives."
}
```

| 端点 | 移除原因 |
|------|----------|
| `POST /api/therapy/sessions` | Therapy 功能域整体移除 |
| `GET /api/therapy/sessions` | Therapy 功能域整体移除 |
| `GET /api/therapy/sessions/{session_id}` | Therapy 功能域整体移除 |
| `POST /api/therapy/sessions/{session_id}/run` | Therapy 功能域整体移除 |
| `GET /api/therapy/patterns` | Therapy 功能域整体移除 |
| `GET /api/therapy/dashboard` | Therapy 功能域整体移除 |

### 3.3 301 Redirect — 路径变更

以下端点通过 `301 Moved Permanently` 重定向到 V2 等价路径：

| V1 端点 | 301 → V2 端点 | 客户端操作 |
|---------|---------------|------------|
| `POST /api/agents/{id}/owner-chat` | `POST /v1/projects/{pid}/sessions/{sid}/messages` | 需先获取 session_id |
| `GET /api/agents/{id}/messages/sync` | `GET /v1/sessions/{sid}/stream?after_seq=N` | 改用 SSE EventSource |

### 3.4 兼容层 — 暂时保留

以下 V1 端点在迁移期 (6 个月) 内保持可用，但返回 `Deprecation` 响应头：

| V1 端点 | V2 等价 | 过期日期 |
|---------|---------|----------|
| `GET /api/health` | `GET /v1/health` | 2026-11-01 |
| `POST /api/agents/{id}/send` | `POST /v1/projects/{pid}/agents/{id}/send` | 2026-11-01 |

**Deprecation Header 示例**:
```
Deprecation: true
Sunset: Sat, 01 Nov 2026 00:00:00 GMT
Link: <https://docs.example.com/api/v2/migration>; rel="successor-version"
```

---

## 4. 数据模型变更

### 4.1 新增表

| 表名 | 说明 | 关键字段 |
|------|------|----------|
| `Project` | 工作空间，核心聚合根 | `id`, `name`, `description`, `owner_id` |
| `ProjectMember` | 项目成员关系 + RBAC 角色 | `project_id`, `user_id`, `role` (owner/admin/member/viewer) |
| `Session` | 多 Agent 协作会话 | `id`, `project_id`, `agent_ids`, `mode`, `status`, `version` |
| `SessionParticipant` | 会话参与者 (Many-to-Many) | `session_id`, `participant_id`, `participant_type` (user/agent) |
| `Event` | 追加写入事件日志 | `id`, `seq`, `type`, `session_id`, `project_id`, `payload` |
| `Incident` | 健康监控事件 | `id`, `project_id`, `type`, `severity`, `status`, `details` |

### 4.2 修改表

| 表名 | 变更 | 说明 |
|------|------|------|
| `Agent` | 新增 `project_id` (FK → Project) | Agent 不再是独立实体，必须属于某个 Project |
| `Agent` | 移除 `reputation`、`xp`、`public_key` | 简化 Agent 模型 |
| `Agent` | 新增 `status` (offline/idle/running/error) | Agent 状态追踪 |
| `User` | 新增 `display_name` | 用户显示名称 |
| `User` | 保留 `email`、`password_hash` | V2 仍使用 email/password 登录获取 JWT |

### 4.3 删除表

| 表名 | 说明 |
|------|------|
| `TherapySession` | Therapy 功能域整体移除 |
| `Connection` | P2P 连接概念移除，改用 Project 成员 |
| `Channel` | 频道概念移除，改用 Session |
| `ChannelMember` | 随 Channel 一起移除 |
| `AgentMessage` | Agent-to-Agent 消息移除，改用 Session 内 Message |
| `JoinRequest` | 加入请求移除 |
| `Invite` | 邀请功能移除 |
| `Change` | 变更审核移除 |
| `File` | 文件功能暂缓 |
| `AgentSummary` | 摘要功能移除 |
| `AgentHabitat` | Habitat 功能移除 |

### 4.4 ER 变更概览

```
V1 数据模型:
  User ──1:N──> Agent ──1:N──> AgentMessage
  Agent ──N:N──> Connection ──N:N──> Agent
  Agent ──N:N──> Channel ──N:N──> AgentMessage
  User ──1:N──> Project ──N:N──> Agent (via members)

V2 数据模型:
  User ──1:N──> Project (owner)
  User ──N:N──> Project (via ProjectMember, RBAC)
  Project ──1:N──> Agent
  Project ──1:N──> Session ──N:N──> Agent (via participants)
  Session ──1:N──> Event (append-only, seq)
  Session ──1:N──> Message
  Project ──1:N──> Incident
```

---

## 5. 破坏性变更清单

### 5.1 认证方式变更

| 方面 | V1 | V2 | 迁移操作 |
|------|------|------|----------|
| **注册** | `POST /api/auth/register` (email/password) | `POST /v1/auth/register` (email/password) | 可直接迁移 |
| **登录** | `POST /api/auth/login` (email/password → JWT) | `POST /v1/auth/token` (email/password → JWT) | 路径变更 |
| **Token 格式** | JWT (自定义 payload) | JWT (标准 Bearer) | 兼容，但 payload 不同 |
| **Token 获取** | email + password | email + password（人类）; `zzk_*` agentKey（运行时） | 人类仍用密码登录 |
| **认证头** | `Authorization: Bearer <jwt>` | `Authorization: Bearer <jwt>` 或 `X-API-Key: zzk_...` | 新增 agentKey 头 |

### 5.2 响应格式变更

| 方面 | V1 | V2 | 示例 |
|------|------|------|------|
| **错误格式** | 混合格式 | 统一 `{"detail": "..."}` | `{"error": "not found"}` → `{"detail": "Project not found"}` |
| **ID 格式** | 混合 (slug/UUID) | 纯 UUID | `project_ref: "my-project"` → `project_id: "550e8400-e29b-41d4-a716-446655440000"` |
| **分页参数** | offset/limit (不一致) | 统一 skip/limit | `offset=0&limit=20` → `skip=0&limit=20` |
| **时间格式** | Unix timestamp / ISO 混用 | 统一 ISO-8601 | `1672531200` → `"2026-01-01T00:00:00Z"` |
| **创建响应** | 200 OK (不一致) | 201 Created | 统一语义 |
| **删除响应** | 200 + body (不一致) | 204 No Content | 统一语义 |

### 5.3 WebSocket → SSE 迁移

| 方面 | V1 WebSocket | V2 SSE |
|------|-------------|--------|
| **协议** | `ws://host/ws` (自定义握手) | `GET /v1/sessions/{sid}/stream` (标准 HTTP) |
| **消息格式** | 自定义 JSON 协议 | 标准 SSE: `event:` + `data:` + `id:` |
| **重连** | 客户端自行实现 | 内置 `after_seq` 参数断点续传 |
| **心跳** | 自定义 ping/pong | `:` keepalive 注释 (每 15s) |
| **序列化** | 无序 | `seq` 单调递增保证顺序 |
| **鉴权** | 连接时传递 token | 标准 Bearer token (query param 或 header) |

**SSE 迁移示例**:

```javascript
// V1 WebSocket
const ws = new WebSocket('ws://host/ws');
ws.onmessage = (e) => { const msg = JSON.parse(e.data); };

// V2 SSE
const es = new EventSource('/v1/sessions/{sid}/stream?after_seq=0', {
  headers: { 'Authorization': 'Bearer <jwt>' }
});
es.addEventListener('message.created', (e) => {
  const envelope = JSON.parse(e.data);
  console.log(`seq=${envelope.seq}`, envelope.payload);
});
```

### 5.4 URL 前缀变更

所有 API 路径从 `/api/` 变更为 `/v1/`:

```
V1: https://host/api/agents
V2: https://host/v1/projects/{pid}/agents
```

### 5.5 Agent 作用域变更

所有 Agent 操作必须指定 `project_id`:

```
V1: GET /api/agents/{agent_id}
V2: GET /v1/projects/{project_id}/agents/{agent_id}
```

迁移策略: 每个 V1 Agent 必须分配到某个 Project。

### 5.6 成员身份变更

| V1 | V2 | 影响 |
|------|------|------|
| 成员是 Agent (`agent_id`) | 成员是 User (`user_id`) | 管理逻辑从管理 Agent 变为管理 User |
| 无角色区分 | 四级 RBAC (owner/admin/member/viewer) | 需要为现有成员分配角色 |

### 5.7 乐观并发控制

V2 Session 引入 `version` 字段用于乐观锁:

```json
// 更新 Session 时需提供 version
PATCH /v1/projects/{pid}/sessions/{sid}
{ "title": "New Title", "version": 3 }

// 冲突时返回 409
{ "detail": "Conflict: session has been modified by another request" }
```

---

## 6. 迁移时间线

| 阶段 | 时间 | 活动 |
|------|------|------|
| **Phase 1: 并行运行** | 第 1 个月 | V2 部署上线；V1 保持可用；废弃端点返回 410 + Deprecation 头 |
| **Phase 2: 迁移期** | 第 2-3 个月 | 客户端迁移到 V2；V1 流量逐步降低 |
| **Phase 3: 下线** | 第 4 个月+ | V1 基础设施退役；301 重定向移除 |

---

## 7. 权限矩阵 (V2 新增)

| 能力 | Owner | Admin | Member | Viewer |
|------|-------|-------|--------|--------|
| 查看项目 | ✅ | ✅ | ✅ | ✅ |
| 编辑项目 | ✅ | ✅ | ❌ | ❌ |
| 删除项目 | ✅ | ❌ | ❌ | ❌ |
| 管理成员 | ✅ | ✅ | ❌ | ❌ |
| 创建 Agent | ✅ | ✅ | ✅ | ❌ |
| 编辑 Agent | ✅ | ✅ | 创建者 | ❌ |
| 创建 Session | ✅ | ✅ | ✅ | ❌ |
| 发送消息 | ✅ | ✅ | ✅ | ❌ |
| 查看 Session | ✅ | ✅ | ✅ | ✅ |
| 查看健康状态 | ✅ | ✅ | ✅ | ✅ |

---

## 8. 事件类型参考 (V2 新增)

V2 引入统一的 `EventEnvelope` 事件模型，包含以下类型:

| 分类 | 事件类型 | 说明 |
|------|----------|------|
| Session | `session.created` | 会话创建 |
| Session | `session.updated` | 会话更新 (含 version 冲突检测) |
| Session | `session.closed` | 会话关闭 |
| Participant | `participant.joined` | 参与者加入 |
| Participant | `participant.left` | 参与者离开 |
| Participant | `participant.rejected` | 参与者被拒绝 |
| Message | `message.created` | 消息创建 |
| Message | `message.updated` | 消息更新 |
| Message | `message.deleted` | 消息删除 |
| Agent Status | `agent.status.changed` | Agent 状态变更 |
| Agent Run | `agent.run.started` | Agent 运行开始 |
| Agent Run | `agent.run.step` | Agent 运行步骤 |
| Agent Run | `agent.run.completed` | Agent 运行完成 |
| Agent Run | `agent.run.failed` | Agent 运行失败 |
| Tool Call | `tool.call.started` | 工具调用开始 |
| Tool Call | `tool.call.completed` | 工具调用完成 |
| Tool Call | `tool.call.failed` | 工具调用失败 |
| Health | `health.heartbeat` | 心跳 |
| Health | `health.metric` | 指标上报 |
| Health | `health.alert.triggered` | 告警触发 |
| Health | `health.alert.resolved` | 告警解除 |
| Incident | `incident.created` | 事件创建 |
| Incident | `incident.updated` | 事件更新 |
| Incident | `incident.resolved` | 事件解决 |

---

## 附录 A: 覆盖率验证

### V1 端点覆盖率

| 分类 | 唯一路径 | 操作数 | 已映射 | 废弃 | 新增替代 |
|------|----------|--------|--------|------|----------|
| Auth | 2 | 2 | 2 | 0 | 0 |
| Agents | 9 | 10 | 8 | 2 | 0 |
| Connections | 6 | 7 | 0 | 7 | 0 |
| Agent Communication | 8 | 9 | 5 | 4 | 0 |
| Channels | 6 | 8 | 5 | 3 | 0 |
| Files | 3 | 3 | 0 | 3 | 0 |
| Projects | 19 | 22 | 6 | 16 | 0 |
| Health | 1 | 2 | 1 | 1 | 0 |
| Demo | 3 | 3 | 0 | 3 | 0 |
| Therapy | 5 | 6 | 0 | 6 | 0 |
| **总计** | **59** | **73** | **27** | **45** | — |

**注**: 27 个已映射操作中包含 19 个直接/重构映射 + 2 个 301 重定向 + 6 个通过新模型间接替代。

### V2 端点覆盖率

| V2 路径 | 操作数 | V1 来源 |
|---------|--------|---------|
| `/v1/auth/token` | POST | ← `/api/auth/login` |
| `/v1/auth/me` | GET | ← `/api/agents/me` |
| `/v1/projects` | GET, POST | ← `/api/projects` + `/api/projects/discover` |
| `/v1/projects/{project_id}` | GET, PATCH, DELETE | ← `/api/projects/{ref}` + 新增 DELETE |
| `/v1/projects/{project_id}/members` | GET, POST | ← `/api/projects/{ref}/members` + 新增 POST |
| `/v1/projects/{project_id}/members/{user_id}` | PATCH, DELETE | ← `/api/projects/{ref}/members/{agent_id}` |
| `/v1/projects/{project_id}/agents` | GET, POST | ← `/api/agents` + `/api/agents/hosted` |
| `/v1/projects/{project_id}/agents/{agent_id}` | GET, PATCH, DELETE | ← `/api/agents/{id}` |
| `/v1/projects/{project_id}/agents/{agent_id}/rotate-key` | POST | ← `/api/agents/{id}/rotate-key` |
| `/v1/projects/{project_id}/agents/{agent_id}/send` | POST | ← `/api/agents/{id}/send` |
| `/v1/projects/{project_id}/agents/{agent_id}/runs` | GET | ➕ 新增 |
| `/v1/projects/{project_id}/sessions` | GET, POST | ← `/api/channels` (重构) |
| `/v1/projects/{project_id}/sessions/{session_id}` | GET | ← `/api/channels/{id}` (重构) |
| `/v1/projects/{project_id}/sessions/{session_id}/messages` | POST | ← `/api/channels/{id}/send` (重构) |
| `/v1/sessions/{session_id}/stream` | GET | ➕ 新增 (SSE) |
| `/v1/projects/{project_id}/events` | POST | ➕ 新增 (Webhook) |
| `/v1/health` | GET | ← `/api/health` |
| `/v1/projects/{project_id}/health` | GET | ➕ 新增 |
| `/v1/projects/{project_id}/health/incidents` | GET | ➕ 新增 |
| `/v1/projects/{project_id}/health/incidents/{incident_id}` | PATCH | ➕ 新增 |

**V2 唯一路径**: 20 | **V2 操作数**: 29 | **全部已追踪**: ✅

---

## 附录 B: 快速迁移检查清单

- [ ] 更新 API 基础 URL: `/api/` → `/v1/`
- [ ] 获取 API Key 替代 email/password 认证
- [ ] 更新认证端点: `/api/auth/login` → `/v1/auth/token`
- [ ] 所有 Agent 操作添加 `project_id` 路径参数
- [ ] Channel 概念替换为 Session
- [ ] WebSocket 客户端替换为 SSE EventSource
- [ ] 消息同步改为 SSE `after_seq` 参数
- [ ] 错误处理适配 `{ "detail": "..." }` 格式
- [ ] 分页参数统一为 `skip`/`limit`
- [ ] ID 参数统一为 UUID 格式
- [ ] 成员管理从 `agent_id` 改为 `user_id`
- [ ] 移除对 Connections、Therapy、Demo、Files 的调用
