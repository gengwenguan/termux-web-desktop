/**
 * dufs 集成配置页：安装（从 fork 源码 cargo 编译）+ 可视化配置（生成启动命令）。
 * 配置保存后写回服务白名单，由“服务管理”统一启停。
 */
const DufsIntegrationApp = (function () {

    const PERMISSIONS = [
        { id: 'read-only', label: '🔒 只读分享', desc: '仅浏览、预览、下载' },
        { id: 'upload', label: '⬆️ 允许上传', desc: '可上传文件/文件夹' },
        { id: 'upload-delete', label: '🗑 上传 + 删除', desc: '可上传并删除' },
        { id: 'full', label: '🔓 完全控制', desc: '上传/删除/搜索/改名等全部允许 (-A)' },
        { id: 'custom', label: '⚙️ 自定义', desc: '逐项勾选权限' },
    ];

    const PRESETS = [
        { id: 'lan-readonly', name: '局域网只读', patch: { permission: 'read-only', bind: '0.0.0.0', auth: '', directory_auth: false } },
        { id: 'upload-pass', name: '带密码可上传', patch: { permission: 'upload', auth: 'admin:admin@/:rw' } },
        { id: 'dir-auth', name: '每目录独立密码', patch: { permission: 'read-only', directory_auth: true, auth: 'admin:admin@/:rw' } },
        { id: 'full-lan', name: '完全控制(内网)', patch: { permission: 'full', bind: '0.0.0.0' } },
    ];

    function create() {
        const root = document.createElement('div');
        root.className = 'dufs-container';
        root.innerHTML = `
            <div class="dufs-toolbar">
                <div>
                    <div class="dufs-title">dufs 文件服务 · 集成配置</div>
                    <div class="dufs-scope" data-role="scope">正在检测…</div>
                </div>
                <button class="dufs-button" data-action="refresh">刷新</button>
            </div>
            <div class="dufs-body">
                <section class="dufs-install" data-role="install-section"></section>
                <section class="dufs-config" data-role="config-section" hidden></section>
            </div>`;

        const win = Desktop.createWindow('dufs 配置', 'dufs', root, 760, 640);
        const state = { closed: false, installTimer: null, cfg: null, meta: null };
        const scopeEl = root.querySelector('[data-role="scope"]');
        const installSection = root.querySelector('[data-role="install-section"]');
        const configSection = root.querySelector('[data-role="config-section"]');

        root.querySelector('[data-action="refresh"]').addEventListener('click', load);

        win.el.addEventListener('desktop-window-close', () => {
            state.closed = true;
            clearTimeout(state.installTimer);
        }, { once: true });

        async function load() {
            scopeEl.textContent = '正在检测…';
            try {
                const res = await fetch('/api/integrations/dufs', { cache: 'no-store' });
                if (!res.ok) throw new Error('读取失败');
                const meta = await res.json();
                state.meta = meta;
                state.cfg = meta.config;
                renderInstall(meta);
                renderConfig(meta);
            } catch (e) {
                scopeEl.textContent = '检测失败：' + e.message;
            }
        }

        // ===== 安装区 =====
        function renderInstall(meta) {
            if (meta.installed) {
                scopeEl.textContent = `已安装 · ${meta.version || 'dufs'}`;
                installSection.innerHTML = `
                    <div class="dufs-card ok">
                        <div>
                            <div class="dufs-card-title">✅ dufs 已安装</div>
                            <div class="dufs-card-sub">${escapeText(meta.version || '')} · ${escapeText(meta.binary || '')}</div>
                        </div>
                        <button class="dufs-btn ghost" data-action="reinstall">重新编译安装</button>
                    </div>`;
                installSection.querySelector('[data-action="reinstall"]').addEventListener('click', startInstall);
                configSection.hidden = false;
            } else {
                scopeEl.textContent = '未安装';
                const depNote = meta.cargo_available
                    ? '<div class="dufs-install-note">编译依赖已就绪。</div>'
                    : '<div class="dufs-install-note">检测到未安装 Rust，点击后将自动执行 <code>pkg install rust git</code> 补齐依赖再编译（无需手动操作）。</div>';
                installSection.innerHTML = `
                    <div class="dufs-card">
                        <div>
                            <div class="dufs-card-title">dufs 未安装</div>
                            <div class="dufs-card-sub">将从 <code>${escapeText(meta.repo)}</code>（分支 ${escapeText(meta.branch)}）源码编译安装</div>
                        </div>
                        <button class="dufs-btn primary" data-action="install">一键编译安装</button>
                    </div>
                    ${depNote}
                    <div class="dufs-install-note">⚠️ 手机上源码编译较慢（可能十几分钟），期间可关闭本窗口，安装在后台继续。</div>
                    <pre class="dufs-log" data-role="install-log" hidden></pre>`;
                const btn = installSection.querySelector('[data-action="install"]');
                if (btn) btn.addEventListener('click', startInstall);
                configSection.hidden = true;
                // 若后台正在安装，恢复进度视图
                if (meta.install && meta.install.running) { showInstallLog(meta.install); pollInstall(); }
            }
        }

        async function startInstall() {
            try {
                const res = await fetch('/api/integrations/dufs/install', { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '启动安装失败');
                Desktop.showToast('已开始编译安装 dufs');
                pollInstall();
            } catch (e) {
                Desktop.showToast(e.message);
            }
        }

        function showInstallLog(install) {
            let log = installSection.querySelector('[data-role="install-log"]');
            if (!log) {
                log = document.createElement('pre');
                log.className = 'dufs-log';
                log.setAttribute('data-role', 'install-log');
                installSection.appendChild(log);
            }
            log.hidden = false;
            log.textContent = (install.log || []).join('\n');
            log.scrollTop = log.scrollHeight;
        }

        async function pollInstall() {
            clearTimeout(state.installTimer);
            if (state.closed) return;
            try {
                const res = await fetch('/api/integrations/dufs/install/status', { cache: 'no-store' });
                const install = await res.json();
                showInstallLog(install);
                if (install.running) {
                    state.installTimer = setTimeout(pollInstall, 1500);
                } else {
                    Desktop.showToast(install.ok ? 'dufs 安装成功' : 'dufs 安装失败，请查看日志');
                    load();
                }
            } catch (_) {
                state.installTimer = setTimeout(pollInstall, 2500);
            }
        }

        // ===== 可视化配置 =====
        function renderConfig(meta) {
            const cfg = meta.config;
            configSection.innerHTML = `
                <h3 class="dufs-h3">预设方案</h3>
                <div class="dufs-presets"></div>

                <h3 class="dufs-h3">基础</h3>
                <div class="dufs-form">
                    <label>共享目录<input type="text" data-cfg="serve_path" placeholder="~/share"></label>
                    <label>端口<input type="number" data-cfg="port" min="1" max="65535"></label>
                    <label>绑定地址<input type="text" data-cfg="bind" placeholder="0.0.0.0,::（双栈）"></label>
                </div>

                <h3 class="dufs-h3">权限模式</h3>
                <div class="dufs-perms"></div>
                <div class="dufs-custom-perms" hidden>
                    <label class="dufs-check"><input type="checkbox" data-cfg="allow_upload"> 允许上传</label>
                    <label class="dufs-check"><input type="checkbox" data-cfg="allow_delete"> 允许删除</label>
                    <label class="dufs-check"><input type="checkbox" data-cfg="allow_search"> 允许搜索</label>
                    <label class="dufs-check"><input type="checkbox" data-cfg="allow_archive"> 允许打包下载</label>
                </div>

                <h3 class="dufs-h3">访问控制</h3>
                <div class="dufs-form">
                    <label class="dufs-wide">全局账号密码
                        <input type="text" data-cfg="auth" placeholder="admin:pass@/:rw（留空为公开）">
                        <small class="dufs-hint">格式：<code>用户名:密码@/路径:权限</code> · 权限 <code>rw</code>=读写、<code>ro</code>=只读<br>
                        例：<code>admin:123456@/:rw</code>（admin 对根目录可读写）· 多账号用逗号分隔</small>
                    </label>
                </div>
                <label class="dufs-check"><input type="checkbox" data-cfg="directory_auth"> 每个目录独立 URL 密码（--directory-auth）：访客凭 dir_password 只读浏览，管理员账号登录后可完全读写</label>

                <h3 class="dufs-h3">高级</h3>
                <label class="dufs-check"><input type="checkbox" data-cfg="render_spa"> SPA 模式 (--render-spa)</label>
                <label class="dufs-check"><input type="checkbox" data-cfg="render_try_index"> 优先 index.html，缺失则列目录 (--render-try-index)</label>
                <label class="dufs-check"><input type="checkbox" data-cfg="enable_cors"> 启用 CORS</label>
                <div class="dufs-form">
                    <label>TLS 证书<input type="text" data-cfg="tls_cert" placeholder="可选，启用 HTTPS"></label>
                    <label>TLS 私钥<input type="text" data-cfg="tls_key" placeholder="可选"></label>
                    <label class="dufs-wide">额外参数<input type="text" data-cfg="extra_args" placeholder="原样附加到命令末尾"></label>
                </div>

                <h3 class="dufs-h3">生成的启动命令</h3>
                <pre class="dufs-preview" data-role="preview">${escapeText(meta.command_preview || '')}</pre>

                <div class="dufs-actions">
                    <button class="dufs-btn primary" data-action="save">保存配置</button>
                    <button class="dufs-btn" data-action="save-start">保存并启动</button>
                    <span class="dufs-run-state">${meta.running ? '当前：运行中' : '当前：已停止'}</span>
                </div>
                <pre class="dufs-error" data-role="error" hidden></pre>`;

            // 预设
            const presetWrap = configSection.querySelector('.dufs-presets');
            PRESETS.forEach(p => {
                const b = document.createElement('button');
                b.className = 'dufs-preset';
                b.textContent = p.name;
                b.addEventListener('click', () => { applyPatch(p.patch); Desktop.showToast('已套用预设：' + p.name); });
                presetWrap.appendChild(b);
            });

            // 权限单选
            const permWrap = configSection.querySelector('.dufs-perms');
            PERMISSIONS.forEach(p => {
                const el = document.createElement('button');
                el.className = 'dufs-perm' + (cfg.permission === p.id ? ' active' : '');
                el.dataset.perm = p.id;
                el.innerHTML = `<span class="dufs-perm-label">${p.label}</span><span class="dufs-perm-desc">${p.desc}</span>`;
                el.addEventListener('click', () => {
                    cfg.permission = p.id;
                    permWrap.querySelectorAll('.dufs-perm').forEach(x => x.classList.toggle('active', x === el));
                    configSection.querySelector('.dufs-custom-perms').hidden = (p.id !== 'custom');
                    schedulePreview();
                });
                permWrap.appendChild(el);
            });
            configSection.querySelector('.dufs-custom-perms').hidden = (cfg.permission !== 'custom');

            // 绑定表单初值 + 监听
            configSection.querySelectorAll('[data-cfg]').forEach(input => {
                const key = input.dataset.cfg;
                if (input.type === 'checkbox') input.checked = !!cfg[key];
                else input.value = cfg[key] != null ? cfg[key] : '';
                input.addEventListener('input', () => {
                    cfg[key] = input.type === 'checkbox' ? input.checked : input.value;
                    schedulePreview();
                });
            });

            configSection.querySelector('[data-action="save"]').addEventListener('click', () => save(false));
            configSection.querySelector('[data-action="save-start"]').addEventListener('click', () => save(true));
        }

        function applyPatch(patch) {
            Object.assign(state.cfg, patch);
            renderConfig(state.meta);      // 重渲染以反映预设
            schedulePreview();
        }

        let previewTimer = null;
        function schedulePreview() {
            clearTimeout(previewTimer);
            previewTimer = setTimeout(updatePreview, 250);
        }

        async function updatePreview() {
            try {
                const res = await fetch('/api/integrations/dufs/preview', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state.cfg),
                });
                const data = await res.json();
                const pre = configSection.querySelector('[data-role="preview"]');
                if (pre && data.command) pre.textContent = data.command;
            } catch (_) {}
        }

        async function save(alsoStart) {
            const errEl = configSection.querySelector('[data-role="error"]');
            if (errEl) { errEl.hidden = true; errEl.textContent = ''; }
            try {
                const res = await fetch('/api/integrations/dufs/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(state.cfg),
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || '保存失败');
                Desktop.showToast('配置已保存');
                if (alsoStart) {
                    const r2 = await fetch('/api/services/action', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ id: 'dufs', action: 'restart' }),
                    });
                    const d2 = await r2.json();
                    if (!r2.ok) throw new Error(d2.error || '启动失败');
                    Desktop.showToast('dufs 已启动/重启');
                }
                load();
            } catch (e) {
                Desktop.showToast('操作失败');
                if (errEl) { errEl.hidden = false; errEl.textContent = e.message; }
            }
        }

        load();
        return win;
    }

    function escapeText(value) {
        const div = document.createElement('div');
        div.textContent = String(value == null ? '' : value);
        return div.innerHTML;
    }

    return { create };
})();
