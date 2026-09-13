#!/usr/bin/env python3
"""
Termux Web Desktop - 在浏览器中模拟 Ubuntu 桌面
终端命令实际在 Termux 中执行，文件管理操作真实文件系统
"""

import os
import io
import pty
import json
import hmac
import time
import uuid
import re
import glob
import shlex
import shutil
import select
import struct
import signal
import socket
import zipfile
import tarfile
import termios
import fcntl
import platform
import logging
import subprocess
import threading
from logging.handlers import RotatingFileHandler
from datetime import datetime

from flask import Flask, request, jsonify, send_file, Response, redirect, url_for, session, render_template_string
from flask_socketio import SocketIO, emit
from werkzeug.security import check_password_hash

SERVER_START_TIME = time.time()


def configure_logging():
    """将 werkzeug/socketio 日志接入带轮转的文件处理器，避免 server.log 无限增长。

    默认单文件上限 2MB，保留 3 个历史文件（可用环境变量覆盖）。
    """
    log_path = os.environ.get('LOG_FILE', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'server.log'))
    max_bytes = int(os.environ.get('LOG_MAX_BYTES', 2 * 1024 * 1024))
    backups = int(os.environ.get('LOG_BACKUP_COUNT', 3))
    handler = RotatingFileHandler(log_path, maxBytes=max_bytes, backupCount=backups, encoding='utf-8')
    handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s %(name)s: %(message)s'))
    root = logging.getLogger()
    root.setLevel(logging.INFO)
    # 避免重复添加处理器（reloader 或多次导入时）
    if not any(isinstance(h, RotatingFileHandler) and getattr(h, 'baseFilename', None) == handler.baseFilename for h in root.handlers):
        root.addHandler(handler)
    return log_path


configure_logging()

app = Flask(__name__, static_folder='static', static_url_path='')
app.secret_key = os.environ.get('SESSION_SECRET', '')
app.config.update(
    SESSION_COOKIE_NAME='termux_web_session',
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Strict',
    SESSION_COOKIE_SECURE=False,
    PERMANENT_SESSION_LIFETIME=30 * 60,
)
socketio = SocketIO(app, async_mode='threading')

WEB_USERNAME = os.environ.get('WEB_USERNAME', '')
WEB_PASSWORD_HASH = os.environ.get('WEB_PASSWORD_HASH', '')
LOGIN_FAILURES = {}
LOGIN_LOCK = threading.Lock()
MAX_LOGIN_FAILURES = 5
LOCK_SECONDS = 15 * 60

LOGIN_HTML = '''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Ubuntu Login</title><style>
*{box-sizing:border-box}html,body{height:100%;margin:0;font-family:Ubuntu,"Segoe UI","PingFang SC",sans-serif}body{display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#2c001e,#772953 55%,#dd4814);color:#fff}.panel{width:min(390px,calc(100% - 36px));padding:32px 28px;border-radius:18px;background:rgba(30,18,28,.74);backdrop-filter:blur(16px);box-shadow:0 18px 60px rgba(0,0,0,.42);text-align:center}.avatar{width:86px;height:86px;margin:0 auto 18px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:#e95420;font-size:36px;font-weight:600}.host{font-size:22px;font-weight:600}.sub{margin:6px 0 24px;color:rgba(255,255,255,.7);font-size:13px}input{width:100%;height:48px;margin:6px 0;padding:0 14px;border:1px solid rgba(255,255,255,.22);border-radius:9px;background:rgba(0,0,0,.26);color:#fff;font-size:15px;outline:none}input:focus{border-color:#e95420;box-shadow:0 0 0 2px rgba(233,84,32,.25)}button{width:100%;height:48px;margin-top:14px;border:0;border-radius:9px;background:#e95420;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.error{min-height:20px;margin-top:12px;color:#ffb4a3;font-size:13px}.note{margin-top:18px;color:rgba(255,255,255,.55);font-size:12px}</style></head>
<body><main class="panel"><div class="avatar">U</div><div class="host">Termux Ubuntu</div><div class="sub">登录 Web Desktop</div><form method="post" action="/login"><input name="username" autocomplete="username" placeholder="用户名" required autofocus><input name="password" type="password" autocomplete="current-password" placeholder="密码" required><button type="submit">登录</button></form><div class="error">{{ error or '' }}</div><div class="note">会话闲置 30 分钟后失效</div></main></body></html>'''


def client_key():
    return request.remote_addr or 'unknown'


def logged_in():
    return session.get('authenticated') is True and session.get('username') == WEB_USERNAME


@app.before_request
def enforce_login():
    public_paths = {'/login'}
    if request.path.startswith('/socket.io') or request.path in public_paths:
        return None
    if not logged_in():
        if request.path.startswith('/api/'):
            return jsonify({'error': 'unauthorized'}), 401
        return redirect(url_for('login'))
    session.permanent = True
    session.modified = True
    return None


@app.route('/login', methods=['GET', 'POST'])
def login():
    if logged_in():
        return redirect(url_for('index'))
    error = ''
    key = client_key()
    now = time.time()
    with LOGIN_LOCK:
        record = LOGIN_FAILURES.get(key, {'count': 0, 'locked_until': 0})
    if record['locked_until'] > now:
        remaining = int(record['locked_until'] - now)
        return render_template_string(LOGIN_HTML, error=f'尝试次数过多，请在 {remaining} 秒后重试'), 429
    if request.method == 'POST':
        username = request.form.get('username', '')
        password = request.form.get('password', '')
        valid = (
            WEB_USERNAME and WEB_PASSWORD_HASH
            and hmac.compare_digest(username, WEB_USERNAME)
            and check_password_hash(WEB_PASSWORD_HASH, password)
        )
        if valid:
            session.clear()
            session['authenticated'] = True
            session['username'] = WEB_USERNAME
            session.permanent = True
            with LOGIN_LOCK:
                LOGIN_FAILURES.pop(key, None)
            return redirect(url_for('index'))
        with LOGIN_LOCK:
            record['count'] += 1
            if record['count'] >= MAX_LOGIN_FAILURES:
                record = {'count': 0, 'locked_until': now + LOCK_SECONDS}
            LOGIN_FAILURES[key] = record
        error = '用户名或密码错误'
    return render_template_string(LOGIN_HTML, error=error)


@app.route('/logout', methods=['POST'])
def logout():
    session.clear()
    return redirect(url_for('login'))


@app.after_request
def set_security_headers(response):
    response.headers['Referrer-Policy'] = 'no-referrer'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['Cache-Control'] = 'no-store'
    return response

# 存储每个 WebSocket 会话的终端信息
terminals = {}
TERMINAL_LOCK = threading.Lock()


def get_shell_path():
    """获取 Termux 中的 shell 路径"""
    candidates = [
        os.environ.get('SHELL', ''),
        '/data/data/com.termux/files/usr/bin/bash',
        '/data/data/com.termux/files/usr/bin/zsh',
        '/system/bin/sh',
        '/bin/bash',
        '/bin/sh',
    ]
    for p in candidates:
        if p and os.path.exists(p):
            return p
    return '/bin/sh'


def resolve_path(path):
    """将用户输入路径解析为绝对路径，并限制在 Termux 用户家目录内。"""
    if not path:
        path = '~'
    home = os.path.realpath(os.path.expanduser('~'))
    resolved = os.path.abspath(os.path.expanduser(path))
    checked = os.path.realpath(resolved) if os.path.exists(resolved) else os.path.realpath(os.path.dirname(resolved))
    try:
        if os.path.commonpath([home, checked]) != home:
            raise ValueError('仅允许访问 Termux 用户目录')
    except ValueError:
        raise ValueError('仅允许访问 Termux 用户目录')
    return resolved


TRASH_DIR = os.path.join(os.path.expanduser('~'), '.local', 'share', 'termux-web-desktop-trash')
TRASH_META_DIR = os.path.join(TRASH_DIR, 'info')
TRASH_FILES_DIR = os.path.join(TRASH_DIR, 'files')


def ensure_trash_dirs():
    os.makedirs(TRASH_META_DIR, exist_ok=True)
    os.makedirs(TRASH_FILES_DIR, exist_ok=True)


def unique_destination(directory, name):
    """为恢复/上传生成不覆盖现有项目的目标路径。"""
    candidate = os.path.join(directory, name)
    if not os.path.lexists(candidate):
        return candidate
    stem, ext = os.path.splitext(name)
    index = 1
    while True:
        candidate = os.path.join(directory, f'{stem} ({index}){ext}')
        if not os.path.lexists(candidate):
            return candidate
        index += 1


@app.errorhandler(ValueError)
def handle_invalid_path(error):
    return jsonify({'error': str(error)}), 403


# ============================================================
#  终端 PTY 处理
# ============================================================

@socketio.on('connect')
def handle_connect(auth=None):
    """只有已登录的浏览器会话才能创建 PTY。"""
    if not logged_in():
        return False
    sid = request.sid
    master_fd, slave_fd = pty.openpty()

    shell = get_shell_path()
    env = os.environ.copy()
    env['TERM'] = 'xterm-256color'
    env['COLORTERM'] = 'truecolor'

    home = os.path.expanduser('~')
    proc = subprocess.Popen(
        [shell, '-l'],
        stdin=slave_fd,
        stdout=slave_fd,
        stderr=slave_fd,
        preexec_fn=os.setsid,
        env=env,
        cwd=home,
    )

    with TERMINAL_LOCK:
        terminals[sid] = {
            'master': master_fd,
            'slave': slave_fd,
            'proc': proc,
            'alive': True,
        }

    # 后台线程读取 PTY 输出并转发给前端
    def reader():
        while True:
            with TERMINAL_LOCK:
                t = terminals.get(sid)
                if not t or not t['alive']:
                    break
                fd = t['master']
            try:
                r, _, _ = select.select([fd], [], [], 0.2)
                if r:
                    data = os.read(fd, 8192)
                    if data:
                        socketio.emit(
                            'terminal_output',
                            {'data': data.decode('utf-8', errors='replace')},
                            room=sid,
                        )
                    else:
                        break
            except (OSError, ValueError):
                break
        # 进程结束，通知前端
        socketio.emit('terminal_exit', room=sid)
        with TERMINAL_LOCK:
            if sid in terminals:
                terminals[sid]['alive'] = False

    threading.Thread(target=reader, daemon=True).start()


@socketio.on('terminal_input')
def handle_terminal_input(data):
    """前端输入 -> 写入 PTY"""
    sid = request.sid
    with TERMINAL_LOCK:
        t = terminals.get(sid)
    if not t or not t['alive']:
        return
    try:
        os.write(t['master'], data['data'].encode('utf-8'))
    except (OSError, ValueError):
        pass


@socketio.on('terminal_resize')
def handle_terminal_resize(data):
    """调整终端大小"""
    sid = request.sid
    with TERMINAL_LOCK:
        t = terminals.get(sid)
    if not t:
        return
    try:
        cols = int(data.get('cols', 80))
        rows = int(data.get('rows', 24))
        fcntl.ioctl(
            t['master'],
            termios.TIOCSWINSZ,
            struct.pack('HHHH', rows, cols, 0, 0),
        )
    except (OSError, ValueError, KeyError):
        pass


@socketio.on('disconnect')
def handle_disconnect():
    """客户端断开，清理 PTY"""
    sid = request.sid
    with TERMINAL_LOCK:
        t = terminals.pop(sid, None)
    if t:
        try:
            t['proc'].terminate()
        except Exception:
            pass
        try:
            os.close(t['master'])
        except Exception:
            pass
        try:
            os.close(t['slave'])
        except Exception:
            pass


# ============================================================
#  活动监视器 API（只读）
# ============================================================


def read_key_values(path):
    values = {}
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                if ':' not in line:
                    continue
                key, value = line.split(':', 1)
                match = re.search(r'-?\d+', value)
                if match:
                    values[key] = int(match.group(0))
    except (OSError, PermissionError):
        pass
    return values


def parse_size_to_bytes(value):
    match = re.fullmatch(r'([0-9.]+)([KMGT]?)', value.strip(), re.I)
    if not match:
        return 0
    factors = {'': 1, 'K': 1024, 'M': 1024 ** 2, 'G': 1024 ** 3, 'T': 1024 ** 4}
    return int(float(match.group(1)) * factors[match.group(2).upper()])


def collect_top_snapshot():
    """使用 Android/toybox top 读取归一化 CPU 与 Termux 可见进程。"""
    result = {'cpu_percent': None, 'tasks': {}, 'processes': [], 'available': False}
    try:
        completed = subprocess.run(
            ['top', '-b', '-n', '1', '-m', '80', '-o', 'PID,USER,%CPU,%MEM,RES,S,ARGS'],
            capture_output=True, text=True, timeout=2.5, check=False,
        )
        output = completed.stdout.replace('\r', '')
        if completed.returncode != 0 or not output.strip():
            return result
        lines = output.splitlines()
        for line in lines[:8]:
            task_match = re.search(r'Tasks:\s*(\d+) total,\s*(\d+) running,\s*(\d+) sleeping,\s*(\d+) stopped,\s*(\d+) zombie', line)
            if task_match:
                result['tasks'] = dict(zip(('total', 'running', 'sleeping', 'stopped', 'zombie'), map(int, task_match.groups())))
            cpu_match = re.search(r'(\d+(?:\.\d+)?)%cpu.*?(\d+(?:\.\d+)?)%idle', line, re.I)
            if cpu_match:
                capacity = float(cpu_match.group(1))
                idle = float(cpu_match.group(2))
                result['cpu_percent'] = round(max(0.0, min(100.0, (capacity - idle) * 100 / capacity)), 1) if capacity else None
        header_index = next((i for i, line in enumerate(lines) if re.match(r'^\s*PID\s+USER\s+%CPU', line)), -1)
        if header_index >= 0:
            for line in lines[header_index + 1:]:
                parts = line.strip().split(None, 6)
                if len(parts) < 7 or not parts[0].isdigit():
                    continue
                try:
                    result['processes'].append({
                        'pid': int(parts[0]), 'user': parts[1],
                        'cpu_percent': float(parts[2]), 'memory_percent': float(parts[3]),
                        'resident_bytes': parse_size_to_bytes(parts[4]),
                        'state': parts[5], 'command': parts[6][:400],
                    })
                except ValueError:
                    continue
        result['available'] = True
    except (OSError, subprocess.SubprocessError):
        pass
    return result


def collect_memory():
    info = read_key_values('/proc/meminfo')
    total = info.get('MemTotal', 0) * 1024
    available = info.get('MemAvailable', info.get('MemFree', 0) + info.get('Buffers', 0) + info.get('Cached', 0)) * 1024
    used = max(0, total - available)
    swap_total = info.get('SwapTotal', 0) * 1024
    swap_free = info.get('SwapFree', 0) * 1024
    return {
        'total_bytes': total, 'used_bytes': used, 'available_bytes': available,
        'percent': round(used * 100 / total, 1) if total else None,
        'swap_total_bytes': swap_total, 'swap_used_bytes': max(0, swap_total - swap_free),
    }


def collect_storage():
    home = os.path.expanduser('~')
    try:
        stats = os.statvfs(home)
        total = stats.f_blocks * stats.f_frsize
        available = stats.f_bavail * stats.f_frsize
        used = max(0, total - available)
        return {'path': home, 'total_bytes': total, 'used_bytes': used, 'available_bytes': available,
                'percent': round(used * 100 / total, 1) if total else None}
    except OSError:
        return {'path': home, 'total_bytes': 0, 'used_bytes': 0, 'available_bytes': 0, 'percent': None}


def collect_network():
    interfaces = []
    total_rx = total_tx = 0
    try:
        with open('/proc/net/dev', 'r', encoding='utf-8') as f:
            for line in f.readlines()[2:]:
                if ':' not in line:
                    continue
                name, raw = line.split(':', 1)
                fields = raw.split()
                if len(fields) < 16:
                    continue
                name = name.strip()
                rx, tx = int(fields[0]), int(fields[8])
                if name != 'lo':
                    total_rx += rx
                    total_tx += tx
                interfaces.append({'name': name, 'rx_bytes': rx, 'tx_bytes': tx})
    except (OSError, ValueError):
        pass
    return {'rx_bytes': total_rx, 'tx_bytes': total_tx, 'interfaces': interfaces}


def normalize_temperature(raw):
    value = float(raw)
    while abs(value) > 200:
        value /= 10.0
    return round(value, 1) if -40 <= value <= 150 else None


def collect_temperatures():
    sensors = []
    for zone in sorted(glob.glob('/sys/class/thermal/thermal_zone*')):
        try:
            with open(os.path.join(zone, 'type'), 'r', encoding='utf-8') as f:
                sensor_type = f.read().strip()
            with open(os.path.join(zone, 'temp'), 'r', encoding='utf-8') as f:
                value = normalize_temperature(f.read().strip())
            if value is not None:
                sensors.append({'name': sensor_type or os.path.basename(zone), 'celsius': value})
        except (OSError, ValueError):
            continue
    preferred = next((s for s in sensors if s['name'].lower() in {'msm_therm', 'soc', 'cpu-thermal', 'cpu'}), None)
    if preferred is None and sensors:
        preferred = max(sensors, key=lambda item: item['celsius'])
    return {'available': bool(sensors), 'primary': preferred, 'sensors': sensors}


def collect_battery(temperature_data):
    """Termux:API 存在时读取完整电池信息，否则只返回可验证的电池温度。"""
    battery_sensor = next((s for s in temperature_data['sensors'] if s['name'].lower() in {'battery', 'bms'} and s['celsius'] > 0), None)
    command = shutil.which('termux-battery-status')
    if command:
        try:
            completed = subprocess.run([command], capture_output=True, text=True, timeout=2.5, check=False)
            data = json.loads(completed.stdout)
            return {
                'available': True, 'percentage': data.get('percentage'), 'status': data.get('status'),
                'plugged': data.get('plugged'), 'temperature_c': data.get('temperature'),
            }
        except (OSError, subprocess.SubprocessError, ValueError, json.JSONDecodeError):
            pass
    return {
        'available': False, 'percentage': None, 'status': None, 'plugged': None,
        'temperature_c': battery_sensor['celsius'] if battery_sensor else None,
        'reason': '未安装 Termux:API，电量与充电状态不可读',
    }


@app.route('/api/system/metrics')
def api_system_metrics():
    top = collect_top_snapshot()
    temperatures = collect_temperatures()
    try:
        uptime = round(time.clock_gettime(time.CLOCK_BOOTTIME))
    except (AttributeError, OSError):
        uptime = None
    return jsonify({
        'timestamp': int(time.time() * 1000),
        'scope': 'Android 整机指标 + Termux 可见进程',
        'cpu': {'percent': top['cpu_percent'], 'cores': os.cpu_count(), 'available': top['available']},
        'memory': collect_memory(),
        'storage': collect_storage(),
        'network': collect_network(),
        'temperature': temperatures,
        'battery': collect_battery(temperatures),
        'uptime_seconds': uptime,
        'tasks': top['tasks'],
        'processes': top['processes'],
        'limits': ['Android 权限可能隐藏其他应用进程', '本应用不提供结束进程操作'],
    })


@app.route('/api/system/info')
def api_system_info():
    """轻量设备/服务信息，供设置页“关于”面板使用（区别于高频的 metrics 端点）。"""
    uname = platform.uname()
    return jsonify({
        'user': session.get('username'),
        'hostname': uname.node,
        'kernel': f'{uname.system} {uname.release}',
        'arch': uname.machine,
        'python_version': platform.python_version(),
        'cpu_cores': os.cpu_count(),
        'home': os.path.expanduser('~'),
        'server_uptime_seconds': int(time.time() - SERVER_START_TIME),
        'termux_api': shutil.which('termux-battery-status') is not None,
    })


# ============================================================
#  文件管理 API
# ============================================================

@app.route('/')
def index():
    return app.send_static_file('index.html')


DESKTOP_DIR = os.path.join(os.path.expanduser('~'), 'Desktop')


@app.route('/api/desktop')
def api_desktop():
    """返回桌面目录（~/Desktop）及其内容；目录不存在时自动创建。

    桌面被映射为真实的 ~/Desktop 目录，图标即该目录下的真实文件/文件夹。
    """
    try:
        os.makedirs(DESKTOP_DIR, exist_ok=True)
    except OSError as e:
        return jsonify({'error': f'无法创建桌面目录: {e}'}), 500
    items = []
    try:
        for name in os.listdir(DESKTOP_DIR):
            full = os.path.join(DESKTOP_DIR, name)
            try:
                st = os.stat(full)
                is_dir = os.path.isdir(full)
                items.append({
                    'name': name,
                    'path': full,
                    'is_dir': is_dir,
                    'size': 0 if is_dir else st.st_size,
                    'is_link': os.path.islink(full),
                })
            except (OSError, PermissionError):
                continue
    except PermissionError:
        return jsonify({'error': '权限不足'}), 403
    items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
    return jsonify({'path': DESKTOP_DIR, 'items': items})


@app.route('/api/files')
def api_list_files():
    """列出目录内容"""
    path = resolve_path(request.args.get('path', '~'))
    if not os.path.exists(path):
        return jsonify({'error': f'路径不存在: {path}'}), 404
    if not os.path.isdir(path):
        return jsonify({'error': '不是目录'}), 400

    items = []
    try:
        for name in os.listdir(path):
            full = os.path.join(path, name)
            try:
                st = os.stat(full)
                is_dir = os.path.isdir(full)
                items.append({
                    'name': name,
                    'path': full,
                    'is_dir': is_dir,
                    'size': 0 if is_dir else st.st_size,
                    'mtime': datetime.fromtimestamp(st.st_mtime).strftime('%Y-%m-%d %H:%M'),
                    'is_link': os.path.islink(full),
                })
            except (OSError, PermissionError):
                continue
    except PermissionError:
        return jsonify({'error': '权限不足'}), 403

    items.sort(key=lambda x: (not x['is_dir'], x['name'].lower()))
    return jsonify({'path': path, 'items': items})


@app.route('/api/file/read')
def api_read_file():
    """读取文本文件内容"""
    path = resolve_path(request.args.get('path', ''))
    if not os.path.exists(path):
        return jsonify({'error': '文件不存在'}), 404
    if not os.path.isfile(path):
        return jsonify({'error': '不是文件'}), 400
    if os.path.getsize(path) > 5 * 1024 * 1024:
        return jsonify({'error': '文件过大（>5MB），请下载查看'}), 400
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
        return jsonify({'path': path, 'content': content})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/write', methods=['POST'])
def api_write_file():
    """写入文本文件"""
    data = request.get_json() or {}
    path = resolve_path(data.get('path', ''))
    content = data.get('content', '')
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(content)
        return jsonify({'ok': True, 'path': path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/delete', methods=['POST'])
def api_delete_file():
    """将一个或多个文件/目录移入应用回收站。"""
    data = request.get_json() or {}
    raw_paths = data.get('paths') or [data.get('path', '')]
    paths = [resolve_path(path) for path in raw_paths if path]
    if not paths:
        return jsonify({'error': '没有选择要删除的项目'}), 400
    ensure_trash_dirs()
    results = []
    try:
        for path in paths:
            if not os.path.lexists(path):
                return jsonify({'error': f'路径不存在: {path}'}), 404
            real_path = os.path.realpath(path)
            trash_root = os.path.realpath(TRASH_DIR)
            if real_path == trash_root or real_path.startswith(trash_root + os.sep) or trash_root.startswith(real_path + os.sep):
                return jsonify({'error': '不能通过普通删除操作处理回收站目录'}), 400
            trash_id = uuid.uuid4().hex
            stored_name = f'{trash_id}-{os.path.basename(path.rstrip(os.sep))}'
            stored_path = os.path.join(TRASH_FILES_DIR, stored_name)
            deleted_at = datetime.now().isoformat(timespec='seconds')
            shutil.move(path, stored_path)
            meta = {
                'id': trash_id,
                'name': os.path.basename(path.rstrip(os.sep)),
                'original_path': path,
                'stored_path': stored_path,
                'is_dir': os.path.isdir(stored_path),
                'deleted_at': deleted_at,
            }
            with open(os.path.join(TRASH_META_DIR, f'{trash_id}.json'), 'w', encoding='utf-8') as f:
                json.dump(meta, f, ensure_ascii=False)
            results.append(meta)
        return jsonify({'ok': True, 'items': results})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash')
def api_list_trash():
    """列出应用回收站。"""
    ensure_trash_dirs()
    items = []
    for filename in os.listdir(TRASH_META_DIR):
        if not filename.endswith('.json'):
            continue
        try:
            with open(os.path.join(TRASH_META_DIR, filename), 'r', encoding='utf-8') as f:
                meta = json.load(f)
            if os.path.lexists(meta.get('stored_path', '')):
                items.append(meta)
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    items.sort(key=lambda item: item.get('deleted_at', ''), reverse=True)
    return jsonify({'items': items})


@app.route('/api/trash/restore', methods=['POST'])
def api_restore_trash():
    data = request.get_json() or {}
    ids = data.get('ids') or ([data.get('id')] if data.get('id') else [])
    if not ids:
        return jsonify({'error': '没有选择要恢复的项目'}), 400
    ensure_trash_dirs()
    restored = []
    try:
        for trash_id in ids:
            if not isinstance(trash_id, str) or not re.fullmatch(r'[0-9a-f]{32}', trash_id):
                return jsonify({'error': '无效的回收站项目编号'}), 400
            meta_path = os.path.join(TRASH_META_DIR, f'{trash_id}.json')
            if not os.path.isfile(meta_path):
                return jsonify({'error': f'回收站项目不存在: {trash_id}'}), 404
            with open(meta_path, 'r', encoding='utf-8') as f:
                meta = json.load(f)
            stored_path = os.path.realpath(meta.get('stored_path', ''))
            trash_files_root = os.path.realpath(TRASH_FILES_DIR)
            if os.path.commonpath([trash_files_root, stored_path]) != trash_files_root:
                return jsonify({'error': '回收站元数据无效'}), 400
            original_path = resolve_path(meta.get('original_path', ''))
            if not os.path.lexists(stored_path):
                return jsonify({'error': f'回收站文件已丢失: {meta.get("name", trash_id)}'}), 404
            os.makedirs(os.path.dirname(original_path), exist_ok=True)
            destination = unique_destination(os.path.dirname(original_path), os.path.basename(original_path))
            shutil.move(stored_path, destination)
            os.remove(meta_path)
            restored.append({'id': trash_id, 'path': destination})
        return jsonify({'ok': True, 'items': restored})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/trash/empty', methods=['POST'])
def api_empty_trash():
    """永久清空应用回收站。"""
    ensure_trash_dirs()
    try:
        for name in os.listdir(TRASH_FILES_DIR):
            path = os.path.join(TRASH_FILES_DIR, name)
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            else:
                os.remove(path)
        for name in os.listdir(TRASH_META_DIR):
            path = os.path.join(TRASH_META_DIR, name)
            if os.path.isfile(path):
                os.remove(path)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/rename', methods=['POST'])
def api_rename_file():
    """重命名/移动"""
    data = request.get_json() or {}
    src = resolve_path(data.get('src', ''))
    dst = resolve_path(data.get('dst', ''))
    if not os.path.exists(src):
        return jsonify({'error': '源路径不存在'}), 404
    try:
        os.rename(src, dst)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/mkdir', methods=['POST'])
def api_mkdir():
    """新建目录"""
    data = request.get_json() or {}
    path = resolve_path(data.get('path', ''))
    try:
        os.makedirs(path, exist_ok=True)
        return jsonify({'ok': True, 'path': path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/mkfile', methods=['POST'])
def api_mkfile():
    """新建空文件"""
    data = request.get_json() or {}
    path = resolve_path(data.get('path', ''))
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        if not os.path.exists(path):
            with open(path, 'w') as f:
                pass
        return jsonify({'ok': True, 'path': path})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/media')
def api_media_file():
    """登录后以内联、可分段的方式读取媒体文件，支持浏览器视频拖动进度。"""
    path = resolve_path(request.args.get('path', ''))
    if not os.path.exists(path) or not os.path.isfile(path):
        return jsonify({'error': '文件不存在'}), 404
    try:
        response = send_file(
            path,
            as_attachment=False,
            download_name=os.path.basename(path),
            conditional=True,
            etag=True,
            max_age=0,
        )
        response.headers['Content-Disposition'] = 'inline'
        response.headers['Accept-Ranges'] = 'bytes'
        return response
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/download')
def api_download_file():
    """下载文件"""
    path = resolve_path(request.args.get('path', ''))
    if not os.path.exists(path) or not os.path.isfile(path):
        return jsonify({'error': '文件不存在'}), 404
    return send_file(path, as_attachment=True, download_name=os.path.basename(path))


@app.route('/api/file/upload', methods=['POST'])
def api_upload_file():
    """上传一个或多个文件，不覆盖已有同名项目。"""
    dest_dir = resolve_path(request.form.get('dir', '~'))
    files = request.files.getlist('file')
    if not files:
        return jsonify({'error': '没有文件'}), 400
    saved = []
    try:
        os.makedirs(dest_dir, exist_ok=True)
        for upload in files:
            filename = os.path.basename(upload.filename or '')
            if not filename:
                continue
            save_path = unique_destination(dest_dir, filename)
            upload.save(save_path)
            saved.append(save_path)
        if not saved:
            return jsonify({'error': '文件名为空'}), 400
        return jsonify({'ok': True, 'paths': saved})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/transfer', methods=['POST'])
def api_transfer_file():
    """在目录之间安全移动或复制文件/目录；拒绝覆盖和目录自包含。"""
    data = request.get_json() or {}
    src = resolve_path(data.get('src', ''))
    dest_dir = resolve_path(data.get('dest_dir', ''))
    action = data.get('action', 'move')
    if action not in {'move', 'copy'}:
        return jsonify({'error': '不支持的操作'}), 400
    if not os.path.exists(src):
        return jsonify({'error': '源路径不存在'}), 404
    if not os.path.isdir(dest_dir):
        return jsonify({'error': '目标不是文件夹'}), 400

    src_real = os.path.realpath(src)
    dest_real = os.path.realpath(dest_dir)
    dst = os.path.join(dest_dir, os.path.basename(src.rstrip(os.sep)))
    dst_real = os.path.realpath(dst)
    if src_real == dst_real:
        return jsonify({'error': '源文件已经位于该目录'}), 409
    if os.path.isdir(src) and os.path.commonpath([src_real, dest_real]) == src_real:
        return jsonify({'error': '不能将文件夹移动或复制到自身或其子目录'}), 400
    if os.path.lexists(dst):
        return jsonify({'error': f'目标已存在同名项目: {os.path.basename(dst)}'}), 409

    try:
        if action == 'copy':
            if os.path.isdir(src):
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)
        else:
            shutil.move(src, dst)
        return jsonify({'ok': True, 'action': action, 'src': src, 'dst': dst})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/copy', methods=['POST'])
def api_copy_file():
    """复制文件/目录"""
    data = request.get_json() or {}
    src = resolve_path(data.get('src', ''))
    dst = resolve_path(data.get('dst', ''))
    if not os.path.exists(src):
        return jsonify({'error': '源路径不存在'}), 404
    try:
        if os.path.isdir(src):
            shutil.copytree(src, dst)
        else:
            shutil.copy2(src, dst)
        return jsonify({'ok': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================
#  压缩 / 解压 API（纯 Python zipfile/tarfile，无需系统 zip 工具）
# ============================================================

def _within(base, target):
    """校验 target 位于 base 目录内（防 Zip Slip 路径穿越）。"""
    base_real = os.path.realpath(base)
    target_real = os.path.realpath(target)
    return base_real == target_real or target_real.startswith(base_real + os.sep)


@app.route('/api/file/compress', methods=['POST'])
def api_compress():
    """把一个或多个文件/目录打包成 zip；输出到同一父目录，不覆盖同名文件。"""
    data = request.get_json() or {}
    raw_paths = data.get('paths') or ([data.get('path')] if data.get('path') else [])
    paths = [resolve_path(p) for p in raw_paths if p]
    if not paths:
        return jsonify({'error': '没有选择要压缩的项目'}), 400
    for p in paths:
        if not os.path.exists(p):
            return jsonify({'error': f'路径不存在: {p}'}), 404

    parent = os.path.dirname(paths[0].rstrip(os.sep))
    # 压缩包名：单个项目用其名，多个用「归档」
    if len(paths) == 1:
        base_name = os.path.basename(paths[0].rstrip(os.sep)) or 'archive'
    else:
        base_name = data.get('name') or '归档'
    archive_path = unique_destination(parent, f'{base_name}.zip')

    try:
        with zipfile.ZipFile(archive_path, 'w', zipfile.ZIP_DEFLATED) as zf:
            for src in paths:
                src = src.rstrip(os.sep)
                arc_root = os.path.basename(src)
                if os.path.isdir(src):
                    for root, _dirs, files in os.walk(src):
                        # 记录空目录
                        if not files and not _dirs:
                            arcname = os.path.join(arc_root, os.path.relpath(root, src))
                            zf.writestr(arcname.rstrip('/') + '/', '')
                        for fn in files:
                            full = os.path.join(root, fn)
                            arcname = os.path.join(arc_root, os.path.relpath(full, src))
                            zf.write(full, arcname)
                else:
                    zf.write(src, arc_root)
        return jsonify({'ok': True, 'archive': archive_path, 'name': os.path.basename(archive_path)})
    except Exception as e:
        # 失败时清理半成品
        try:
            if os.path.exists(archive_path):
                os.remove(archive_path)
        except OSError:
            pass
        return jsonify({'error': str(e)}), 500


@app.route('/api/file/extract', methods=['POST'])
def api_extract():
    """解压 zip / tar / tar.gz / tgz 到同目录下的独立文件夹；带路径穿越防护。"""
    data = request.get_json() or {}
    src = resolve_path(data.get('path', ''))
    if not os.path.isfile(src):
        return jsonify({'error': '压缩文件不存在'}), 404

    parent = os.path.dirname(src)
    lower = src.lower()
    # 目标解压目录（用压缩包主名，去掉扩展名）
    name = os.path.basename(src)
    for ext in ('.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.zip', '.tar'):
        if lower.endswith(ext):
            name = name[:-len(ext)]
            break
    dest_dir = unique_destination(parent, name or '解压')

    try:
        os.makedirs(dest_dir, exist_ok=True)
        if zipfile.is_zipfile(src):
            with zipfile.ZipFile(src) as zf:
                for member in zf.namelist():
                    target = os.path.join(dest_dir, member)
                    if not _within(dest_dir, target):
                        raise ValueError('压缩包包含非法路径，已中止')
                zf.extractall(dest_dir)
        elif tarfile.is_tarfile(src):
            with tarfile.open(src) as tf:
                for member in tf.getmembers():
                    target = os.path.join(dest_dir, member.name)
                    if not _within(dest_dir, target):
                        raise ValueError('压缩包包含非法路径，已中止')
                tf.extractall(dest_dir)
        else:
            shutil.rmtree(dest_dir, ignore_errors=True)
            return jsonify({'error': '不支持的压缩格式（仅支持 zip / tar / tar.gz / tgz）'}), 400
        return jsonify({'ok': True, 'dest': dest_dir, 'name': os.path.basename(dest_dir)})
    except Exception as e:
        shutil.rmtree(dest_dir, ignore_errors=True)
        return jsonify({'error': str(e)}), 500


# ============================================================
#  服务管理 API（白名单式，管理 Termux 常驻服务）
# ============================================================

SERVICES_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'services.json')

# 默认服务清单（首次运行时写入 services.json；用户可自行增删改）。
# self=True 的服务只读（禁止通过面板启停，避免自杀）。
DEFAULT_SERVICES = [
    {
        'id': 'web-desktop',
        'name': 'Web Desktop',
        'description': '本管理面板所在的 Web 服务',
        'port': 5000,
        'match': 'server.py',
        'start': '',
        'self': True,
    },
    {
        'id': 'dufs',
        'name': 'dufs 文件服务',
        'description': '轻量文件分享服务',
        'port': 3001,
        'match': 'dufs',
        'start': 'dufs -p 3001 --allow-all ~/share',
    },
    {
        'id': 'sshd',
        'name': 'SSH 服务',
        'description': 'Termux OpenSSH 守护进程',
        'port': 8022,
        'match': 'sshd',
        'start': 'sshd',
    },
]


def load_services():
    """读取服务白名单；缺失时用默认清单初始化 services.json。"""
    if not os.path.exists(SERVICES_CONFIG):
        try:
            with open(SERVICES_CONFIG, 'w', encoding='utf-8') as f:
                json.dump(DEFAULT_SERVICES, f, ensure_ascii=False, indent=2)
        except OSError:
            return list(DEFAULT_SERVICES)
    try:
        with open(SERVICES_CONFIG, 'r', encoding='utf-8') as f:
            data = json.load(f)
        return data if isinstance(data, list) else list(DEFAULT_SERVICES)
    except (OSError, ValueError, json.JSONDecodeError):
        return list(DEFAULT_SERVICES)


def port_listening(port):
    """判断本机某 TCP 端口是否处于监听态（IPv4/IPv6 各试一次）。"""
    if not port:
        return None
    for family, addr in ((socket.AF_INET, ('127.0.0.1', port)), (socket.AF_INET6, ('::1', port))):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.settimeout(0.3)
                if s.connect_ex(addr) == 0:
                    return True
        except OSError:
            continue
    return False


def find_service_pids(match):
    """按命令行子串匹配进程 PID（排除本进程与匹配自身的 shell）。"""
    pids = []
    if not match:
        return pids
    try:
        completed = subprocess.run(['pgrep', '-f', match], capture_output=True, text=True, timeout=2, check=False)
        for line in completed.stdout.split():
            if line.isdigit() and int(line) != os.getpid():
                pids.append(int(line))
    except (OSError, subprocess.SubprocessError):
        pass
    return pids


def service_status(svc):
    """综合端口监听与进程匹配，给出服务运行状态。"""
    pids = find_service_pids(svc.get('match'))
    listening = port_listening(svc.get('port'))
    running = bool(pids) or listening is True
    return {
        'id': svc.get('id'),
        'name': svc.get('name'),
        'description': svc.get('description', ''),
        'port': svc.get('port'),
        'self': bool(svc.get('self')),
        'can_start': bool(svc.get('start')) and not svc.get('self'),
        'running': running,
        'pids': pids,
        'listening': listening,
    }


@app.route('/api/services')
def api_services():
    """列出白名单服务及其运行状态。"""
    return jsonify({'services': [service_status(svc) for svc in load_services()]})


@app.route('/api/services/action', methods=['POST'])
def api_services_action():
    """对单个白名单服务执行 start/stop/restart。"""
    data = request.get_json() or {}
    service_id = data.get('id', '')
    action = data.get('action', '')
    if action not in {'start', 'stop', 'restart'}:
        return jsonify({'error': '不支持的操作'}), 400

    svc = next((s for s in load_services() if s.get('id') == service_id), None)
    if svc is None:
        return jsonify({'error': '未知服务（不在白名单内）'}), 404
    if svc.get('self'):
        return jsonify({'error': '不能通过面板管理本服务自身'}), 400

    # dufs 由集成配置驱动：启动前用当前 dufs.json 重新生成命令，
    # 避免 services.json 里 baked 的旧命令（旧二进制路径/旧参数）导致启动失败。
    if service_id == 'dufs' and action in {'start', 'restart'}:
        svc = dict(svc)
        svc['start'] = dufs_command_string(load_dufs_config(), dufs_binary_path() or 'dufs')

    def do_stop():
        pids = find_service_pids(svc.get('match'))
        for pid in pids:
            try:
                os.kill(pid, signal.SIGTERM)
            except OSError:
                pass
        # 等待优雅退出，必要时强杀
        for _ in range(10):
            if not find_service_pids(svc.get('match')):
                break
            time.sleep(0.3)
        for pid in find_service_pids(svc.get('match')):
            try:
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        return pids

    def do_start():
        cmd = svc.get('start')
        if not cmd:
            raise ValueError('该服务未配置启动命令')
        shell = get_shell_path()
        # 启动输出写入临时日志，便于失败时回传真实错误
        err_log = os.path.join(os.path.expanduser('~'), f'.svc-{svc.get("id", "x")}.out')
        try:
            with open(err_log, 'w', encoding='utf-8') as _f:
                _f.write('')
        except OSError:
            err_log = None
        redirect = f'>{shlex.quote(err_log)} 2>&1' if err_log else '>/dev/null 2>&1'
        # 用登录 shell 执行，确保 PATH/~ 展开与手动启动一致；脱离父进程独立运行
        subprocess.Popen(
            [shell, '-lc', f'nohup {cmd} {redirect} &'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            preexec_fn=os.setsid, cwd=os.path.expanduser('~'),
        )
        time.sleep(1.2)
        # 校验是否真的起来了：进程存在或端口监听
        status = service_status(svc)
        if not status['running']:
            detail = ''
            if err_log and os.path.isfile(err_log):
                try:
                    with open(err_log, 'r', encoding='utf-8', errors='replace') as f:
                        detail = f.read().strip()[-500:]
                except OSError:
                    pass
            raise RuntimeError(detail or '进程启动后未检测到运行（可能立即退出）')

    try:
        if action == 'stop':
            killed = do_stop()
            logging.info('service %s stopped (pids=%s)', service_id, killed)
        elif action == 'start':
            do_start()
            logging.info('service %s started', service_id)
        else:  # restart
            do_stop()
            do_start()
            logging.info('service %s restarted', service_id)
        return jsonify({'ok': True, 'status': service_status(svc)})
    except ValueError as e:
        return jsonify({'error': str(e)}), 400
    except RuntimeError as e:
        # 启动校验失败：回传真实错误，前端据此提示
        logging.warning('service %s start failed: %s', service_id, e)
        return jsonify({'error': f'启动失败：{e}', 'status': service_status(svc)}), 500
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ============================================================
#  dufs 集成 API（安装 / 可视化配置 / 命令生成）
# ============================================================

DUFS_CONFIG = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'dufs.json')
# 默认从用户 fork 仓库源码编译安装（可用环境变量覆盖，便于换镜像/分支）
DUFS_REPO = os.environ.get('DUFS_REPO', 'https://github.com/gengwenguan/dufs')
DUFS_BRANCH = os.environ.get('DUFS_BRANCH', 'main')

# dufs 可视化配置的默认结构化参数
DEFAULT_DUFS_CONFIG = {
    'serve_path': '~/share',
    'port': 3001,
    'bind': '0.0.0.0,::',        # 默认双栈：IPv4 + IPv6（否则公网 IPv6 域名访问会 CONNECTION_REFUSED）
    'permission': 'read-only',   # read-only | upload | upload-delete | full | custom
    'allow_upload': False,
    'allow_delete': False,
    'allow_search': False,
    'allow_archive': False,
    'auth': '',                  # 形如 admin:pass@/:rw
    'directory_auth': False,     # fork 特色：每目录独立 URL 密码
    'render_spa': False,
    'render_try_index': False,   # fork 特色
    'enable_cors': False,
    'tls_cert': '',
    'tls_key': '',
    'extra_args': '',
}

# 安装任务的进度状态（内存态，供前端轮询）
DUFS_INSTALL = {'running': False, 'ok': None, 'log': [], 'started_at': None, 'finished_at': None}
DUFS_INSTALL_LOCK = threading.Lock()


def dufs_binary_path():
    """返回可用的 dufs 可执行路径。

    优先 ~/.cargo/bin/dufs（本集成用 cargo 从 fork 编译安装的位置），
    再退回 PATH 与 ~/.local/bin，避免 PATH 里存在旧版 dufs 时选到错误的二进制。
    """
    cargo_bin = os.path.expanduser('~/.cargo/bin/dufs')
    if os.path.isfile(cargo_bin) and os.access(cargo_bin, os.X_OK):
        return cargo_bin
    found = shutil.which('dufs')
    if found:
        return found
    local_bin = os.path.expanduser('~/.local/bin/dufs')
    if os.path.isfile(local_bin) and os.access(local_bin, os.X_OK):
        return local_bin
    return None


def dufs_version(binary):
    try:
        completed = subprocess.run([binary, '--version'], capture_output=True, text=True, timeout=3, check=False)
        return completed.stdout.strip() or completed.stderr.strip() or None
    except (OSError, subprocess.SubprocessError):
        return None


def load_dufs_config():
    if os.path.exists(DUFS_CONFIG):
        try:
            with open(DUFS_CONFIG, 'r', encoding='utf-8') as f:
                data = json.load(f)
            merged = dict(DEFAULT_DUFS_CONFIG)
            if isinstance(data, dict):
                merged.update({k: data[k] for k in DEFAULT_DUFS_CONFIG if k in data})
            return merged
        except (OSError, ValueError, json.JSONDecodeError):
            pass
    return dict(DEFAULT_DUFS_CONFIG)


def save_dufs_config(cfg):
    with open(DUFS_CONFIG, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)


def build_dufs_command(cfg, binary='dufs'):
    """把结构化配置拼成 dufs 启动命令（列表形式，安全拼接）。

    含 ~ 的路径先展开为绝对路径——因为命令会被 shlex 加单引号，
    单引号内 shell 不会展开 ~，不展开会导致 dufs 服务错误的字面量目录。
    """
    args = [binary]
    serve_path = (cfg.get('serve_path') or '~/share').strip()
    args.append(os.path.expanduser(serve_path))
    port = int(cfg.get('port') or 3001)
    args += ['-p', str(port)]
    bind = (cfg.get('bind') or '').strip()
    if bind:
        # 支持逗号/空格分隔的多地址（如 "0.0.0.0,::" 双栈），每个地址一个 -b
        for addr in re.split(r'[,\s]+', bind):
            if addr:
                args += ['-b', addr]

    permission = cfg.get('permission') or 'read-only'
    directory_auth = bool(cfg.get('directory_auth'))
    if directory_auth:
        # 每目录密码模式：全局开放全部能力(-A)，让 admin 账号获得完全控制；
        # dufs 的 --directory-auth 会强制把匿名/dir_password 访客限制为只读，
        # 因此这里的 -A 不会削弱安全性，反而是 admin 拿到写权限的前提。
        if '-A' not in args:
            args.append('-A')
    elif permission == 'full':
        args.append('-A')
    elif permission == 'upload':
        args.append('--allow-upload')
    elif permission == 'upload-delete':
        args += ['--allow-upload', '--allow-delete']
    elif permission == 'custom':
        if cfg.get('allow_upload'):
            args.append('--allow-upload')
        if cfg.get('allow_delete'):
            args.append('--allow-delete')
        if cfg.get('allow_search'):
            args.append('--allow-search')
        if cfg.get('allow_archive'):
            args.append('--allow-archive')
    # read-only 不加任何 allow-* 参数

    if cfg.get('auth'):
        args += ['-a', str(cfg['auth']).strip()]
    if directory_auth:
        args.append('--directory-auth')
    if cfg.get('render_spa'):
        args.append('--render-spa')
    if cfg.get('render_try_index'):
        args.append('--render-try-index')
    if cfg.get('enable_cors'):
        args.append('--enable-cors')
    if cfg.get('tls_cert') and cfg.get('tls_key'):
        args += ['--tls-cert', os.path.expanduser(str(cfg['tls_cert']).strip()),
                 '--tls-key', os.path.expanduser(str(cfg['tls_key']).strip())]

    extra = (cfg.get('extra_args') or '').strip()
    if extra:
        try:
            args += shlex.split(extra)
        except ValueError:
            pass
    return args


def dufs_command_string(cfg, binary='dufs'):
    """人类可读、可直接复制的命令字符串（用于前端预览）。"""
    return ' '.join(shlex.quote(a) for a in build_dufs_command(cfg, binary))


def sync_dufs_into_services(cfg):
    """把 dufs 配置生成的启动命令写回 services.json 的 dufs 条目，复用服务管理的启停能力。"""
    binary = dufs_binary_path() or 'dufs'
    start_cmd = dufs_command_string(cfg, binary)
    services = load_services()
    entry = {
        'id': 'dufs',
        'name': 'dufs 文件服务',
        'description': '可视化配置的文件分享服务',
        'port': int(cfg.get('port') or 3001),
        'match': 'dufs',
        'start': start_cmd,
    }
    replaced = False
    for i, svc in enumerate(services):
        if svc.get('id') == 'dufs':
            services[i] = entry
            replaced = True
            break
    if not replaced:
        services.append(entry)
    with open(SERVICES_CONFIG, 'w', encoding='utf-8') as f:
        json.dump(services, f, ensure_ascii=False, indent=2)


def dufs_integration_state():
    binary = dufs_binary_path()
    cfg = load_dufs_config()
    with DUFS_INSTALL_LOCK:
        install = dict(DUFS_INSTALL)
    return {
        'installed': binary is not None,
        'binary': binary,
        'version': dufs_version(binary) if binary else None,
        'cargo_available': shutil.which('cargo') is not None,
        'repo': DUFS_REPO,
        'branch': DUFS_BRANCH,
        'config': cfg,
        'command_preview': dufs_command_string(cfg, binary or 'dufs'),
        'running': bool(find_service_pids('dufs')) or port_listening(int(cfg.get('port') or 3001)) is True,
        'install': install,
    }


@app.route('/api/integrations/dufs')
def api_dufs_get():
    """dufs 集成状态：是否安装、版本、cargo 可用性、当前配置、命令预览、安装进度。"""
    return jsonify(dufs_integration_state())


@app.route('/api/integrations/dufs/preview', methods=['POST'])
def api_dufs_preview():
    """根据前端传入的结构化配置，返回将生成的命令（不落盘），供实时预览。"""
    data = request.get_json() or {}
    cfg = dict(DEFAULT_DUFS_CONFIG)
    cfg.update({k: data[k] for k in DEFAULT_DUFS_CONFIG if k in data})
    binary = dufs_binary_path() or 'dufs'
    return jsonify({'command': dufs_command_string(cfg, binary)})


@app.route('/api/integrations/dufs/config', methods=['POST'])
def api_dufs_save():
    """保存 dufs 配置并同步到服务白名单。"""
    data = request.get_json() or {}
    cfg = dict(DEFAULT_DUFS_CONFIG)
    cfg.update({k: data[k] for k in DEFAULT_DUFS_CONFIG if k in data})
    # 端口做基本校验
    try:
        cfg['port'] = int(cfg.get('port') or 3001)
        if not (1 <= cfg['port'] <= 65535):
            raise ValueError
    except (TypeError, ValueError):
        return jsonify({'error': '端口无效'}), 400

    # auth 规则格式校验：dufs 要求形如 user:pass@/path:perm（缺少 @路径 会被 dufs 拒绝）
    auth = (cfg.get('auth') or '').strip()
    if auth and '@' not in auth:
        return jsonify({'error': "账号密码格式不正确：需形如 admin:密码@/:rw（缺少 @路径:权限）"}), 400

    # 每目录独立密码（--directory-auth）必须配置至少一个 admin 账号（dufs 强制要求）
    if cfg.get('directory_auth') and not auth:
        return jsonify({'error': "“每目录独立密码”需要先配置管理员账号，形如 admin:密码@/:rw"}), 400

    try:
        save_dufs_config(cfg)
        sync_dufs_into_services(cfg)
        return jsonify({'ok': True, 'command': dufs_command_string(cfg, dufs_binary_path() or 'dufs')})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


def _run_dufs_install():
    """后台线程：确保编译依赖齐全后，从 fork 仓库用 cargo 编译安装 dufs。

    干净的 Termux 通常没有 rust/git，这里在编译前自动 `pkg install -y` 补齐，
    保证开源用户在全新环境也能一键部署。Termux 的 rust 包已带 clang/lld/openssl 等依赖。
    """
    def log(line):
        with DUFS_INSTALL_LOCK:
            DUFS_INSTALL['log'].append(line)
            DUFS_INSTALL['log'] = DUFS_INSTALL['log'][-400:]  # 限制日志长度

    shell = get_shell_path()

    def run(cmd, desc):
        """在登录 shell 里执行一条命令并实时回传输出；返回退出码。"""
        log(f'\n=== {desc} ===')
        log(f'$ {cmd}')
        try:
            proc = subprocess.Popen(
                [shell, '-lc', cmd],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
                cwd=os.path.expanduser('~'),
            )
            for line in proc.stdout:
                log(line.rstrip('\n'))
            proc.wait()
            return proc.returncode
        except Exception as e:
            log(f'命令执行异常：{e}')
            return 1

    def finish(ok):
        with DUFS_INSTALL_LOCK:
            DUFS_INSTALL['ok'] = ok
            DUFS_INSTALL['running'] = False
            DUFS_INSTALL['finished_at'] = int(time.time())
        log('\n✅ dufs 安装成功' if ok else '\n❌ dufs 安装失败，请查看以上日志')

    try:
        # 1) 补齐编译依赖：仅安装缺失项（Termux 的 rust 包已带 clang/lld/openssl/zlib）
        missing = [pkg for pkg, binary in (('rust', 'cargo'), ('git', 'git')) if shutil.which(binary) is None]
        if missing:
            log(f'检测到缺少依赖：{", ".join(missing)}，正在自动安装…')
            if run(f'pkg install -y {" ".join(missing)}', '安装编译依赖') != 0 or shutil.which('cargo') is None:
                log('❌ 依赖安装失败。请手动执行：pkg install rust git，或检查网络/软件源。')
                return finish(False)
        else:
            log('编译依赖已就绪（cargo、git 均可用）')

        # 2) 从 fork 仓库编译安装到 ~/.cargo/bin
        cmd = f'cargo install --git {shlex.quote(DUFS_REPO)} --branch {shlex.quote(DUFS_BRANCH)} --locked --force'
        rc = run(cmd, '编译安装 dufs（首次较慢，请耐心等待）')
        finish(rc == 0 and dufs_binary_path() is not None)
    except Exception as e:
        log(f'❌ 安装异常：{e}')
        finish(False)


@app.route('/api/integrations/dufs/install', methods=['POST'])
def api_dufs_install():
    """触发后台编译安装（自动补齐 rust/git 依赖，再从 fork 仓库编译）。"""
    with DUFS_INSTALL_LOCK:
        if DUFS_INSTALL['running']:
            return jsonify({'error': '安装正在进行中'}), 409
        DUFS_INSTALL.update({'running': True, 'ok': None, 'log': [], 'started_at': int(time.time()), 'finished_at': None})
    threading.Thread(target=_run_dufs_install, daemon=True).start()
    return jsonify({'ok': True, 'started': True})


@app.route('/api/integrations/dufs/install/status')
def api_dufs_install_status():
    """轮询安装进度与日志。"""
    with DUFS_INSTALL_LOCK:
        return jsonify(dict(DUFS_INSTALL))


# ============================================================
#  启动
# ============================================================

if __name__ == '__main__':
    host = os.environ.get('HOST', '0.0.0.0')
    port = int(os.environ.get('PORT', 5000))
    print(f'\n  Termux Web Desktop 已启动')
    print(f'  本机访问: http://localhost:{port}')
    print(f'  局域网访问: http://<手机IP>:{port}')
    print(f'  按 Ctrl+C 停止\n')
    socketio.run(app, host=host, port=port, debug=False, allow_unsafe_werkzeug=True)
