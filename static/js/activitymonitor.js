/**
 * 活动监视器：只读查看 Android 整机指标和 Termux 可见进程。
 * 默认 3 秒刷新；窗口最小化、关闭或页面进入后台时暂停。
 */
const ActivityMonitorApp = (function () {
    const REFRESH_MS = 3000;
    const MAX_POINTS = 40;

    function create() {
        const root = document.createElement('div');
        root.className = 'am-container';
        root.innerHTML = `
            <div class="am-toolbar">
                <div>
                    <div class="am-title">活动监视器</div>
                    <div class="am-scope">正在读取设备指标…</div>
                </div>
                <div class="am-toolbar-actions">
                    <span class="am-live"><i></i><span>准备刷新</span></span>
                    <button class="am-button" data-action="refresh">立即刷新</button>
                </div>
            </div>
            <div class="am-scroll">
                <section class="am-summary">
                    ${metricCard('cpu', 'CPU', '—', '系统采样')}
                    ${metricCard('memory', '内存', '—', '可用 —')}
                    ${metricCard('storage', '存储', '—', '可用 —')}
                    ${metricCard('temperature', '温度', '—', '设备传感器')}
                    ${metricCard('battery', '电池', '—', '状态不可用')}
                    ${metricCard('uptime', '运行时间', '—', '自设备启动')}
                </section>
                <section class="am-charts">
                    ${chartPanel('cpu', 'CPU 使用率', '%')}
                    ${chartPanel('memory', '内存使用率', '%')}
                    ${chartPanel('network', '网络速率', 'B/s')}
                </section>
                <section class="am-details">
                    <div class="am-panel am-network-panel">
                        <div class="am-panel-title">网络与任务</div>
                        <div class="am-detail-grid">
                            <div><span>接收累计</span><b data-detail="net-rx">—</b></div>
                            <div><span>发送累计</span><b data-detail="net-tx">—</b></div>
                            <div><span>可见任务</span><b data-detail="tasks">—</b></div>
                            <div><span>CPU 核心</span><b data-detail="cores">—</b></div>
                            <div><span>交换区</span><b data-detail="swap">—</b></div>
                            <div><span>传感器</span><b data-detail="sensors">—</b></div>
                        </div>
                    </div>
                    <div class="am-panel am-sensors-panel">
                        <div class="am-panel-title">温度传感器</div>
                        <div class="am-sensor-list">等待数据…</div>
                    </div>
                </section>
                <section class="am-panel am-process-panel">
                    <div class="am-process-head">
                        <div>
                            <div class="am-panel-title">Termux 可见进程</div>
                            <div class="am-note">Android 权限可能隐藏其他应用进程；首版仅查看，不提供结束进程。</div>
                        </div>
                        <input class="am-filter" type="search" placeholder="筛选 PID、用户或命令" aria-label="筛选进程">
                    </div>
                    <div class="am-table-wrap">
                        <table class="am-process-table">
                            <thead><tr>
                                <th data-sort="pid">PID</th><th data-sort="command">进程</th>
                                <th data-sort="cpu_percent">CPU</th><th data-sort="memory_percent">内存</th>
                                <th data-sort="resident_bytes">常驻内存</th><th data-sort="state">状态</th>
                            </tr></thead>
                            <tbody><tr><td colspan="6" class="am-empty">等待采样…</td></tr></tbody>
                        </table>
                    </div>
                </section>
            </div>`;

        const win = Desktop.createWindow('活动监视器', 'monitor', root, 960, 680);
        const state = {
            closed: false, fetching: false, timer: null, history: [], processes: [],
            sortKey: 'cpu_percent', sortDirection: -1, lastNetwork: null, lastNetworkTime: null,
        };

        root.querySelector('[data-action="refresh"]').addEventListener('click', () => refresh(true));
        root.querySelector('.am-filter').addEventListener('input', renderProcesses);
        root.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (state.sortKey === key) state.sortDirection *= -1;
            else { state.sortKey = key; state.sortDirection = key === 'command' || key === 'state' ? 1 : -1; }
            renderProcesses();
        }));

        function isActive() {
            return !state.closed && !document.hidden && document.body.contains(win.el) && !win.el.classList.contains('minimized');
        }

        function updateLive(mode, text) {
            const live = root.querySelector('.am-live');
            live.classList.toggle('paused', mode === 'paused');
            live.classList.toggle('error', mode === 'error');
            live.querySelector('span').textContent = text;
        }

        function schedule(delay = REFRESH_MS) {
            clearTimeout(state.timer);
            if (state.closed) return;
            state.timer = setTimeout(() => {
                if (isActive()) refresh(false);
                else { updateLive('paused', '已暂停'); schedule(REFRESH_MS); }
            }, delay);
        }

        async function refresh(force) {
            if (state.closed || state.fetching || (!force && !isActive())) return;
            state.fetching = true;
            updateLive('live', '正在刷新');
            try {
                const response = await fetch('/api/system/metrics', { cache: 'no-store' });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                applyMetrics(data);
                updateLive('live', `实时 · ${new Date(data.timestamp).toLocaleTimeString([], { hour12: false })}`);
            } catch (error) {
                updateLive('error', `刷新失败 · ${error.message}`);
            } finally {
                state.fetching = false;
                schedule();
            }
        }

        function applyMetrics(data) {
            root.querySelector('.am-scope').textContent = data.scope || '设备资源';
            const now = Number(data.timestamp) || Date.now();
            let rxRate = 0, txRate = 0;
            if (state.lastNetwork && state.lastNetworkTime && now > state.lastNetworkTime) {
                const seconds = (now - state.lastNetworkTime) / 1000;
                rxRate = Math.max(0, (data.network.rx_bytes - state.lastNetwork.rx) / seconds);
                txRate = Math.max(0, (data.network.tx_bytes - state.lastNetwork.tx) / seconds);
            }
            state.lastNetwork = { rx: data.network.rx_bytes, tx: data.network.tx_bytes };
            state.lastNetworkTime = now;
            state.history.push({
                time: now, cpu: numberOrNull(data.cpu.percent), memory: numberOrNull(data.memory.percent),
                rxRate, txRate,
            });
            if (state.history.length > MAX_POINTS) state.history.splice(0, state.history.length - MAX_POINTS);

            setCard('cpu', percent(data.cpu.percent), `${data.cpu.cores || '—'} 核心`);
            setCard('memory', percent(data.memory.percent), `可用 ${formatBytes(data.memory.available_bytes)}`);
            setCard('storage', percent(data.storage.percent), `可用 ${formatBytes(data.storage.available_bytes)}`);
            const primaryTemp = data.temperature && data.temperature.primary;
            setCard('temperature', primaryTemp ? `${primaryTemp.celsius.toFixed(1)} °C` : '不可用', primaryTemp ? primaryTemp.name : '无可读传感器');
            const battery = data.battery || {};
            const batteryValue = battery.percentage == null ? (battery.temperature_c == null ? '不可用' : `${Number(battery.temperature_c).toFixed(1)} °C`) : `${battery.percentage}%`;
            const batterySub = battery.percentage == null ? (battery.reason || '状态不可用') : [battery.status, battery.plugged].filter(Boolean).join(' · ');
            setCard('battery', batteryValue, batterySub || '状态不可用');
            setCard('uptime', formatDuration(data.uptime_seconds), '自设备启动');

            setDetail('net-rx', formatBytes(data.network.rx_bytes));
            setDetail('net-tx', formatBytes(data.network.tx_bytes));
            setDetail('tasks', data.tasks && data.tasks.total != null ? `${data.tasks.total}（运行 ${data.tasks.running || 0}）` : `${(data.processes || []).length}`);
            setDetail('cores', data.cpu.cores || '—');
            setDetail('swap', `${formatBytes(data.memory.swap_used_bytes)} / ${formatBytes(data.memory.swap_total_bytes)}`);
            setDetail('sensors', (data.temperature.sensors || []).length);

            renderSensors(data.temperature.sensors || []);
            state.processes = Array.isArray(data.processes) ? data.processes : [];
            renderProcesses();
            drawAllCharts();
        }

        function setCard(name, value, sub) {
            const card = root.querySelector(`[data-card="${name}"]`);
            if (!card) return;
            card.querySelector('strong').textContent = value;
            card.querySelector('small').textContent = sub;
        }

        function setDetail(name, value) {
            const el = root.querySelector(`[data-detail="${name}"]`);
            if (el) el.textContent = value;
        }

        function renderSensors(sensors) {
            const list = root.querySelector('.am-sensor-list');
            if (!sensors.length) { list.innerHTML = '<div class="am-empty">没有可读温度传感器</div>'; return; }
            const preferred = ['battery', 'bms', 'msm_therm', 'emmc_therm', 'pa_therm0', 'pa_therm1'];
            const sorted = sensors.slice().sort((a, b) => {
                const ai = preferred.indexOf(a.name.toLowerCase());
                const bi = preferred.indexOf(b.name.toLowerCase());
                return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi) || b.celsius - a.celsius;
            }).slice(0, 8);
            list.innerHTML = sorted.map(item => `<div><span>${escapeHtml(item.name)}</span><b>${Number(item.celsius).toFixed(1)} °C</b></div>`).join('');
        }

        function renderProcesses() {
            const filter = root.querySelector('.am-filter').value.trim().toLowerCase();
            const direction = state.sortDirection;
            const key = state.sortKey;
            const processes = state.processes.filter(p => `${p.pid} ${p.user} ${p.command}`.toLowerCase().includes(filter));
            processes.sort((a, b) => {
                const av = a[key], bv = b[key];
                if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * direction;
                return String(av || '').localeCompare(String(bv || ''), 'zh-CN') * direction;
            });
            root.querySelectorAll('th[data-sort]').forEach(th => {
                th.classList.toggle('sorted', th.dataset.sort === key);
                th.dataset.direction = th.dataset.sort === key ? (direction > 0 ? 'asc' : 'desc') : '';
            });
            const tbody = root.querySelector('.am-process-table tbody');
            tbody.innerHTML = processes.length ? processes.map(p => `<tr>
                <td>${p.pid}</td><td title="${escapeAttr(p.command)}"><span class="am-command">${escapeHtml(p.command)}</span><small>${escapeHtml(p.user)}</small></td>
                <td>${Number(p.cpu_percent).toFixed(1)}%</td><td>${Number(p.memory_percent).toFixed(1)}%</td>
                <td>${formatBytes(p.resident_bytes)}</td><td>${escapeHtml(p.state)}</td>
            </tr>`).join('') : '<tr><td colspan="6" class="am-empty">没有匹配的可见进程</td></tr>';
        }

        function drawAllCharts() {
            drawChart(root.querySelector('[data-chart="cpu"]'), [{ key: 'cpu', color: '#f6a25f' }], 100, v => `${Math.round(v)}%`);
            drawChart(root.querySelector('[data-chart="memory"]'), [{ key: 'memory', color: '#71b7ff' }], 100, v => `${Math.round(v)}%`);
            const maxRate = Math.max(1024, ...state.history.flatMap(p => [p.rxRate || 0, p.txRate || 0]));
            drawChart(root.querySelector('[data-chart="network"]'), [
                { key: 'rxRate', color: '#62d69f' }, { key: 'txRate', color: '#d897ff' },
            ], maxRate, formatRate);
        }

        function drawChart(canvas, series, maxValue, labelFormatter) {
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const ratio = window.devicePixelRatio || 1;
            canvas.width = Math.round(rect.width * ratio);
            canvas.height = Math.round(rect.height * ratio);
            const ctx = canvas.getContext('2d');
            ctx.scale(ratio, ratio);
            const width = rect.width, height = rect.height, left = 42, right = 12, top = 12, bottom = 22;
            const plotW = Math.max(1, width - left - right), plotH = Math.max(1, height - top - bottom);
            ctx.clearRect(0, 0, width, height);
            ctx.font = '11px Ubuntu, sans-serif';
            ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.fillStyle = '#8e8e8e'; ctx.lineWidth = 1;
            [0, .5, 1].forEach(f => {
                const y = top + plotH * (1 - f);
                ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(width - right, y); ctx.stroke();
                ctx.fillText(labelFormatter(maxValue * f), 4, y + 4);
            });
            if (state.history.length < 2) {
                ctx.fillStyle = '#777'; ctx.fillText('等待下一次采样…', left + 12, top + plotH / 2); return;
            }
            series.forEach(item => {
                ctx.beginPath(); ctx.strokeStyle = item.color; ctx.lineWidth = 2;
                state.history.forEach((point, index) => {
                    const x = left + plotW * index / Math.max(1, MAX_POINTS - 1);
                    const value = Math.max(0, Math.min(maxValue, Number(point[item.key]) || 0));
                    const y = top + plotH * (1 - value / maxValue);
                    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
                });
                ctx.stroke();
            });
        }

        const resizeObserver = new ResizeObserver(() => drawAllCharts());
        resizeObserver.observe(root);
        const visibilityHandler = () => {
            if (isActive()) refresh(false);
            else updateLive('paused', '已暂停');
        };
        document.addEventListener('visibilitychange', visibilityHandler);
        const classObserver = new MutationObserver(visibilityHandler);
        classObserver.observe(win.el, { attributes: true, attributeFilter: ['class'] });
        win.el.addEventListener('desktop-window-close', () => {
            state.closed = true;
            clearTimeout(state.timer);
            resizeObserver.disconnect();
            classObserver.disconnect();
            document.removeEventListener('visibilitychange', visibilityHandler);
        }, { once: true });

        refresh(true);
        return win;
    }

    function metricCard(name, title, value, sub) {
        return `<div class="am-metric" data-card="${name}"><span>${title}</span><strong>${value}</strong><small>${sub}</small></div>`;
    }

    function chartPanel(name, title, unit) {
        return `<div class="am-panel am-chart-panel"><div class="am-panel-title">${title}<span>${unit}</span></div><canvas data-chart="${name}"></canvas></div>`;
    }

    function numberOrNull(value) { return Number.isFinite(Number(value)) ? Number(value) : null; }
    function percent(value) { return value == null ? '不可用' : `${Number(value).toFixed(1)}%`; }
    function formatBytes(bytes) {
        const value = Number(bytes) || 0;
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let current = value, index = 0;
        while (Math.abs(current) >= 1024 && index < units.length - 1) { current /= 1024; index++; }
        return `${current.toFixed(index === 0 ? 0 : current >= 10 ? 1 : 2)} ${units[index]}`;
    }
    function formatRate(value) { return `${formatBytes(value)}/s`; }
    function formatDuration(seconds) {
        if (seconds == null) return '不可用';
        let value = Math.max(0, Number(seconds));
        const days = Math.floor(value / 86400); value %= 86400;
        const hours = Math.floor(value / 3600); value %= 3600;
        const minutes = Math.floor(value / 60);
        if (days) return `${days}天 ${hours}小时`;
        if (hours) return `${hours}小时 ${minutes}分`;
        return `${minutes}分钟`;
    }
    function escapeHtml(value) {
        const div = document.createElement('div'); div.textContent = String(value == null ? '' : value); return div.innerHTML;
    }
    function escapeAttr(value) { return escapeHtml(value).replace(/"/g, '&quot;'); }

    return { create };
})();
