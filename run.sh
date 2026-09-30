#!/usr/bin/env bash
# Termux Web Desktop 运维脚本（Termux 与标准 Linux 通用）
# 用法: ./run.sh {start|stop|restart|status|enable-autostart|disable-autostart|autostart-status}
#   start   加载 auth.env，后台运行，写 server.pid，日志入 server.log
#   stop    根据 server.pid 结束进程
#   restart 先 stop 再 start
#   status  查看运行状态
#   enable-autostart  配置 Termux:Boot 开机启动项（仅 Termux）
#   disable-autostart 删除 Termux:Boot 启动项（仅 Termux）
#   autostart-status 查看 Termux:Boot 启动配置（仅 Termux）
set -u
DIR="$(cd "$(dirname "$0")" && pwd -P)"
cd "$DIR"
PID_FILE="$DIR/server.pid"
LOG_FILE="$DIR/server.log"
BOOT_DIR="$HOME/.termux/boot"
BOOT_SCRIPT="$BOOT_DIR/termux-web-desktop"
BOOT_LOG_FILE="$DIR/boot.log"

is_termux() {
    [ -n "${TERMUX_VERSION:-}" ] ||
        case "${PREFIX:-}" in
            */com.termux/*) return 0 ;;
            *) [ -d /data/data/com.termux/files/usr ] ;;
        esac
}

python_bin() {
    if [ -x "$DIR/.venv/bin/python" ]; then
        printf '%s\n' "$DIR/.venv/bin/python"
    elif command -v python3 >/dev/null 2>&1; then
        command -v python3
    else
        return 1
    fi
}

is_running() {
    [ -f "$PID_FILE" ] || return 1
    local pid; pid="$(cat "$PID_FILE" 2>/dev/null)"
    [[ "$pid" =~ ^[0-9]+$ ]] &&
        kill -0 "$pid" 2>/dev/null &&
        [ "$(readlink "/proc/$pid/cwd" 2>/dev/null)" = "$DIR" ] &&
        tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -qE '(^|[[:space:]/])server\.py([[:space:]]|$)'
}

start() {
    if is_running; then
        echo "已在运行 (PID $(cat "$PID_FILE"))"
        return 0
    fi
    if [ ! -f "$DIR/auth.env" ]; then
        echo "缺少 auth.env，请先运行: ./start.sh"
        return 1
    fi
    local python
    if ! python="$(python_bin)"; then
        echo "未找到 Python 3，请先运行: ./start.sh"
        return 1
    fi
    set -a; . "$DIR/auth.env"; set +a
    if is_termux; then
        export HOST="${HOST:-::}"
    else
        export HOST="${HOST:-0.0.0.0}"
    fi
    export PORT="${PORT:-5000}"
    # 防 CPU 休眠（若可用）
    if is_termux && command -v termux-wake-lock >/dev/null 2>&1; then
        termux-wake-lock
    fi
    nohup "$python" "$DIR/server.py" >>"$LOG_FILE" 2>&1 &
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
    local attempts=0
    while [ "$attempts" -lt 10 ]; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.3
        attempts=$((attempts + 1))
    done
    kill -9 "$pid" 2>/dev/null || true
    rm -f "$PID_FILE"
    if is_termux && command -v termux-wake-unlock >/dev/null 2>&1; then
        termux-wake-unlock
    fi
    echo "已停止"
}

status() {
    if is_running; then
        echo "运行中 (PID $(cat "$PID_FILE"))"
    else
        echo "未运行"
    fi
}

termux_boot_installed() {
    is_termux &&
    command -v pm >/dev/null 2>&1 &&
        pm list packages 2>/dev/null | grep -qx 'package:com.termux.boot'
}

require_termux() {
    if is_termux; then
        return 0
    fi
    echo "该命令仅适用于 Termux:Boot。"
    echo "标准 Linux 请使用 systemd、OpenRC 等系统服务管理器配置开机启动。"
    return 1
}

enable_autostart() {
    require_termux || return 1
    local bash_bin
    bash_bin="$(command -v bash)"
    mkdir -p "$BOOT_DIR"
    {
        printf '#!%s\n' "$bash_bin"
        echo 'sleep 10'
        printf '%q %q start >>%q 2>&1\n' "$bash_bin" "$DIR/run.sh" "$BOOT_LOG_FILE"
    } > "$BOOT_SCRIPT"
    chmod 700 "$BOOT_SCRIPT"
    echo "已配置开机启动: $BOOT_SCRIPT"

    if termux_boot_installed; then
        echo "已检测到 Termux:Boot。请确认它至少打开过一次，并关闭 Termux 的电池优化。"
    else
        echo "警告: 尚未安装 Termux:Boot，启动项暂时不会在开机时执行。"
        echo "请安装与当前 Termux 来源一致的 Termux:Boot，并至少打开一次。"
    fi
}

disable_autostart() {
    require_termux || return 1
    if [ -e "$BOOT_SCRIPT" ]; then
        rm -f "$BOOT_SCRIPT"
        echo "已关闭开机启动"
    else
        echo "开机启动未配置"
    fi
}

autostart_status() {
    require_termux || return 1
    if [ -x "$BOOT_SCRIPT" ]; then
        echo "启动项: 已配置 ($BOOT_SCRIPT)"
    else
        echo "启动项: 未配置"
    fi

    if termux_boot_installed; then
        echo "Termux:Boot: 已安装"
    else
        echo "Termux:Boot: 未安装"
    fi
}

case "${1:-}" in
    start) start ;;
    stop) stop ;;
    restart) stop; start ;;
    status) status ;;
    enable-autostart) enable_autostart ;;
    disable-autostart) disable_autostart ;;
    autostart-status) autostart_status ;;
    *) echo "用法: $0 {start|stop|restart|status|enable-autostart|disable-autostart|autostart-status}"; exit 1 ;;
esac
