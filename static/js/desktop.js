/**
 * Termux Web Desktop 桌面与窗口管理
 * Ubuntu/GNOME 风格交互：单击选择、双击打开、框选、多选、成组拖动、右键菜单、键盘操作。
 */
const Desktop = (function () {
    let zIndex = 100;
    const windows = {};
    let winIdCounter = 0;
    const selectedIcons = new Set();
    let selectionAnchor = null;
    const iconStorageKey = 'termux-web-desktop.icon-layout.v3';
    const dragThreshold = 7;

    function getDesktop() { return document.getElementById('desktop'); }
    function getIconArea() { return document.querySelector('.desktop-icons'); }
    function getIcons() { return Array.from(document.querySelectorAll('.desktop-icon')); }

    function init() {
        initDesktopIcons();
        initDesktopSurface();
        initDock();
        initKeyboard();
        initActivities();
        initSystemMenu();
        loadDesktopFiles();

        window.addEventListener('resize', () => {
            clampAllIcons();
            saveIconLayout();
        });

        document.addEventListener('pointerdown', (e) => {
            if (!e.target.closest('.context-menu')) closeContextMenu();
        });
    }

    // ===== 桌面图标 =====
    function initDesktopIcons() {
        const saved = loadIconLayout();
        getIcons().forEach((el, index) => {
            el.style.position = 'absolute';
            el.tabIndex = 0;
            el.setAttribute('role', 'button');
            el.setAttribute('aria-label', `${el.textContent.trim()}，双击打开`);

            const position = saved[getIconKey(el)];
            el.style.left = `${position ? position.left : 0}px`;
            el.style.top = `${position ? position.top : index * 84}px`;
            makeDesktopIconInteractive(el);
            el.dataset.interactive = 'true';
        });
        requestAnimationFrame(clampAllIcons);
    }

    function makeDesktopIconInteractive(el) {
        let pointerId = null;
        let startX = 0;
        let startY = 0;
        let moved = false;
        let origins = [];

        el.style.touchAction = 'none';

        el.addEventListener('pointerdown', (e) => {
            if (e.button !== undefined && e.button !== 0) return;
            closeContextMenu();

            const additive = e.ctrlKey || e.metaKey;
            if (e.shiftKey && selectionAnchor) {
                selectIconRange(selectionAnchor, el, additive);
            } else if (additive) {
                toggleIconSelection(el);
                if (selectedIcons.has(el)) selectionAnchor = el;
            } else if (!selectedIcons.has(el)) {
                selectOnly(el);
            }

            // Ctrl/Command 取消选择后，不开始拖动。
            if (!selectedIcons.has(el)) return;

            pointerId = e.pointerId;
            startX = e.clientX;
            startY = e.clientY;
            moved = false;
            origins = Array.from(selectedIcons).map(icon => ({
                icon,
                left: parseFloat(icon.style.left) || 0,
                top: parseFloat(icon.style.top) || 0,
            }));
            el.setPointerCapture(pointerId);
            e.preventDefault();
        });

        el.addEventListener('pointermove', (e) => {
            if (pointerId !== e.pointerId) return;
            let dx = e.clientX - startX;
            let dy = e.clientY - startY;
            if (!moved && Math.hypot(dx, dy) < dragThreshold) return;
            moved = true;

            const area = getIconArea();
            const minLeft = Math.min(...origins.map(x => x.left));
            const minTop = Math.min(...origins.map(x => x.top));
            const maxRight = Math.max(...origins.map(x => x.left + x.icon.offsetWidth));
            const maxBottom = Math.max(...origins.map(x => x.top + x.icon.offsetHeight));
            dx = Math.max(-minLeft, Math.min(area.clientWidth - maxRight, dx));
            dy = Math.max(-minTop, Math.min(area.clientHeight - maxBottom, dy));

            origins.forEach(({ icon, left, top }) => {
                icon.style.left = `${left + dx}px`;
                icon.style.top = `${top + dy}px`;
                icon.classList.add('dragging');
            });
            // 高亮拖动目标文件夹（拖入提示）
            highlightFolderUnder(e.clientX, e.clientY);
        });

        function finishPointer(e) {
            if (pointerId !== e.pointerId) return;
            try { el.releasePointerCapture(pointerId); } catch (_) {}
            pointerId = null;
            const dragged = origins.map(o => o.icon);
            dragged.forEach(icon => icon.classList.remove('dragging'));
            clearFolderHighlight();
            if (!moved) return;
            // 命中某个文件夹图标 → 把拖动的文件移入该文件夹
            const folder = folderIconUnder(e.clientX, e.clientY, dragged);
            const movable = dragged.filter(icon => icon.dataset.path && icon !== folder);
            if (folder && movable.length) {
                moveIconsIntoFolder(movable, folder);
                return;
            }
            // 否则：吸附到最近空格子，避免重叠
            placeIconsWithoutOverlap(dragged);
        }

        el.addEventListener('pointerup', finishPointer);
        el.addEventListener('pointercancel', (e) => {
            if (pointerId !== e.pointerId) return;
            pointerId = null;
            origins.forEach(({ icon }) => icon.classList.remove('dragging'));
        });

        el.addEventListener('click', (e) => {
            // 单击只选中，不打开。
            e.stopPropagation();
        });

        el.addEventListener('dblclick', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openDesktopIcon(el);
        });

        el.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!selectedIcons.has(el)) selectOnly(el);
            showIconContextMenu(e.clientX, e.clientY);
        });
    }

    function setIconSelected(el, selected) {
        el.classList.toggle('selected', selected);
        el.setAttribute('aria-selected', selected ? 'true' : 'false');
        if (selected) selectedIcons.add(el);
        else selectedIcons.delete(el);
    }

    function selectOnly(el) {
        clearIconSelection(false);
        setIconSelected(el, true);
        selectionAnchor = el;
        el.focus({ preventScroll: true });
    }

    function selectIconRange(from, to, preserveExisting) {
        const icons = getIcons();
        const start = icons.indexOf(from);
        const end = icons.indexOf(to);
        if (start < 0 || end < 0) { selectOnly(to); return; }
        if (!preserveExisting) clearIconSelection(false);
        const low = Math.min(start, end);
        const high = Math.max(start, end);
        icons.slice(low, high + 1).forEach(icon => setIconSelected(icon, true));
        to.focus({ preventScroll: true });
    }

    function toggleIconSelection(el) {
        setIconSelected(el, !selectedIcons.has(el));
        if (selectedIcons.has(el)) el.focus({ preventScroll: true });
    }

    function clearIconSelection(resetAnchor = true) {
        Array.from(selectedIcons).forEach(el => setIconSelected(el, false));
        if (resetAnchor) selectionAnchor = null;
    }

    function selectAllIcons() {
        getIcons().forEach(el => setIconSelected(el, true));
        if (getIcons()[0]) getIcons()[0].focus({ preventScroll: true });
    }

    function openSelectedIcons() {
        const icons = selectedIcons.size ? Array.from(selectedIcons) : [];
        icons.forEach(openDesktopIcon);
    }

    function openDesktopIcon(icon) {
        if (icon.dataset.app) {
            openApp(icon.dataset.app);
            return;
        }
        if (icon.dataset.path) {
            openFilePath(icon.dataset.path, icon.dataset.isdir === 'true');
        }
    }

    function openFilePath(path, isDir) {
        if (isDir) FileManagerApp.create(path);
        else {
            const slash = path.lastIndexOf('/');
            const parent = slash > 0 ? path.slice(0, slash) : '~';
            FileManagerApp.create(parent, path);
        }
    }

    function getIconKey(icon) {
        return icon.dataset.app ? `app:${icon.dataset.app}` : `file:${icon.dataset.path || ''}`;
    }

    function fileIcon(name, isDir) {
        if (isDir) return '📁';
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (['png','jpg','jpeg','gif','svg','webp'].includes(ext)) return '🖼️';
        if (['mp4','mkv','avi','mov','webm'].includes(ext)) return '🎬';
        if (['mp3','wav','flac','ogg','m4a'].includes(ext)) return '🎵';
        if (['zip','tar','gz','rar','7z','bz2','xz'].includes(ext)) return '📦';
        if (ext === 'pdf') return '📕';
        if (['js','ts','py','sh','json','yaml','yml','html','css'].includes(ext)) return '📜';
        return '📄';
    }

    // ===== 真实桌面目录（~/Desktop）=====
    // 桌面图标 = ~/Desktop 目录下的真实文件/文件夹；内置 app 图标固定保留。
    function loadDesktopFiles() {
        return fetch('/api/desktop', { cache: 'no-store' })
            .then(r => r.ok ? r.json() : Promise.reject(new Error('读取桌面目录失败')))
            .then(data => {
                renderDesktopFiles(data.items || []);
            })
            .catch(() => { /* 静默失败，仅显示内置 app 图标 */ });
    }

    function renderDesktopFiles(items) {
        const area = getIconArea();
        if (!area) return;
        // 移除旧的文件图标（保留内置 app 图标），再按最新目录内容重建
        getIcons().filter(icon => icon.dataset.path).forEach(icon => {
            selectedIcons.delete(icon);
            icon.remove();
        });
        const layout = loadIconLayout();
        const created = [];
        items.forEach(item => {
            const icon = createDesktopFileElement(item);
            if (!icon) return;
            icon.style.position = 'absolute';
            icon.tabIndex = 0;
            icon.setAttribute('role', 'button');
            icon.setAttribute('aria-label', `${icon.dataset.name}，双击打开`);
            makeDesktopIconInteractive(icon);
            icon.dataset.interactive = 'true';
            created.push(icon);
        });
        // 第一遍：有保存布局且格子未被占用的，放到原位
        const occupied = occupiedCells(created);  // 已被 app 图标/已定位图标占用的格子
        const pending = [];
        created.forEach(icon => {
            const saved = layout[getIconKey(icon)];
            if (saved) {
                const col = Math.round(saved.left / GRID_X);
                const row = Math.round(saved.top / GRID_Y);
                if (!occupied.has(cellKey(col, row))) {
                    icon.style.left = `${saved.left}px`;
                    icon.style.top = `${saved.top}px`;
                    occupied.add(cellKey(col, row));
                    clampIcon(icon);
                    return;
                }
            }
            pending.push(icon);  // 无布局或冲突 → 稍后找空位
        });
        // 第二遍：其余图标依次填入最近的空格子，互不重叠
        pending.forEach(icon => {
            const cell = findFreeCell(0, 0, occupied);
            icon.style.left = `${cell.col * GRID_X}px`;
            icon.style.top = `${cell.row * GRID_Y}px`;
            occupied.add(cellKey(cell.col, cell.row));
            clampIcon(icon);
        });
        if (pending.length) saveIconLayout();
    }

    function createDesktopFileElement(item) {
        const area = getIconArea();
        if (!area || !item || !item.path) return null;
        const icon = document.createElement('div');
        icon.className = 'desktop-icon file-item';
        icon.dataset.path = item.path;
        icon.dataset.name = item.name || item.path.split('/').pop() || item.path;
        icon.dataset.isdir = String(!!item.is_dir);
        icon.title = item.path;
        icon.innerHTML = `<div class="di-icon shortcut-icon">${fileIcon(icon.dataset.name, !!item.is_dir)}</div><span>${escapeHtml(icon.dataset.name)}</span>`;
        area.appendChild(icon);
        return icon;
    }

    // 在 ~/Desktop 下新建文件/文件夹（真实操作），成功后刷新桌面
    function createDesktopEntry(kind) {
        const isDir = kind === 'dir';
        const title = isDir ? '新建文件夹' : '新建文件';
        const defaultName = isDir ? '新建文件夹' : '新建文件.txt';
        prompt(`${title}名称:`, defaultName, (name) => {
            const endpoint = isDir ? '/api/file/mkdir' : '/api/file/mkfile';
            fetch('/api/desktop', { cache: 'no-store' })
                .then(r => r.json())
                .then(data => {
                    const target = (data.path || '~/Desktop') + '/' + name;
                    return fetch(endpoint, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ path: target }),
                    });
                })
                .then(r => r.json())
                .then(res => {
                    if (res.error) throw new Error(res.error);
                    showToast(`已创建 “${name}”`);
                    loadDesktopFiles();
                })
                .catch(e => showToast('创建失败：' + e.message));
        });
    }

    // 删除选中的桌面文件（移入回收站，真实操作），成功后刷新桌面
    function deleteSelectedDesktopFiles() {
        const files = Array.from(selectedIcons).filter(icon => icon.dataset.path);
        if (!files.length) { showToast('内置应用图标不能删除'); return; }
        const paths = files.map(icon => icon.dataset.path);
        const label = files.length > 1 ? `${files.length} 个项目` : `“${files[0].dataset.name}”`;
        if (!window.confirm(`确定要删除${label}吗？将移入回收站。`)) return;
        fetch('/api/file/delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths }),
        })
            .then(r => r.json())
            .then(res => {
                if (res.error) throw new Error(res.error);
                showToast(`已删除${label}（可在回收站恢复）`);
                loadDesktopFiles();
            })
            .catch(e => showToast('删除失败：' + e.message));
    }

    // 把文件管理器拖来的真实文件移动/复制进 ~/Desktop（默认移动）
    function transferItemsToDesktop(items, action = 'move') {
        const verb = action === 'copy' ? '复制' : '移动';
        fetch('/api/desktop', { cache: 'no-store' })
            .then(r => r.json())
            .then(data => {
                const dest = data.path;
                if (!dest) throw new Error('无法定位桌面目录');
                const tasks = items.filter(it => it && it.path).map(it =>
                    fetch('/api/file/transfer', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ src: it.path, dest_dir: dest, action }),
                    }).then(r => r.json())
                );
                return Promise.all(tasks);
            })
            .then(results => {
                const failed = results.filter(r => r && r.error);
                if (failed.length) showToast(`部分${verb}失败：${failed[0].error}`);
                else showToast(items.length > 1 ? `已${verb} ${items.length} 项到桌面` : `已${verb}到桌面`);
                loadDesktopFiles();
            })
            .catch(e => showToast(`${verb}到桌面失败：` + e.message));
    }

    // 供文件管理器调用：把选中的真实文件复制到桌面（菜单“复制到桌面”用）
    function copyToDesktop(items) {
        const list = Array.isArray(items) ? items : [items];
        transferItemsToDesktop(list.filter(Boolean), 'copy');
    }

    // 压缩选中的桌面文件为 zip，成功后刷新桌面
    function compressSelected() {
        const files = Array.from(selectedIcons).filter(icon => icon.dataset.path);
        if (!files.length) return;
        const paths = files.map(icon => icon.dataset.path);
        showToast('正在压缩…');
        fetch('/api/file/compress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths }),
        })
            .then(r => r.json())
            .then(res => {
                if (res.error) throw new Error(res.error);
                showToast(`已生成 ${res.name}`);
                loadDesktopFiles();
            })
            .catch(e => showToast('压缩失败：' + e.message));
    }

    // 解压选中的压缩文件到同目录，成功后刷新桌面
    function extractSelected() {
        const icon = Array.from(selectedIcons).find(i => i.dataset.path && isArchive(i.dataset.name));
        if (!icon) return;
        showToast('正在解压…');
        fetch('/api/file/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: icon.dataset.path }),
        })
            .then(r => r.json())
            .then(res => {
                if (res.error) throw new Error(res.error);
                showToast(`已解压到 ${res.name}`);
                loadDesktopFiles();
            })
            .catch(e => showToast('解压失败：' + e.message));
    }

    // 判断是否为受支持的压缩包
    function isArchive(name) {
        const lower = (name || '').toLowerCase();
        return ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tar.xz'].some(ext => lower.endsWith(ext));
    }

    // ===== 桌面空白区域、框选、右键 =====
    function initDesktopSurface() {
        const area = getIconArea();
        let pointerId = null;
        let startX = 0;
        let startY = 0;
        let baseline = new Set();
        let marquee = null;
        let moved = false;

        area.addEventListener('pointerdown', (e) => {
            if (e.target !== area || (e.button !== undefined && e.button !== 0)) return;
            closeContextMenu();
            pointerId = e.pointerId;
            const rect = area.getBoundingClientRect();
            startX = e.clientX - rect.left;
            startY = e.clientY - rect.top;
            baseline = (e.ctrlKey || e.metaKey) ? new Set(selectedIcons) : new Set();
            if (!e.ctrlKey && !e.metaKey) clearIconSelection();
            moved = false;
            area.setPointerCapture(pointerId);
            e.preventDefault();
        });

        area.addEventListener('pointermove', (e) => {
            if (pointerId !== e.pointerId) return;
            const rect = area.getBoundingClientRect();
            const currentX = Math.max(0, Math.min(area.clientWidth, e.clientX - rect.left));
            const currentY = Math.max(0, Math.min(area.clientHeight, e.clientY - rect.top));
            if (!moved && Math.hypot(currentX - startX, currentY - startY) < 4) return;
            moved = true;
            if (!marquee) {
                marquee = document.createElement('div');
                marquee.className = 'selection-marquee';
                area.appendChild(marquee);
            }
            const box = {
                left: Math.min(startX, currentX),
                top: Math.min(startY, currentY),
                right: Math.max(startX, currentX),
                bottom: Math.max(startY, currentY),
            };
            marquee.style.left = `${box.left}px`;
            marquee.style.top = `${box.top}px`;
            marquee.style.width = `${box.right - box.left}px`;
            marquee.style.height = `${box.bottom - box.top}px`;

            getIcons().forEach(icon => {
                const iconBox = {
                    left: icon.offsetLeft,
                    top: icon.offsetTop,
                    right: icon.offsetLeft + icon.offsetWidth,
                    bottom: icon.offsetTop + icon.offsetHeight,
                };
                const intersects = !(iconBox.right < box.left || iconBox.left > box.right || iconBox.bottom < box.top || iconBox.top > box.bottom);
                setIconSelected(icon, baseline.has(icon) || intersects);
            });
        });

        function finishMarquee(e) {
            if (pointerId !== e.pointerId) return;
            try { area.releasePointerCapture(pointerId); } catch (_) {}
            pointerId = null;
            if (marquee) marquee.remove();
            marquee = null;
        }

        area.addEventListener('pointerup', finishMarquee);
        area.addEventListener('pointercancel', finishMarquee);

        area.addEventListener('dragover', (e) => {
            if (!e.dataTransfer.types.includes('application/x-termux-file')) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
            area.classList.add('drop-target');
        });
        area.addEventListener('dragleave', (e) => {
            if (!area.contains(e.relatedTarget)) area.classList.remove('drop-target');
        });
        area.addEventListener('drop', (e) => {
            const raw = e.dataTransfer.getData('application/x-termux-file');
            if (!raw) return;
            e.preventDefault();
            area.classList.remove('drop-target');
            try {
                const payload = JSON.parse(raw);
                const items = payload.items || (payload.path ? [payload] : []);
                if (!items.length) return;
                // 拖到桌面：默认移动到 ~/Desktop，按住 Ctrl/Cmd 则复制
                transferItemsToDesktop(items, (e.ctrlKey || e.metaKey) ? 'copy' : 'move');
            } catch (_) { showToast('无法移动到桌面'); }
        });

        area.addEventListener('contextmenu', (e) => {
            if (e.target !== area) return;
            e.preventDefault();
            showDesktopContextMenu(e.clientX, e.clientY);
        });

        getDesktop().addEventListener('contextmenu', (e) => {
            if (e.target !== getDesktop()) return;
            e.preventDefault();
            showDesktopContextMenu(e.clientX, e.clientY);
        });
    }

    function showDesktopContextMenu(x, y) {
        showContextMenu(x, y, [
            { label: '新建文件夹', action: () => createDesktopEntry('dir') },
            { label: '新建文件', action: () => createDesktopEntry('file') },
            { label: '新建终端', action: () => openApp('terminal') },
            { separator: true },
            { label: '全选', action: selectAllIcons },
            { label: '自动排列图标', action: autoArrangeIcons },
            { label: '恢复默认布局', action: resetIconLayout },
            { separator: true },
            { label: '刷新桌面', action: () => loadDesktopFiles() },
        ]);
    }

    function showIconContextMenu(x, y) {
        const count = selectedIcons.size;
        const selected = Array.from(selectedIcons);
        const selectedFile = selected.length === 1 && selected[0].dataset.path ? selected[0] : null;
        const hasFile = selected.some(icon => icon.dataset.path);
        const archiveFile = selectedFile && isArchive(selectedFile.dataset.name) ? selectedFile : null;
        showContextMenu(x, y, [
            { label: count > 1 ? `打开所选项目（${count}）` : '打开', action: openSelectedIcons },
            ...(selectedFile ? [
                { label: '显示所在文件夹', action: () => {
                    const path = selectedFile.dataset.path;
                    const parent = selectedFile.dataset.isdir === 'true' ? path : (path.slice(0, path.lastIndexOf('/')) || '~');
                    FileManagerApp.create(parent);
                }},
                { label: '复制路径', action: () => copyText(selectedFile.dataset.path) },
            ] : []),
            ...(hasFile ? [
                { separator: true },
                { label: count > 1 ? `压缩为 zip（${count} 项）` : '压缩为 zip', action: compressSelected },
                ...(archiveFile ? [
                    { label: '解压到此处', action: extractSelected },
                ] : []),
            ] : []),
            { separator: true },
            { label: '对齐到网格', action: () => snapIconsToGrid(Array.from(selectedIcons)) },
            { label: '自动排列全部图标', action: autoArrangeIcons },
            ...(hasFile ? [
                { separator: true },
                { label: count > 1 ? `删除所选项目（${count}）` : '删除', action: deleteSelectedDesktopFiles, danger: true },
            ] : []),
            { separator: true },
            { label: count > 1 ? `取消选择（${count}）` : '取消选择', action: clearIconSelection },
        ]);
    }

    // ===== 图标布局 =====
    function loadIconLayout() {
        try { return JSON.parse(localStorage.getItem(iconStorageKey) || '{}'); }
        catch (_) { return {}; }
    }

    function saveIconLayout() {
        const layout = {};
        getIcons().forEach(icon => {
            layout[getIconKey(icon)] = {
                left: Math.round(parseFloat(icon.style.left) || 0),
                top: Math.round(parseFloat(icon.style.top) || 0),
            };
        });
        try { localStorage.setItem(iconStorageKey, JSON.stringify(layout)); } catch (_) {}
    }

    function clampIcon(icon) {
        const area = getIconArea();
        const left = Math.max(0, Math.min(area.clientWidth - icon.offsetWidth, parseFloat(icon.style.left) || 0));
        const top = Math.max(0, Math.min(area.clientHeight - icon.offsetHeight, parseFloat(icon.style.top) || 0));
        icon.style.left = `${left}px`;
        icon.style.top = `${top}px`;
    }

    function clampAllIcons() { getIcons().forEach(clampIcon); }

    function autoArrangeIcons() {
        const area = getIconArea();
        const rowHeight = 84;
        const colWidth = 88;
        const rows = Math.max(1, Math.floor(area.clientHeight / rowHeight));
        getIcons().forEach((icon, index) => {
            icon.style.left = `${Math.floor(index / rows) * colWidth}px`;
            icon.style.top = `${(index % rows) * rowHeight}px`;
        });
        saveIconLayout();
    }

    function resetIconLayout() {
        try { localStorage.removeItem(iconStorageKey); } catch (_) {}
        autoArrangeIcons();
        clearIconSelection();
    }

    function snapIconsToGrid(icons) {
        const gridX = 88;
        const gridY = 84;
        icons.forEach(icon => {
            icon.style.left = `${Math.round((parseFloat(icon.style.left) || 0) / gridX) * gridX}px`;
            icon.style.top = `${Math.round((parseFloat(icon.style.top) || 0) / gridY) * gridY}px`;
            clampIcon(icon);
        });
        saveIconLayout();
    }

    // ===== 网格占位（避免图标重叠）=====
    const GRID_X = 88;
    const GRID_Y = 84;

    function cellKey(col, row) { return `${col},${row}`; }

    // 收集当前被占用的网格格子（可排除某些正在移动的图标）
    function occupiedCells(exclude = []) {
        const set = new Set();
        getIcons().forEach(icon => {
            if (exclude.includes(icon)) return;
            const col = Math.round((parseFloat(icon.style.left) || 0) / GRID_X);
            const row = Math.round((parseFloat(icon.style.top) || 0) / GRID_Y);
            set.add(cellKey(col, row));
        });
        return set;
    }

    // 从期望像素位置出发，找最近的空网格格子（螺旋式外扩搜索）
    function findFreeCell(preferLeft, preferTop, occupied) {
        const area = getIconArea();
        const maxCols = Math.max(1, Math.floor(area.clientWidth / GRID_X));
        const maxRows = Math.max(1, Math.floor(area.clientHeight / GRID_Y));
        const startCol = Math.max(0, Math.min(maxCols - 1, Math.round(preferLeft / GRID_X)));
        const startRow = Math.max(0, Math.min(maxRows - 1, Math.round(preferTop / GRID_Y)));
        if (!occupied.has(cellKey(startCol, startRow))) return { col: startCol, row: startRow };
        // 以起点为中心，按曼哈顿距离逐圈搜索空位
        for (let radius = 1; radius <= maxCols + maxRows; radius++) {
            for (let dc = -radius; dc <= radius; dc++) {
                for (let dr = -radius; dr <= radius; dr++) {
                    if (Math.abs(dc) + Math.abs(dr) !== radius) continue;
                    const col = startCol + dc;
                    const row = startRow + dr;
                    if (col < 0 || row < 0 || col >= maxCols || row >= maxRows) continue;
                    if (!occupied.has(cellKey(col, row))) return { col, row };
                }
            }
        }
        return { col: startCol, row: startRow }; // 兜底：格子满了就允许重叠
    }

    // 把一组图标依次吸附到最近的空格子，彼此不重叠
    function placeIconsWithoutOverlap(icons) {
        const occupied = occupiedCells(icons);
        icons.forEach(icon => {
            const cell = findFreeCell(parseFloat(icon.style.left) || 0, parseFloat(icon.style.top) || 0, occupied);
            icon.style.left = `${cell.col * GRID_X}px`;
            icon.style.top = `${cell.row * GRID_Y}px`;
            occupied.add(cellKey(cell.col, cell.row));
            clampIcon(icon);
        });
        saveIconLayout();
    }

    // ===== 拖到文件夹（移动）=====
    // 找到坐标下方的“文件夹”桌面图标（排除正在拖动的图标）
    function folderIconUnder(clientX, clientY, exclude = []) {
        return getIcons().find(icon => {
            if (exclude.includes(icon)) return false;
            if (icon.dataset.isdir !== 'true') return false;
            const r = icon.getBoundingClientRect();
            return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
        }) || null;
    }

    function highlightFolderUnder(clientX, clientY) {
        clearFolderHighlight();
        const folder = folderIconUnder(clientX, clientY, Array.from(document.querySelectorAll('.desktop-icon.dragging')));
        if (folder) folder.classList.add('folder-drop-target');
    }

    function clearFolderHighlight() {
        document.querySelectorAll('.folder-drop-target').forEach(el => el.classList.remove('folder-drop-target'));
    }

    // 把桌面文件图标移动进目标文件夹（真实 move），成功后刷新
    function moveIconsIntoFolder(icons, folder) {
        const destDir = folder.dataset.path;
        const names = icons.map(i => i.dataset.name);
        const tasks = icons.map(icon => fetch('/api/file/transfer', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ src: icon.dataset.path, dest_dir: destDir, action: 'move' }),
        }).then(r => r.json()));
        Promise.all(tasks)
            .then(results => {
                const failed = results.filter(r => r && r.error);
                if (failed.length) showToast(`移动失败：${failed[0].error}`);
                else showToast(names.length > 1 ? `已移动 ${names.length} 项到「${folder.dataset.name}」` : `已移动到「${folder.dataset.name}」`);
                loadDesktopFiles();
            })
            .catch(e => { showToast('移动失败：' + e.message); loadDesktopFiles(); });
    }

    // ===== Dock、键盘、活动概览 =====
    function initDock() {
        document.querySelectorAll('.dock-item').forEach(el => {
            el.addEventListener('click', () => {
                const app = el.dataset.app;
                // 回收站每次都新开（trash 模式），不复用普通文件窗口
                if (app === 'trash') { openApp('trash'); return; }
                const existing = Object.values(windows).find(w => w.app === app);
                if (existing) {
                    if (existing.el.classList.contains('minimized')) restoreWindow(existing.id);
                    else focusWindow(existing.id);
                } else openApp(app);
            });
            el.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                const app = el.dataset.app;
                const appWindows = Object.values(windows).filter(w => w.app === app);
                showContextMenu(e.clientX, e.clientY, [
                    { label: '新建窗口', action: () => openApp(app) },
                    ...(appWindows.length ? [
                        { label: '显示最近窗口', action: () => restoreWindow(appWindows[appWindows.length - 1].id) },
                        { label: '关闭全部窗口', action: () => appWindows.forEach(w => closeWindow(w.id)) },
                    ] : []),
                ]);
            });
        });
    }

    function initKeyboard() {
        document.addEventListener('keydown', (e) => {
            const active = document.activeElement;
            if (active && ['INPUT', 'TEXTAREA'].includes(active.tagName)) return;
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                selectAllIcons();
            } else if (e.key === 'Enter' && selectedIcons.size) {
                e.preventDefault();
                openSelectedIcons();
            } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedIcons.size) {
                e.preventDefault();
                deleteSelectedDesktopFiles();
            } else if (e.key === 'F2' && selectedIcons.size === 1) {
                e.preventDefault();
                const icon = Array.from(selectedIcons)[0];
                if (icon.dataset.path) showToast('请在文件管理器中重命名');
            } else if ((e.altKey && e.key === 'F4') && Object.values(windows).length) {
                e.preventDefault();
                const focused = Object.values(windows).find(w => w.el.classList.contains('focused'));
                if (focused) closeWindow(focused.id);
            } else if ((e.altKey && e.key === 'Tab') && Object.values(windows).length) {
                e.preventDefault();
                cycleWindows();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
                e.preventDefault();
                showDesktop();
            } else if (e.key === 'Escape') {
                closeContextMenu();
                closeActivities();
                clearIconSelection();
            }
        });
    }

    function initActivities() {
        const button = document.getElementById('activities-btn');
        if (button) button.addEventListener('click', toggleActivities);
    }

    function toggleActivities() {
        const current = document.getElementById('activities-overview');
        if (current) { current.remove(); return; }
        clearIconSelection();
        const overview = document.createElement('div');
        overview.id = 'activities-overview';
        overview.className = 'activities-overview';
        overview.innerHTML = `
            <div class="activities-search">应用与窗口</div>
            <div class="activities-apps">
                <button data-app="terminal"><span class="di-icon terminal-icon">▣</span><span>终端</span></button>
                <button data-app="files"><span class="di-icon files-icon">📁</span><span>文件管理</span></button>
                <button data-app="monitor"><span class="di-icon monitor-icon">⌁</span><span>活动监视器</span></button>
                <button data-app="settings"><span class="di-icon settings-icon">⚙</span><span>设置</span></button>
                <button data-app="services"><span class="di-icon services-icon">🛰</span><span>服务管理</span></button>
            </div>
            <div class="activities-windows"></div>`;
        getDesktop().appendChild(overview);
        overview.querySelectorAll('[data-app]').forEach(btn => btn.addEventListener('click', () => {
            openApp(btn.dataset.app);
            closeActivities();
        }));
        const windowList = overview.querySelector('.activities-windows');
        const openWindows = Object.values(windows);
        windowList.innerHTML = openWindows.length
            ? openWindows.map(w => `<button data-window="${w.id}">${escapeHtml(w.title)}</button>`).join('')
            : '<span>当前没有打开的窗口</span>';
        windowList.querySelectorAll('[data-window]').forEach(btn => btn.addEventListener('click', () => {
            restoreWindow(btn.dataset.window);
            closeActivities();
        }));
    }

    function closeActivities() {
        const overview = document.getElementById('activities-overview');
        if (overview) overview.remove();
    }

    function initSystemMenu() {
        const status = document.querySelector('.topbar-right');
        if (!status) return;
        status.addEventListener('click', (e) => {
            if (!e.target.closest('.topbar-icon')) return;
            showContextMenu(window.innerWidth - 230, 34, [
                { label: navigator.onLine ? '网络：已连接' : '网络：离线', disabled: true },
                { label: `浏览器：${navigator.platform || 'Web'}`, disabled: true },
                { separator: true },
                { label: '显示桌面', action: showDesktop },
                { label: '重新加载桌面', action: () => window.location.reload() },
                { separator: true },
                { label: '锁定 / 退出登录', action: logout },
            ]);
        });
    }

    function logout() {
        const form = document.createElement('form');
        form.method = 'post';
        form.action = '/logout';
        document.body.appendChild(form);
        form.submit();
    }

    function showDesktop() {
        Object.values(windows).forEach(w => w.el.classList.add('minimized'));
        document.getElementById('topbar-title').textContent = 'Termux Web Desktop';
        updateDockActive();
    }

    function cycleWindows() {
        const visible = Object.values(windows).filter(w => !w.el.classList.contains('minimized'));
        if (!visible.length) return;
        const current = visible.findIndex(w => w.el.classList.contains('focused'));
        focusWindow(visible[(current + 1) % visible.length].id);
    }

    async function copyText(text) {
        try {
            await navigator.clipboard.writeText(text);
            showToast('路径已复制');
        } catch (_) {
            const input = document.createElement('textarea');
            input.value = text; document.body.appendChild(input); input.select();
            document.execCommand('copy'); input.remove();
            showToast('路径已复制');
        }
    }

    function showToast(message) {
        let toast = document.getElementById('desktop-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'desktop-toast';
            toast.className = 'desktop-toast';
            document.body.appendChild(toast);
        }
        toast.textContent = message;
        toast.classList.add('show');
        clearTimeout(showToast.timer);
        showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
    }

    // ===== 应用与窗口 =====
    function openApp(app) {
        closeActivities();
        if (app === 'terminal') TerminalApp.create();
        else if (app === 'files') FileManagerApp.create();
        else if (app === 'monitor') ActivityMonitorApp.create();
        else if (app === 'settings') SettingsApp.create();
        else if (app === 'services') ServicesApp.create();
        else if (app === 'dufs') DufsIntegrationApp.create();
        else if (app === 'trash') FileManagerApp.create('~', null, { trash: true });
    }

    function createWindow(title, app, contentEl, width = 720, height = 480) {
        const id = 'win-' + (++winIdCounter);
        const container = document.getElementById('windows-container');
        const offsetX = (winIdCounter % 6) * 30;
        const offsetY = (winIdCounter % 6) * 24;
        const maxLeft = Math.max(0, container.clientWidth - width - 20);
        const maxTop = Math.max(0, container.clientHeight - height - 20);

        const win = document.createElement('div');
        win.className = 'window focused';
        win.id = id;
        win.style.width = `${width}px`;
        win.style.height = `${height}px`;
        win.style.left = `${Math.min(offsetX + 40, maxLeft)}px`;
        win.style.top = `${Math.min(offsetY + 20, maxTop)}px`;
        win.style.zIndex = ++zIndex;
        win.innerHTML = `
            <div class="window-titlebar">
                <div class="window-controls">
                    <div class="window-btn close" title="关闭">×</div>
                    <div class="window-btn minimize" title="最小化">−</div>
                    <div class="window-btn maximize" title="最大化">□</div>
                </div>
                <div class="window-title">${escapeHtml(title)}</div>
            </div>
            <div class="window-body"></div>`;

        const body = win.querySelector('.window-body');
        body.appendChild(contentEl);
        container.appendChild(win);
        const winData = { id, el: win, app, title, body, maximized: false };
        windows[id] = winData;

        win.querySelector('.window-btn.close').addEventListener('click', (e) => { e.stopPropagation(); closeWindow(id); });
        win.querySelector('.window-btn.minimize').addEventListener('click', (e) => { e.stopPropagation(); minimizeWindow(id); });
        win.querySelector('.window-btn.maximize').addEventListener('click', (e) => { e.stopPropagation(); toggleMaximize(id); });
        win.addEventListener('mousedown', () => focusWindow(id));
        makeDraggable(win, winData);
        makeResizable(win, winData);
        win.querySelector('.window-titlebar').addEventListener('dblclick', (e) => {
            if (!e.target.classList.contains('window-btn')) toggleMaximize(id);
        });

        clearIconSelection();
        focusWindow(id);
        updateDockActive();
        return winData;
    }

    function makeDraggable(win, winData) {
        const titlebar = win.querySelector('.window-titlebar');
        let startX, startY, origLeft, origTop, dragging = false;
        titlebar.addEventListener('mousedown', (e) => {
            if (e.target.classList.contains('window-btn') || winData.maximized) return;
            dragging = true;
            startX = e.clientX;
            startY = e.clientY;
            origLeft = win.offsetLeft;
            origTop = win.offsetTop;
            e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            win.style.left = `${Math.max(-win.offsetWidth + 100, origLeft + dx)}px`;
            win.style.top = `${Math.max(0, origTop + dy)}px`;
        });
        document.addEventListener('mouseup', (e) => {
            if (!dragging) return;
            dragging = false;
            const container = document.getElementById('windows-container');
            const edge = 28;
            if (e.clientX <= container.getBoundingClientRect().left + edge) snapWindow(winData, 'left');
            else if (e.clientX >= container.getBoundingClientRect().right - edge) snapWindow(winData, 'right');
            else if (e.clientY <= container.getBoundingClientRect().top + edge) toggleMaximize(winData.id, true);
        });
    }

    function makeResizable(win, winData) {
        const handle = document.createElement('div');
        handle.className = 'window-resize-handle';
        win.appendChild(handle);
        let resizing = false, startX = 0, startY = 0, startW = 0, startH = 0;
        handle.addEventListener('pointerdown', (e) => {
            if (winData.maximized) return;
            resizing = true;
            startX = e.clientX; startY = e.clientY;
            startW = win.offsetWidth; startH = win.offsetHeight;
            handle.setPointerCapture(e.pointerId);
            e.stopPropagation(); e.preventDefault();
        });
        handle.addEventListener('pointermove', (e) => {
            if (!resizing) return;
            const container = document.getElementById('windows-container');
            const maxWidth = Math.max(360, container.clientWidth - win.offsetLeft);
            const maxHeight = Math.max(240, container.clientHeight - win.offsetTop);
            win.style.width = `${Math.min(maxWidth, Math.max(360, startW + e.clientX - startX))}px`;
            win.style.height = `${Math.min(maxHeight, Math.max(240, startH + e.clientY - startY))}px`;
            if (winData.terminal?.fitAddon) winData.terminal.fitAddon.fit();
        });
        handle.addEventListener('pointerup', () => { resizing = false; });
        handle.addEventListener('pointercancel', () => { resizing = false; });
    }

    function snapWindow(winData, side) {
        const win = winData.el;
        winData.maximized = false;
        win.classList.remove('maximized');
        win.style.top = '0px';
        win.style.height = '100%';
        win.style.width = '50%';
        win.style.left = side === 'left' ? '0px' : '50%';
        if (winData.terminal?.fitAddon) setTimeout(() => winData.terminal.fitAddon.fit(), 80);
    }

    function focusWindow(id) {
        Object.values(windows).forEach(w => w.el.classList.remove('focused'));
        const w = windows[id];
        if (!w) return;
        w.el.classList.add('focused');
        w.el.style.zIndex = ++zIndex;
        document.getElementById('topbar-title').textContent = w.title;
    }

    function closeWindow(id) {
        const w = windows[id];
        if (!w) return;
        if (w.app === 'terminal' && w.terminal) w.terminal.dispose();
        w.el.dispatchEvent(new CustomEvent('desktop-window-close'));
        w.el.remove();
        delete windows[id];
        updateDockActive();
        const remaining = Object.values(windows);
        if (remaining.length) focusWindow(remaining[remaining.length - 1].id);
        else document.getElementById('topbar-title').textContent = 'Termux Web Desktop';
    }

    function minimizeWindow(id) {
        const w = windows[id];
        if (!w) return;
        w.el.classList.add('minimized');
        updateDockActive();
        const remaining = Object.values(windows).filter(x => !x.el.classList.contains('minimized'));
        if (remaining.length) focusWindow(remaining[remaining.length - 1].id);
        else document.getElementById('topbar-title').textContent = 'Termux Web Desktop';
    }

    function restoreWindow(id) {
        const w = windows[id];
        if (!w) return;
        w.el.classList.remove('minimized');
        focusWindow(id);
        updateDockActive();
    }

    function toggleMaximize(id, forceMaximize = false) {
        const w = windows[id];
        if (!w) return;
        w.maximized = forceMaximize ? true : !w.maximized;
        w.el.classList.toggle('maximized', w.maximized);
        if (w.terminal && w.terminal.fitAddon) setTimeout(() => w.terminal.fitAddon.fit(), 100);
    }

    function updateDockActive() {
        document.querySelectorAll('.dock-item').forEach(item => {
            item.classList.toggle('active', Object.values(windows).some(w => w.app === item.dataset.app));
        });
    }

    // ===== 通用右键菜单 =====
    function showContextMenu(x, y, items) {
        closeContextMenu();
        const menu = document.createElement('div');
        menu.className = 'context-menu';
        menu.id = 'context-menu';
        items.forEach(item => {
            if (item.separator) {
                menu.appendChild(document.createElement('div')).className = 'context-menu-sep';
                return;
            }
            const entry = document.createElement('div');
            entry.className = `context-menu-item${item.danger ? ' danger' : ''}${item.disabled ? ' disabled' : ''}`;
            entry.textContent = item.label;
            if (!item.disabled) entry.addEventListener('click', () => {
                closeContextMenu();
                if (item.action) item.action();
            });
            menu.appendChild(entry);
        });
        document.body.appendChild(menu);
        const rect = menu.getBoundingClientRect();
        menu.style.left = `${Math.max(5, Math.min(x, window.innerWidth - rect.width - 5))}px`;
        menu.style.top = `${Math.max(37, Math.min(y, window.innerHeight - rect.height - 5))}px`;
    }

    function closeContextMenu() {
        const menu = document.getElementById('context-menu');
        if (menu) menu.remove();
    }

    // ===== 简单输入弹窗（供文件管理器复用） =====
    function prompt(title, defaultValue, callback) {
        const overlay = document.createElement('div');
        overlay.className = 'prompt-overlay';
        overlay.innerHTML = `
            <div class="prompt-box">
                <label>${escapeHtml(title)}</label>
                <input type="text" value="${escapeHtml(defaultValue || '')}">
                <div class="prompt-actions">
                    <button class="fm-btn" data-act="cancel">取消</button>
                    <button class="fm-btn" data-act="ok" style="background:var(--accent);border-color:var(--accent);">确定</button>
                </div>
            </div>`;
        const activeWin = document.querySelector('.window.focused .window-body');
        (activeWin || document.body).appendChild(overlay);
        const input = overlay.querySelector('input');
        input.focus();
        input.select();
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') overlay.querySelector('[data-act=ok]').click();
            if (e.key === 'Escape') overlay.querySelector('[data-act=cancel]').click();
        });
        overlay.querySelector('[data-act=cancel]').addEventListener('click', () => overlay.remove());
        overlay.querySelector('[data-act=ok]').addEventListener('click', () => {
            const value = input.value.trim();
            overlay.remove();
            if (value) callback(value);
        });
    }

    function escapeHtml(value) {
        const div = document.createElement('div');
        div.textContent = String(value);
        return div.innerHTML;
    }

    return {
        init, createWindow, closeWindow, focusWindow,
        showContextMenu, closeContextMenu, prompt, windows, showToast,
        selectAllIcons, clearIconSelection, autoArrangeIcons, copyToDesktop, openFilePath, reloadDesktop: loadDesktopFiles,
    };
})();
