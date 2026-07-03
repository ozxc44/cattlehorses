# Adapter SDK

Adapter SDK 位于 `sdk/adapter/`，用于将任意模型、CLI 或内部服务包装成符合 cattlehorses 协议的 Agent。第三方开发者只需实现一个 Python 适配器类、填写一份 `agent.adapter.json` 清单，即可把已有能力注册到平台并被其他 Agent 调用。

## 安装与快速开始

1. 将 `sdk/adapter/` 加入项目路径（或复制 `contract.py`、`conformance.py` 到仓库）。
2. 创建适配器模块，继承 `BaseAdapter`。
3. 实现三个接口：`name`、`execute(task)`、`health_check()`。
4. 调用 `run_conformance(adapter)` 验证通过。
5. 编写 `agent.adapter.json` 并执行 `zz agents register` 注册到平台。

## 最小完整示例

```python
from sdk.adapter.contract import BaseAdapter
from sdk.adapter.conformance import run_conformance

class MyAdapter(BaseAdapter):
    @property
    def name(self) -> str:
        return "my-adapter"

    def execute(self, task: dict) -> dict:
        prompt = task.get("prompt", "")
        return {
            "content": f"收到任务: {prompt}",
            "evidence": {"adapter": self.name},
        }

    def health_check(self) -> bool:
        return True

if __name__ == "__main__":
    adapter = MyAdapter()
    result = run_conformance(adapter)
    print(result)
```

运行后 `result["passed"]` 应为 `True`。

## `agent.adapter.json` 清单格式

```json
{
  "name": "my-adapter",
  "version": "1.0.0",
  "capabilities": ["chat", "summarize"],
  "handler_command": "python -m my_adapter"
}
```

字段说明：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | `str` | 适配器唯一名称，与 `BaseAdapter.name` 保持一致 |
| `version` | `str` | 语义化版本号 |
| `capabilities` | `list[str]` | 声明本适配器支持的能力标签 |
| `handler_command` | `str` | 平台启动该适配器的命令 |

使用 `AdapterManifest.load_manifest(path)` 可读取并校验该清单。

## 注册到平台

在适配器目录下执行：

```bash
zz agents register
```

平台会读取当前目录的 `agent.adapter.json`，完成注册后其他 Agent 即可通过名称调用该适配器。

## 一致性测试

`run_conformance(adapter)` 会检查：

- `name` 是非空字符串；
- `execute(task)` 返回包含 `content` 键的字典，且 `content` 为非空字符串；
- `health_check()` 返回布尔值。

返回结构：

```python
{
    "passed": True,
    "checks": [
        {"name": "name_nonempty", "passed": True, "detail": ""},
        {"name": "execute_returns_content", "passed": True, "detail": ""},
        {"name": "health_check_bool", "passed": True, "detail": ""},
    ],
}
```

建议将 `run_conformance(adapter)` 加入 CI，保证每次提交都通过基础契约检查。

## 参考实现

- `sdk/adapter/contract.py`：`BaseAdapter`、`AdapterManifest` 定义。
- `sdk/adapter/conformance.py`：`run_conformance` 实现。
- `sdk/adapter/examples/shell_adapter.py`：封装本地 Shell 的参考适配器。
