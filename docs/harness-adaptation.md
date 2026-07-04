# Harness 适配总览

cattlehorses 平台通过 adapter 模式接入任意 AI 编程 harness。每个 harness 只需一个 handler 脚本（~50 行），把平台任务转成该 harness CLI 的调用。

## 已接入

| harness | handler | CLI 模式 | capabilities | 状态 |
|---------|---------|---------|-------------|------|
| **Codex** (OpenAI) | codex-invoke-handler.py | `codex exec` | code, analysis, docs | ✅ 在线 |
| **Claude Code** | claude-worker-handler.py | `claude -p` | code, analysis, docs, chat | ✅ 在线 |
| **Kimi** (Moonshot) | kimi-worker-handler.py | `kimi -p` | code, docs, chat | ✅ 在线 |
| **Mimo** (小米) | mimo-invoke-handler.py | `mimo run` | code, chat | ✅ 在线 |
| **Hermes** | agent-platform-executor.py | `hermes -z` | code, analysis | ✅ 在线 |
| **Gemini CLI** (Google) | gemini-worker-handler.py | `gemini -p` | code, analysis, docs, chat | handler/config ready |
| **Aider** (开源) | aider-worker-handler.py | `aider --message --no-auto-commits` | code, docs, chat | handler/config ready |

## 待适配（主流 harness）

| harness | CLI 非交互模式 | 接入难度 | 优先级 | 说明 |
|---------|--------------|---------|--------|------|
| **OpenCode** | `opencode run "prompt"` | 低 | 中 | 开源，社区活跃 |
| **Goose** (Block) | `goose session --text "prompt"` | 中 | 中 | Block 开源 |
| **Continue.dev** | `continue` (需 API) | 中 | 中 | VSCode 插件生态 |
| **Cursor** | 无 CLI | 高 | 低 | 主要 GUI |

## 接入标准流程

任何 harness 接入只需 4 步：

```bash
# 1. 写 handler（参考 deploy/nas/agent-executors/claude-worker-handler.py）
#    核心：读 stdin 任务 JSON → 调 CLI → stdout 输出 {"content": "result"}

# 2. 注册 agent（带 capabilities）
zz agents create --name gemini --capabilities code,analysis

# 3. 生成 executor 配置
./deploy/nas/agent-executors/generate-executor-config.sh <type> \
    --base-url http://<host>:18080/agent --key <agent-key> --install

# 4. 平台按 capabilities 派活
```

## Handler 模板（通用）

所有 handler 遵循相同契约，只是 CLI 调用不同：

```python
# 1. 读任务 JSON（stdin）
req = json.loads(sys.stdin.read())

# 2. 构造 prompt
prompt = build_prompt(req)

# 3. 调 CLI（这一行是唯一差异）
proc = subprocess.run([CLI_BIN, "-p", prompt], capture_output=True, timeout=1500)

# 4. 输出结果
print(json.dumps({"content": proc.stdout}))
```

## 模型后端配置

每个 harness 支持不同模型后端，见各 skill：
- Claude Code → `claude-code-model-config` skill（settings.json env 配置）
- Codex → Codex.app 内置模型选择
- Aider → `--model` 参数 + API key 环境变量
- Gemini → `GEMINI_API_KEY` 环境变量

## Executor 配置映射

`generate-executor-config.sh` 负责把 agent type 映射到 wrapper 和 agent key 环境变量：

| agent type | wrapper | key env |
|------------|---------|---------|
| codex | codex-pm-executor-wrapper.py | ZZ_IDENTITY_PATH |
| kimi | kimi-worker-executor-wrapper.py | KIMI_AGENT_KEY |
| mimo | mimo-worker-executor-wrapper.py | MIMO_AGENT_KEY |
| gemini | gemini-worker-executor-wrapper.py | GEMINI_AGENT_KEY |
| aider | aider-worker-executor-wrapper.py | AIDER_AGENT_KEY |

## 为什么这样设计

平台**不绑死任何 harness**——adapter 模式 + capabilities 让任意 CLI 都能接入。客户有什么 harness 就接什么，PM 按能力派活，不关心底层是哪个。
