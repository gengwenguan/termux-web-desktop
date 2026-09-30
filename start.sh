#!/usr/bin/env bash
# Termux Web Desktop 首次安装 / 初始化脚本（Termux 与标准 Linux 通用）
# 作用：准备 Python 虚拟环境、安装依赖并生成登录凭据 auth.env。
set -e
DIR="$(cd "$(dirname "$0")" && pwd -P)"
cd "$DIR"
VENV_DIR="$DIR/.venv"

is_termux() {
    [ -n "${TERMUX_VERSION:-}" ] ||
        case "${PREFIX:-}" in
            */com.termux/*) return 0 ;;
            *) [ -d /data/data/com.termux/files/usr ] ;;
        esac
}

show_python_install_hint() {
    echo "未找到可用的 Python 3，请先安装后重新运行："
    if is_termux; then
        echo "    pkg install python"
    elif command -v apt-get >/dev/null 2>&1; then
        echo "    sudo apt-get update && sudo apt-get install -y python3 python3-venv"
    elif command -v dnf >/dev/null 2>&1; then
        echo "    sudo dnf install -y python3"
    elif command -v pacman >/dev/null 2>&1; then
        echo "    sudo pacman -S python"
    else
        echo "    请使用当前 Linux 发行版的包管理器安装 python3 和 venv 模块。"
    fi
}

echo "==> [1/3] 准备 Python 运行环境..."
if ! command -v python3 >/dev/null 2>&1; then
    if is_termux && command -v pkg >/dev/null 2>&1; then
        echo "    安装 Python..."
        pkg install -y python
    else
        show_python_install_hint
        exit 1
    fi
fi

if [ ! -x "$VENV_DIR/bin/python" ]; then
    echo "    创建虚拟环境: $VENV_DIR"
    if ! python3 -m venv "$VENV_DIR"; then
        echo ""
        echo "创建虚拟环境失败。"
        show_python_install_hint
        exit 1
    fi
fi

PYTHON="$VENV_DIR/bin/python"
echo "    安装 Python 库 (flask / flask-socketio)..."
"$PYTHON" -m pip install -r "$DIR/requirements.txt"

echo ""
echo "==> [2/3] 生成登录凭据 auth.env..."
if [ -f "$DIR/auth.env" ]; then
    echo "    auth.env 已存在，跳过（如需重置请先删除它）。"
else
    printf "    设置 Web 登录用户名 [默认 admin]: "
    read -r WEB_USER
    WEB_USER="${WEB_USER:-admin}"
    if [[ ! "$WEB_USER" =~ ^[A-Za-z0-9._-]+$ ]]; then
        echo "    用户名仅允许字母、数字、点、下划线和连字符。"
        exit 1
    fi
    # 循环读取非空密码
    while :; do
        printf "    设置 Web 登录密码: "
        read -r -s WEB_PASS; echo
        [ -n "$WEB_PASS" ] && break
        echo "    密码不能为空，请重试。"
    done
    HASH="$(printf '%s' "$WEB_PASS" | "$PYTHON" -c 'import sys; from werkzeug.security import generate_password_hash; print(generate_password_hash(sys.stdin.read(), method="pbkdf2:sha256:600000"))')"
    unset WEB_PASS
    SECRET="$("$PYTHON" -c 'import secrets; print(secrets.token_hex(32))')"
    {
        printf 'WEB_USERNAME=%q\n' "$WEB_USER"
        printf 'WEB_PASSWORD_HASH=%q\n' "$HASH"
        printf 'SESSION_SECRET=%q\n' "$SECRET"
    } > "$DIR/auth.env"
    chmod 600 "$DIR/auth.env"
    echo "    已生成 auth.env（含密钥，请勿提交/外发）。"
fi

echo ""
echo "==> [3/3] 完成！"
echo "    启动服务:  ./run.sh start"
echo "    查看状态:  ./run.sh status"
echo "    停止服务:  ./run.sh stop"
echo "    浏览器访问: http://<设备IP>:5000"
