#!/data/data/com.termux/files/usr/bin/bash
# Termux Web Desktop 运维脚本：后台启动 / 停止 / 重启 / 状态
# 用法: ./run.sh {start|stop|restart|status}
#   start   加载 auth.env，后台运行，写 server.pid，日志入 server.log
#   stop    根据 server.pid 结束进程
#   restart 先 stop 再 start
#   status  查看运行状态
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"
PID_FILE="$DIR/server.pid"
LOG_FILE="$DIR/server.log"

is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null)"
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

start() {
    if is_running; then
        echo "已在运行 (PID $(cat "$PID_FILE"))"
        return 0
    fi
    if [ ! -f "$DIR/auth.env" ]; then
        echo "缺少 auth.env，请先: cp auth.env.example auth.env 并填入凭据"
        return 1
    fi
    set -a; . "$DIR/auth.env"; set +a
    export HOST="${HOST:-::}"
    export PORT="${PORT:-5000}"
    # 防 CPU 休眠（若可用）
    command -v termux-wake-lock >/dev/null 2>&1 && termux-wake-lock
    nohup python3 server.py >>"$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 1
    if is_running; then
        echo "已启动 (PID $(cat "$PID_FILE"))，端口 $PORT，日志 $LOG_FILE"
    else
        echo "启动失败，请查看日志: tail -n 40 $LOG_FILE"
        return 1
    fi
}

stop() {
    if ! is_running; then
        echo "未在运行"
        rm -f "$PID_FILE"
        return 0
    fi
    local pid; pid="$(cat "$PID_FILE")"
    kill "$pid" 2>/dev/null
    for _ in $(seq 1 10); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
    done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    command -v termux-wake-unlock >/dev/null 2>&1 && termux-wake-unlock
    echo "已停止"
}

status() {
    if is_running; then
        echo "运行中 (PID $(cat "$PID_FILE"))"
    else
        echo "未运行"
    fi
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop; start ;;
    status) status ;;
    *) echo "用法: $0 {start|stop|restart|status}"; exit 1 ;;
esac
