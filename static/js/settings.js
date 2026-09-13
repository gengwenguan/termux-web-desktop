/**
 * 设置应用：外观（主题色 / 壁纸）、会话（当前用户 / 退出登录）、关于（设备与服务信息）。
 * 主题偏好保存在 localStorage，并在页面加载时通过 bootstrap() 应用到 :root。
 */
const SettingsApp = (function () {
    const storageKey = 'termux-web-desktop.theme.v1';

    // 预设主题色：name 用于展示，值同时写入 --accent 与 --accent-rgb
    const ACCENTS = [
        { id: 'ubuntu', name: 'Ubuntu 橙', hex: '#E95420', rgb: '233, 84, 32' },
        { id: 'blue', name: '海洋蓝', hex: '#2472c8', rgb: '36, 114, 200' },
        { id: 'green', name: '森林绿', hex: '#2f9e44', rgb: '47, 158, 68' },
        { id: 'purple', name: '葡萄紫', hex: '#7048e8', rgb: '112, 72, 232' },
        { id: 'pink', name: '樱花粉', hex: '#e64980', rgb: '230, 73, 128' },
        { id: 'teal', name: '青碧', hex: '#0ca678', rgb: '12, 166, 120' },
    ];

    // 预设壁纸：CSS background 值
    const WALLPAPERS = [
        { id: 'ubuntu', name: 'Ubuntu', css: 'linear-gradient(135deg, #2c001e 0%, #772953 50%, #dd4814 100%)' },
        { id: 'night', name: '暗夜', css: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)' },
        { id: 'sunset', name: '日落', css: 'linear-gradient(135deg, #ff5f6d, #ffc371)' },
        { id: 'aurora', name: '极光', css: 'linear-gradient(135deg, #1d2b64, #43cea2)' },
        { id: 'mono', name: '石墨', css: 'linear-gradient(135deg, #232526, #414345)' },
        { id: 'grape', name: '紫韵', css: 'linear-gradient(135deg, #41295a, #2f0743)' },
    ];

    const DEFAULT = { accent: 'ubuntu', wallpaper: 'ubuntu' };

    function load() {
        try {
            return Object.assign({}, DEFAULT, JSON.parse(localStorage.getItem(storageKey) || '{}'));
        } catch (_) {
            return Object.assign({}, DEFAULT);
        }
    }

    function save(theme) {
        try { localStorage.setItem(storageKey, JSON.stringify(theme)); } catch (_) {}
    }

    function applyTheme(theme) {
        const accent = ACCENTS.find(a => a.id === theme.accent) || ACCENTS[0];
        const wallpaper = WALLPAPERS.find(w => w.id === theme.wallpaper) || WALLPAPERS[0];
        const root = document.documentElement.style;
        root.setProperty('--accent', accent.hex);
        root.setProperty('--accent-rgb', accent.rgb);
        root.setProperty('--wallpaper', wallpaper.css);
    }

    // 页面加载即调用：保证刷新后仍保持已选主题
    function bootstrap() {
        applyTheme(load());
    }

    function create() {
        const container = document.createElement('div');
        container.className = 'settings-container';
        container.innerHTML = `
            <nav class="settings-nav">
                <button data-tab="appearance" class="active">🎨 外观</button>
                <button data-tab="session">👤 会话</button>
                <button data-tab="about">ℹ️ 关于</button>
            </nav>
            <div class="settings-body">
                <section class="settings-section active" data-section="appearance">
                    <h2>外观</h2>
                    <div class="settings-hint">主题色与壁纸即时生效，并保存在本浏览器。</div>
                    <div class="settings-group">
                        <label>主题色</label>
                        <div class="swatches"></div>
                    </div>
                    <div class="settings-group">
                        <label>桌面壁纸</label>
                        <div class="wallpapers"></div>
                    </div>
                    <div class="settings-actions">
                        <button class="settings-btn ghost" data-action="reset">恢复默认</button>
                    </div>
                </section>
                <section class="settings-section" data-section="session">
                    <h2>会话</h2>
                    <div class="settings-hint">当前登录身份与会话操作。</div>
                    <div class="settings-user">
                        <div class="avatar">U</div>
                        <div class="who"><span data-field="user">…</span><small>会话闲置 30 分钟后自动失效</small></div>
                    </div>
                    <div class="settings-actions">
                        <button class="settings-btn danger" data-action="logout">退出登录</button>
                        <button class="settings-btn ghost" data-action="reload">重新加载桌面</button>
                    </div>
                </section>
                <section class="settings-section" data-section="about">
                    <h2>关于</h2>
                    <div class="settings-hint">设备与服务运行信息。</div>
                    <dl class="settings-info" data-role="info">
                        <dt>加载中…</dt><dd></dd>
                    </dl>
                    <div class="settings-actions">
                        <button class="settings-btn ghost" data-action="refresh-info">刷新</button>
                    </div>
                </section>
            </div>`;

        const win = Desktop.createWindow('设置', 'settings', container, 720, 520);
        let theme = load();

        // ===== 导航切换 =====
        container.querySelectorAll('.settings-nav button').forEach(btn => {
            btn.addEventListener('click', () => {
                container.querySelectorAll('.settings-nav button').forEach(b => b.classList.toggle('active', b === btn));
                const tab = btn.dataset.tab;
                container.querySelectorAll('.settings-section').forEach(s => {
                    s.classList.toggle('active', s.dataset.section === tab);
                });
                if (tab === 'about') loadInfo();
            });
        });

        // ===== 外观：主题色 =====
        const swatchWrap = container.querySelector('.swatches');
        ACCENTS.forEach(accent => {
            const el = document.createElement('div');
            el.className = 'swatch' + (accent.id === theme.accent ? ' active' : '');
            el.style.background = accent.hex;
            el.title = accent.name;
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', `主题色 ${accent.name}`);
            el.addEventListener('click', () => {
                theme.accent = accent.id;
                applyTheme(theme);
                save(theme);
                swatchWrap.querySelectorAll('.swatch').forEach(s => s.classList.toggle('active', s === el));
                Desktop.showToast(`主题色：${accent.name}`);
            });
            swatchWrap.appendChild(el);
        });

        // ===== 外观：壁纸 =====
        const wallWrap = container.querySelector('.wallpapers');
        WALLPAPERS.forEach(wallpaper => {
            const el = document.createElement('div');
            el.className = 'wallpaper-thumb' + (wallpaper.id === theme.wallpaper ? ' active' : '');
            el.style.background = wallpaper.css;
            el.innerHTML = `<span>${wallpaper.name}</span>`;
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', `壁纸 ${wallpaper.name}`);
            el.addEventListener('click', () => {
                theme.wallpaper = wallpaper.id;
                applyTheme(theme);
                save(theme);
                wallWrap.querySelectorAll('.wallpaper-thumb').forEach(w => w.classList.toggle('active', w === el));
                Desktop.showToast(`壁纸：${wallpaper.name}`);
            });
            wallWrap.appendChild(el);
        });

        // ===== 外观：恢复默认 =====
        container.querySelector('[data-action="reset"]').addEventListener('click', () => {
            theme = Object.assign({}, DEFAULT);
            applyTheme(theme);
            save(theme);
            swatchWrap.querySelectorAll('.swatch').forEach((s, i) => s.classList.toggle('active', ACCENTS[i].id === theme.accent));
            wallWrap.querySelectorAll('.wallpaper-thumb').forEach((w, i) => w.classList.toggle('active', WALLPAPERS[i].id === theme.wallpaper));
            Desktop.showToast('已恢复默认外观');
        });

        // ===== 会话 =====
        container.querySelector('[data-action="logout"]').addEventListener('click', () => {
            const form = document.createElement('form');
            form.method = 'post';
            form.action = '/logout';
            document.body.appendChild(form);
            form.submit();
        });
        container.querySelector('[data-action="reload"]').addEventListener('click', () => window.location.reload());

        // ===== 关于 =====
        const infoDl = container.querySelector('[data-role="info"]');
        let infoLoaded = false;

        function row(term, value) {
            return `<dt>${term}</dt><dd>${value}</dd>`;
        }

        function formatUptime(seconds) {
            if (seconds == null) return '—';
            const d = Math.floor(seconds / 86400);
            const h = Math.floor((seconds % 86400) / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            return [d ? `${d}天` : '', h ? `${h}小时` : '', `${m}分`].filter(Boolean).join(' ');
        }

        async function loadInfo(force) {
            if (infoLoaded && !force) return;
            infoDl.innerHTML = row('加载中…', '');
            try {
                const res = await fetch('/api/system/info', { cache: 'no-store' });
                if (!res.ok) throw new Error('请求失败');
                const info = await res.json();
                infoLoaded = true;
                const userField = container.querySelector('[data-field="user"]');
                if (userField) userField.textContent = info.user || '未知用户';
                const avatar = container.querySelector('.settings-user .avatar');
                if (avatar && info.user) avatar.textContent = info.user.charAt(0).toUpperCase();
                const apiBadge = info.termux_api
                    ? '<span class="settings-badge on">已安装</span>'
                    : '<span class="settings-badge off">未安装</span>';
                infoDl.innerHTML = [
                    row('登录用户', escapeText(info.user || '—')),
                    row('主机名', escapeText(info.hostname || '—')),
                    row('内核', escapeText(info.kernel || '—')),
                    row('架构', escapeText(info.arch || '—')),
                    row('Python', escapeText(info.python_version || '—')),
                    row('CPU 核心', info.cpu_cores != null ? info.cpu_cores : '—'),
                    row('家目录', escapeText(info.home || '—')),
                    row('服务运行时长', formatUptime(info.server_uptime_seconds)),
                    row('Termux:API', apiBadge),
                ].join('');
            } catch (_) {
                infoDl.innerHTML = row('无法读取信息', '请确认已登录并重试');
            }
        }

        container.querySelector('[data-action="refresh-info"]').addEventListener('click', () => loadInfo(true));

        // 预取用户名，供“会话”页展示
        loadInfo();

        return win;
    }

    function escapeText(value) {
        const div = document.createElement('div');
        div.textContent = String(value);
        return div.innerHTML;
    }

    return { create, bootstrap, applyTheme };
})();

// 页面加载即应用已保存主题，避免刷新闪回默认色
SettingsApp.bootstrap();
