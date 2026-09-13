/**
 * 服务管理应用：查看并管理 Termux 常驻服务（白名单式）。
 * 服务清单由后端 services.json 定义；本面板只做启停/重启，不做任意进程操作。
 * 默认 5 秒轮询刷新状态；窗口最小化或页面进入后台时暂停。
 */
const ServicesApp = (function () {
    const REFRESH_MS = 5000;

    function create() {
        const root = document.createElement('div');
        root.className = 'svc-container';
        root.innerHTML = `
            <div class="svc-toolbar">
                <div>
                    <div class="svc-title">服务管理</div>
                    <div class="svc-scope">白名单服务，仅可启停已声明的服务</div>
                </div>
                <div class="svc-toolbar-actions">
                    <span class="svc-live"><i></i><span>准备刷新</span></span>
                    <button class="svc-button" data-action="refresh">立即刷新</button>
                </div>
            </div>
            <div class="svc-list"><div class="svc-empty">正在读取服务状态…</div></div>
            <div class="svc-note">服务清单在设备端 <code>services.json</code> 中定义，可自行增删。本面板不管理自身以避免中断。</div>`;

        const win = Desktop.createWindow('服务管理', 'services', root, 640, 520);
        const state = { closed: false, timer: null, busy: new Set() };
        const listEl = root.querySelector('.svc-list');

        root.querySelector('[data-action="refresh"]').addEventListener('click', () => refresh(true));

        function isActive() {
            return !state.closed && !document.hidden && document.body.contains(win.el) && !win.el.classList.contains('minimized');
        }

        function updateLive(mode, text) {
            const live = root.querySelector('.svc-live');
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
            if (state.closed || (!force && !isActive())) return;
            updateLive('live', '正在刷新');
            try {
                const res = await fetch('/api/services', { cache: 'no-store' });
                if (!res.ok) throw new Error('请求失败');
                const data = await res.json();
                render(data.services || []);
                updateLive('live', '已更新 ' + new Date().toLocaleTimeString());
            } catch (_) {
                updateLive('error', '读取失败');
            } finally {
                schedule();
            }
        }

        function render(services) {
            if (!services.length) {
                listEl.innerHTML = '<div class="svc-empty">未配置任何服务</div>';
                return;
            }
            listEl.innerHTML = '';
            services.forEach(svc => listEl.appendChild(renderCard(svc)));
        }

        function renderCard(svc) {
            const card = document.createElement('div');
            card.className = 'svc-card' + (svc.running ? ' running' : '');
            const badge = svc.running
                ? '<span class="svc-badge on">运行中</span>'
                : '<span class="svc-badge off">已停止</span>';
            const selfTag = svc.self ? '<span class="svc-tag">自身</span>' : '';
            const portText = svc.port ? `:${svc.port}` : '';
            const pidText = svc.pids && svc.pids.length ? ` · PID ${svc.pids.join(', ')}` : '';

            card.innerHTML = `
                <div class="svc-card-info">
                    <div class="svc-card-head">
                        <span class="svc-name">${escapeText(svc.name || svc.id)}</span>
                        ${badge}${selfTag}
                    </div>
                    <div class="svc-card-desc">${escapeText(svc.description || '')}</div>
                    <div class="svc-card-meta">${escapeText(portText)}${escapeText(pidText)}</div>
                </div>
                <div class="svc-card-actions"></div>`;

            const actions = card.querySelector('.svc-card-actions');
            const busy = state.busy.has(svc.id);

            // dufs 提供“配置”入口，打开可视化集成配置页
            if (svc.id === 'dufs') {
                const cfgBtn = document.createElement('button');
                cfgBtn.className = 'svc-action ghost';
                cfgBtn.textContent = '配置';
                cfgBtn.addEventListener('click', () => {
                    if (typeof DufsIntegrationApp !== 'undefined') DufsIntegrationApp.create();
                    else Desktop.showToast('配置页未加载');
                });
                actions.appendChild(cfgBtn);
            }

            if (svc.self) {
                const hint = document.createElement('span');
                hint.className = 'svc-self-hint';
                hint.textContent = '只读';
                actions.appendChild(hint);
            } else {
                if (svc.running) {
                    actions.appendChild(actionBtn('重启', 'restart', svc, busy, 'ghost'));
                    actions.appendChild(actionBtn('停止', 'stop', svc, busy, 'danger'));
                } else if (svc.can_start) {
                    actions.appendChild(actionBtn('启动', 'start', svc, busy, 'primary'));
                } else {
                    const hint = document.createElement('span');
                    hint.className = 'svc-self-hint';
                    hint.textContent = '未配置启动命令';
                    actions.appendChild(hint);
                }
            }
            return card;
        }

        function actionBtn(label, action, svc, busy, variant) {
            const btn = document.createElement('button');
            btn.className = 'svc-action ' + variant;
            btn.textContent = busy ? '处理中…' : label;
            btn.disabled = busy;
            btn.addEventListener('click', () => doAction(svc, action, label));
            return btn;
        }

        async function doAction(svc, action, label) {
            // 停止/重启做二次确认，避免误触
            if (action !== 'start') {
                const ok = window.confirm(`确定要${label} “${svc.name || svc.id}” 吗？`);
                if (!ok) return;
            }
            state.busy.add(svc.id);
            refreshCardsBusy();
            try {
                const res = await fetch('/api/services/action', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ id: svc.id, action }),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '操作失败');
                Desktop.showToast(`${label}成功：${svc.name || svc.id}`);
            } catch (e) {
                Desktop.showToast(`${label}失败：${e.message}`);
            } finally {
                state.busy.delete(svc.id);
                refresh(true);
            }
        }

        function refreshCardsBusy() {
            // 立即把处理中的服务按钮置灰（不等下一次轮询）
            listEl.querySelectorAll('.svc-action').forEach(b => { b.disabled = true; });
        }

        win.el.addEventListener('desktop-window-close', () => {
            state.closed = true;
            clearTimeout(state.timer);
        }, { once: true });

        refresh(true);
        return win;
    }

    function escapeText(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    return { create };
})();
