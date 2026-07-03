#!/usr/bin/env python3
"""
自主改进循环: 100 轮 "codex分析(gk) → 主agent采纳 → kimi/mimo实施 → 验收".

每轮:
  1. 建 orchestration
  2. 派 codex 任务: 通读项目 + 调 gk 委员会分析不足, 产出 P0/P1/P2 清单
  3. 等 codex 完成, 读取分析结果
  4. 主 agent 采纳: 从清单挑 1-2 个可执行项
  5. 并行派给 kimi + mimo 实施
  6. 等 kimi/mimo 完成
  7. 验收 (approved / changes_requested)
  8. 记录本轮结果, 进入下一轮

容错:
  - gk 超时/失败 → codex 退化为自身分析 (不阻塞)
  - 任务卡住 → 超时 reassign 或跳过
  - 全程日志 + 进度文件

用法: nohup python3 autonomous-improvement-loop.py [--rounds 100] [--round N] &
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
PROJECT_ID = "ed5cc63a-0049-42a8-b503-47a9d102dc3f"
CODEX_AGENT = "4c15b1af-f6ce-4f7c-b779-c9d5f9f4bfe5"
KIMI_AGENT = "47d2c58a-5482-48c4-894e-d06465e26298"
MIMO_AGENT = "f0a0042d-7205-4fcf-b829-a140827799f8"

LOG_DIR = Path("/Users/z/Documents/Codex/zhuzeyang-agent/.autonomous-loop")
LOG_DIR.mkdir(parents=True, exist_ok=True)
LOG_FILE = LOG_DIR / "loop.log"
PROGRESS_FILE = LOG_DIR / "progress.json"
ROUNDS_DIR = LOG_DIR / "rounds"
ROUNDS_DIR.mkdir(parents=True, exist_ok=True)

# 超时 (秒)
CODEX_ANALYSIS_TIMEOUT = 600   # codex gpt-5.5 分析需 6-10min
IMPL_TASK_TIMEOUT = 480        # 实施任务 8min
POLL_INTERVAL = 25             # 轮询间隔

ZZ = "/Users/z/.local/bin/zz"


# ── 日志 ──────────────────────────────────────────────────────────────────────
def log(msg: str, *, round_num: int | None = None) -> None:
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    prefix = f"[{ts}]"
    if round_num is not None:
        prefix += f"[R{round_num}]"
    line = f"{prefix} {msg}"
    print(line, flush=True)
    with open(LOG_FILE, "a") as f:
        f.write(line + "\n")


def round_log(round_num: int, msg: str) -> None:
    rf = ROUNDS_DIR / f"round-{round_num:03d}.md"
    ts = datetime.now().strftime("%H:%M:%S")
    with open(rf, "a") as f:
        f.write(f"## [{ts}] {msg}\n\n")


# ── 进度 ──────────────────────────────────────────────────────────────────────
def load_progress() -> dict:
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text())
    return {"completed_rounds": 0, "rounds": [], "started_at": datetime.now().isoformat()}


def save_progress(p: dict) -> None:
    PROGRESS_FILE.write_text(json.dumps(p, indent=2, ensure_ascii=False))


# ── CLI 封装 ──────────────────────────────────────────────────────────────────
def zz(*args, timeout: int = 60) -> tuple[int, str]:
    """Run zz CLI, return (exit_code, output)."""
    try:
        r = subprocess.run([ZZ, *args], capture_output=True, text=True, timeout=timeout)
        out = (r.stdout + r.stderr).strip()
        return r.returncode, out
    except subprocess.TimeoutExpired:
        return 124, "TIMEOUT"
    except Exception as e:
        return 1, str(e)


def create_orchestration(title: str, objective: str) -> str | None:
    rc, out = zz("orchestrations", "create", "-p", PROJECT_ID,
                 "-t", title, "-o", objective, "--no-session", timeout=30)
    m = re.search(r"Orchestration created:\s*([0-9a-f-]{36})", out)
    return m.group(1) if m else None


def dispatch_task(orch_id: str, title: str, goal: str, agent: str,
                  context: str = "", criteria: str = "") -> str | None:
    args = ["tasks", "create", "-p", PROJECT_ID, "-o", orch_id,
            "-t", title, "-g", goal, "-a", agent, "--dispatch"]
    if context:
        args += ["--context", context]
    if criteria:
        args += ["--criteria", criteria]
    rc, out = zz(*args, timeout=30)
    m = re.search(r"dispatched:\s*([0-9a-f-]{36})", out)
    return m.group(1) if m else None


def get_task(orch_id: str, task_id: str) -> dict | None:
    rc, out = zz("tasks", "get", "-p", PROJECT_ID, "-o", orch_id, task_id, timeout=30)
    if rc != 0:
        return None
    # 解析关键字段
    d = {"raw": out}
    sm = re.search(r"Status:\s*(\S+)", out)
    d["status"] = sm.group(1) if sm else "unknown"
    # result_path 可能跨行(终端折行), 先去除换行+缩进再匹配
    flat = re.sub(r"\n\s+", "", out)
    rm = re.search(r"Result File:\s*(\S+\.result\.md)", flat)
    d["result_path"] = rm.group(1) if rm else None
    return d


def wait_for_task(orch_id: str, task_id: str, timeout: int, round_num: int,
                  terminal=("approved", "changes_requested", "ready_for_review", "failed")) -> dict | None:
    """Poll task until terminal or timeout."""
    start = time.time()
    while time.time() - start < timeout:
        t = get_task(orch_id, task_id)
        if not t:
            time.sleep(POLL_INTERVAL)
            continue
        st = t["status"]
        if st in terminal:
            log(f"task {task_id[:8]} → {st} (waited {int(time.time()-start)}s)", round_num=round_num)
            return t
        time.sleep(POLL_INTERVAL)
    log(f"task {task_id[:8]} TIMEOUT after {timeout}s (status={t['status'] if t else '?'})", round_num=round_num)
    return t


def review_task(orch_id: str, task_id: str, decision: str, notes: str = "") -> bool:
    args = ["tasks", "review", "-p", PROJECT_ID, "-o", orch_id, task_id,
            "--decision", decision]
    if notes:
        args += ["--notes", notes]
    rc, out = zz(*args, timeout=30)
    return rc == 0


def read_result(orch_id: str, task_id: str) -> str:
    """Read task result content from platform workspace.

    result.md stores {"content": "..."} JSON (handler output shape).
    Returns the inner content string.
    """
    # 直接构造路径(不依赖 get_task 解析, 避免终端折行问题)
    rel = f".agent/orchestrations/{orch_id}/workers/{task_id}.result.md"
    cmd = ["sshpass", "-p", "jkjA258963", "ssh", "-o", "StrictHostKeyChecking=no",
           "-p", "10000", "18950509383@192.168.31.119",
           f"cat '/data/zz-agent-platform/project-git/{PROJECT_ID}/{rel}' 2>/dev/null"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        raw = r.stdout.strip()
    except Exception:
        return ""
    if not raw:
        return ""
    # result.md 是 {"content": "..."} JSON, 解析出 content
    try:
        j = json.loads(raw)
        return j.get("content", raw)
    except (json.JSONDecodeError, ValueError):
        return raw


# ── 分析任务 prompt ────────────────────────────────────────────────────────────
def codex_analysis_prompt(round_num: int, focus: str = "") -> str:
    focus_line = f"\n本轮特别关注: {focus}" if focus else ""
    return f"""完成项目改进分析(第{round_num}轮)。快速完成,不要调 gk(gk在后台无Accessibility权限会失败),直接用你(gpt-5.5)分析。

阅读当前工作目录 zhuzeyang-agent-platform 项目(backend/src/routes, services, entities; cli/zz_cli/main.py; README.md; docs/; deploy/),理解定位(Agent Collaboration OS)、功能、架构、已知不足。{focus_line}

从'架构师/产品经理/工程负责人'三角色,分析当前'不足/改进/新增功能'。

【关键约束】只产出**小工作量(S级,1-2小时可完成)**的改进项,不要产出需要大重构的XL项。优先:
- 文档/配置/脚本类改进(加注释、补 README、修配置)
- 单个文件的小修(加错误处理、补测试、修 typo、加类型)
- 独立的小功能(加一个 API 字段、加一个 CLI 子命令、加一个 health 检查)
- 已有功能的完善(补 validation、加日志、修 edge case)

产出 markdown 表格, 每行一个改进项:
| 编号 | 标题 | 角色 | 问题描述 | 方案(具体到改哪个文件) | 工作量(必须S) |

只列 S 级, 至少 6 项。要具体到'改哪个文件、加什么',会被直接派给 kimi/mimo 实施。"""


# ── 采纳逻辑 ──────────────────────────────────────────────────────────────────
def extract_actionable_items(analysis_md: str, max_items: int = 2) -> list[dict]:
    """从分析清单里提取可执行项, 优先 P0/P1, 适合 kimi/mimo 实现的.

    支持两种格式:
    1. markdown 表格行: | P0-1 标题 | 角色 | 问题 | 方案 | 工作量 |
    2. 标题块: ## P0 标题 \\n 问题描述...
    """
    if not analysis_md or "timed out" in analysis_md.lower() or len(analysis_md) < 100:
        return []
    items = []

    # 格式1: 解析 markdown 表格行 (codex 常用格式)
    # 匹配 | P0-1 xxx | 角色 | 问题 | 方案 | 工作量 |  或 | P0 xxx | 问题 | 方案 |
    for line in analysis_md.split("\n"):
        line = line.strip()
        if not line.startswith("|") or "---" in line:
            continue
        cells = [c.strip() for c in line.strip("|").split("|")]
        if len(cells) < 3:
            continue
        first = cells[0]
        # 第一格必须像 P0-1 / P1-3 / P0 xxx 这样的优先级标记
        pm = re.match(r"(P[012])(?:[-.]?\d*)?\s*(.*)", first)
        if not pm:
            continue
        prio = pm.group(1)
        title = pm.group(2).strip() or (cells[1][:40] if len(cells) > 1 else first)
        if not title or len(title) < 2:
            title = first
        # 方案通常在第3-4格
        desc_parts = [c for c in cells[1:] if c and c not in ("项", "角色", "问题", "方案", "工作量", "---")]
        block = f"**{first}**\n" + "\n".join(f"- {p}" for p in desc_parts[:4])
        items.append({"prio": prio, "title": title[:60], "block": block[:1200]})

    # 格式2: 若表格没解析到, 退回标题块切分
    if not items:
        blocks = re.split(r"\n(?=#{1,4}\s)", analysis_md)
        for b in blocks:
            b = b.strip()
            if len(b) < 40:
                continue
            pm = re.search(r"\b(P[012])\b", b)
            prio = pm.group(1) if pm else "P2"
            tm = re.match(r"#{1,4}\s*(.+)", b)
            title = tm.group(1).strip()[:60] if tm else b[:60]
            items.append({"prio": prio, "title": title, "block": b[:1500]})

    # 按 P0>P1>P2 排序, 取前 max_items
    order = {"P0": 0, "P1": 1, "P2": 2}
    items.sort(key=lambda x: order.get(x["prio"], 3))
    return items[:max_items]
    return items[:max_items]


def pick_impl_pair(items: list[dict]) -> tuple[dict | None, dict | None]:
    """把可执行项分配给 kimi/mimo。"""
    if not items:
        return None, None
    kimi_item = items[0]
    mimo_item = items[1] if len(items) > 1 else None
    return kimi_item, mimo_item


# ── 单轮 ──────────────────────────────────────────────────────────────────────
def run_round(round_num: int, prev_focus: str = "") -> dict:
    log(f"═══ 第 {round_num} 轮开始 ═══", round_num=round_num)
    round_log(round_num, f"第 {round_num} 轮启动")
    result = {"round": round_num, "start": datetime.now().isoformat(), "status": "running"}

    # 1. 建 orchestration
    orch = create_orchestration(
        f"自主改进轮次 {round_num}: codex分析→kimi/mimo实施→验收",
        f"第{round_num}轮: codex(gpt-5.5 high)通读项目+gk委员会分析不足, 主agent采纳后派kimi/mimo实施并验收"
    )
    if not orch:
        log("orchestration 创建失败, 跳过本轮", round_num=round_num)
        result["status"] = "orch_failed"
        return result
    result["orchestration_id"] = orch
    log(f"orchestration: {orch[:8]}", round_num=round_num)
    round_log(round_num, f"orchestration: {orch}")

    # 2. 派 codex 分析
    analysis_goal = codex_analysis_prompt(round_num, prev_focus)
    codex_task = dispatch_task(
        orch, f"R{round_num}-codex-分析",
        analysis_goal, CODEX_AGENT,
        context="gk调用: cd ~/.codex/skills/productivity/gpt-committee; ./scripts/gk-mac send-read --new --model pro --content-mode file --timeout 900 <prompt>. 失败则自行分析.",
        criteria="P0/P1/P2分级清单; 三角色视角; 每项有方案"
    )
    if not codex_task:
        log("codex 任务派发失败", round_num=round_num)
        result["status"] = "dispatch_failed"
        return result
    result["codex_task"] = codex_task
    log(f"codex 分析任务已派: {codex_task[:8]}, 等待 (最长{CODEX_ANALYSIS_TIMEOUT}s)...", round_num=round_num)

    # 3. 等 codex 完成
    t = wait_for_task(orch, codex_task, CODEX_ANALYSIS_TIMEOUT, round_num,
                      terminal=("ready_for_review", "approved", "changes_requested", "failed"))
    if not t or t["status"] not in ("ready_for_review", "approved", "changes_requested"):
        log(f"codex 分析未正常完成 (status={t['status'] if t else 'None'}), 跳过实施", round_num=round_num)
        result["status"] = "analysis_failed"
        round_log(round_num, f"分析失败: {t['status'] if t else 'None'}")
        return result

    # 4. 读分析结果 + 采纳
    analysis = read_result(orch, codex_task)
    round_log(round_num, f"## codex 分析产出\n{analysis[:3000]}\n")
    # review codex 任务
    review_task(orch, codex_task, "approved", "分析已采纳, 进入实施")
    log(f"分析产出 {len(analysis)} 字符, 采纳中...", round_num=round_num)

    items = extract_actionable_items(analysis)
    if not items:
        log("未提取到可执行项, 本轮结束(无实施)", round_num=round_num)
        result["status"] = "no_actionable_items"
        result["analysis"] = analysis[:500]
        return result
    log(f"提取到 {len(items)} 个可执行项: {[i['title'][:30] for i in items]}", round_num=round_num)
    round_log(round_num, f"可执行项: {[(i['prio'], i['title']) for i in items]}")

    # 5. 派 kimi/mimo 实施
    kimi_item, mimo_item = pick_impl_pair(items)
    impl_tasks = []
    if kimi_item:
        kt = dispatch_task(orch, f"R{round_num}-kimi-{kimi_item['title'][:30]}",
                           f"实施以下改进项:\n\n{kimi_item['block']}\n\n在工作目录真实实现: 读懂相关代码→修改/新增→自测。完成后用 markdown 总结改了什么、如何验证。",
                           KIMI_AGENT,
                           criteria="代码改动真实落地; 有验证说明")
        if kt:
            impl_tasks.append(("kimi", kt, kimi_item))
            log(f"派给 kimi: {kt[:8]} ({kimi_item['title'][:30]})", round_num=round_num)
    if mimo_item:
        mt = dispatch_task(orch, f"R{round_num}-mimo-{mimo_item['title'][:30]}",
                           f"实施以下改进项:\n\n{mimo_item['block']}\n\n在工作目录真实实现: 读懂相关代码→修改/新增→自测。完成后用 markdown 总结改了什么、如何验证。",
                           MIMO_AGENT,
                           criteria="代码改动真实落地; 有验证说明")
        if mt:
            impl_tasks.append(("mimo", mt, mimo_item))
            log(f"派给 mimo: {mt[:8]} ({mimo_item['title'][:30]})", round_num=round_num)

    # 6. 等实施完成 + 验收
    reviews = []
    for name, tid, item in impl_tasks:
        result[f"{name}_task"] = tid
        t = wait_for_task(orch, tid, IMPL_TASK_TIMEOUT, round_num,
                          terminal=("ready_for_review", "approved", "changes_requested", "failed"))
        if not t:
            reviews.append((name, "timeout"))
            continue
        impl_result = read_result(orch, tid) if t["status"] == "ready_for_review" else ""
        round_log(round_num, f"### {name} 实施产出\n{impl_result[:2000]}\n")
        # 验收: 有实质产出就 approved
        if t["status"] == "ready_for_review" and len(impl_result) > 50:
            ok = review_task(orch, tid, "approved", f"主agent验收通过: {impl_result[:200]}")
            reviews.append((name, "approved"))
            log(f"{name} 验收 approved", round_num=round_num)
        elif t["status"] in ("approved", "changes_requested"):
            reviews.append((name, t["status"]))
            log(f"{name} 状态 {t['status']}", round_num=round_num)
        else:
            reviews.append((name, f"incomplete:{t['status']}"))
            log(f"{name} 未完成 ({t['status']})", round_num=round_num)

    result["status"] = "completed"
    result["reviews"] = reviews
    result["end"] = datetime.now().isoformat()
    log(f"═══ 第 {round_num} 轮完成: {reviews} ═══", round_num=round_num)
    round_log(round_num, f"本轮完成: {reviews}")
    return result


# ── 主循环 ────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=100)
    ap.add_argument("--round", type=int, default=None, help="从第几轮开始(续跑)")
    ap.add_argument("--focus", type=str, default="", help="首轮特别关注点")
    args = ap.parse_args()

    progress = load_progress()
    start_round = args.round if args.round else progress["completed_rounds"] + 1
    log(f"=== 自主改进循环启动: 第{start_round}轮→第{args.rounds}轮 (共{args.rounds-start_round+1}轮) ===")

    focus = args.focus
    for r in range(start_round, args.rounds + 1):
        try:
            res = run_round(r, focus)
            progress["rounds"].append(res)
            progress["completed_rounds"] = r
            save_progress(progress)
            # 下一轮 focus 从本轮分析里取(简单: 不重复)
            if res.get("status") == "completed":
                focus = ""  # 让 codex 自由分析
        except KeyboardInterrupt:
            log("收到中断, 退出")
            break
        except Exception as e:
            log(f"第{r}轮异常: {e}\n{traceback.format_exc()}", round_num=r)
            progress["rounds"].append({"round": r, "status": "exception", "error": str(e)})
            progress["completed_rounds"] = r
            save_progress(progress)
            # 异常后短暂等待再继续
            time.sleep(60)

    log(f"=== 循环结束: 完成 {progress['completed_rounds']} 轮 ===")


if __name__ == "__main__":
    main()
