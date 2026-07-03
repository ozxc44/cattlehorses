#!/bin/bash
# 看门狗: 检查自主循环进程是否活着, 死了就重启续跑.
set -u
cd /Users/z/Documents/Codex/zhuzeyang-agent
PY=/Library/Developer/CommandLineTools/usr/bin/python3
SCRIPT=scripts/autonomous-improvement-loop.py
PID_FILE=.autonomous-loop/loop.pid
LOG=.autonomous-loop/loop.log
MAX_ROUNDS=100

ts() { date "+%Y-%m-%d %H:%M:%S"; }

# 确保防锁屏
pgrep -f "caffeinate -dimsu" >/dev/null || nohup caffeinate -dimsu -t 28800 >/dev/null 2>&1 &

# 检查循环进程
PID=$(cat "$PID_FILE" 2>/dev/null || echo "")
ALIVE=0
if [ -n "$PID" ] && ps -p "$PID" >/dev/null 2>&1; then
  # 确认是循环脚本进程(不是别的python)
  if ps -p "$PID" -o command= | grep -q "autonomous-improvement-loop"; then
    ALIVE=1
  fi
fi

if [ "$ALIVE" -eq 1 ]; then
  exit 0
fi

# 进程死了, 重启续跑
# 从 progress 取已完成轮数
DONE=$($PY -c "import json; d=json.load(open('.autonomous-loop/progress.json')); print(d.get('completed_rounds',0))" 2>/dev/null || echo 0)
NEXT=$((DONE + 1))
if [ "$NEXT" -gt "$MAX_ROUNDS" ]; then
  echo "[$(ts)] 已完成 $DONE 轮, 达到上限, 不再重启" >> "$LOG"
  exit 0
fi
echo "[$(ts)] [WATCHDOG] 循环进程已死, 从第 $NEXT 轮重启" >> "$LOG"
nohup "$PY" "$SCRIPT" --rounds "$MAX_ROUNDS" --round "$NEXT" >> /dev/null 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"
echo "[$(ts)] [WATCHDOG] 新进程 PID=$NEW_PID, 从 R$NEXT 续跑" >> "$LOG"
