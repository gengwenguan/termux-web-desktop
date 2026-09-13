#!/data/data/com.termux/files/usr/bin/bash
# Termux Web Desktop 首次安装 / 初始化脚本
# 作用：安装运行依赖 + 生成登录凭据(auth.env)。安装完成后用 ./run.sh start 启动。
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

echo "==> [1/3] 检查并安装依赖 (python / rust 可选)..."
if ! command -v python3 >/dev/null 2>&1; then
    echo "    安装 Python..."
    pkg install -y python
fi
echo "    安装 Python 库 (flask / flask-socketio)..."
pip install -r requirements.txt 2>/dev/null || pip install flask flask-socketio

echo ""
echo "==> [2/3] 生成登录凭据 auth.env..."
if [ -f "$DIR/auth.env" ]; then
    echo "    auth.env 已存在，跳过（如需重置请先删除它）。"
else
    printf "    设置 Web 登录用户名 [默认 admin]: "
    read -r WEB_USER
    WEB_USER="${WEB_USER:-admin}"
    # 循环读取非空密码
    while :; do
        printf "    设置 Web 登录密码: "
        read -r -s WEB_PASS; echo
        [ -n "$WEB_PASS" ] && break
        echo "    密码不能为空，请重试。"
    done
    HASH="$(python3 -c "from werkzeug.security import generate_password_hash as g; print(g('$WEB_PASS'))")"
    SECRET="$(python3 -c "import secrets; print(secrets.token_hex(32))")"
    cat > "$DIR/auth.env" <<EOF
WEB_USERNAME='$WEB_USER'
WEB_PASSWORD_HASH='$HASH'
SESSION_SECRET='$SECRET'
EOF
    chmod 600 "$DIR/auth.env"
    echo "    已生成 auth.env（含密钥，请勿提交/外发）。"
fi

echo ""
echo "==> [3/3] 完成！"
echo "    启动服务:  ./run.sh start"
echo "    查看状态:  ./run.sh status"
echo "    停止服务:  ./run.sh stop"
echo "    浏览器访问: http://<手机IP>:5000"
