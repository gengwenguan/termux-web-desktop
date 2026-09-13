/**
 * 文件管理器应用
 * 通过 REST API 操作 Termux 真实文件系统
 */
const FileManagerApp = (function () {
    const instances = new Set();
    let clipboard = null;

    function create(initialPath = '~', initialFile = null, options = {}) {
        const container = document.createElement('div');
        container.className = 'fm-container';
        container.innerHTML = `
            <div class="fm-toolbar">
                <button class="fm-btn" data-act="back" title="后退" disabled>←</button>
                <button class="fm-btn" data-act="forward" title="前进" disabled>→</button>
                <button class="fm-btn" data-act="up" title="上级目录">↑</button>
                <button class="fm-btn" data-act="home" title="主目录">🏠</button>
                <button class="fm-btn" data-act="refresh" title="刷新">↻</button>
                <input class="fm-path" type="text" spellcheck="false">
                <button class="fm-btn" data-act="go" title="跳转">跳转</button>
                <button class="fm-btn" data-act="new-dir" title="新建文件夹">📁+</button>
                <button class="fm-btn" data-act="new-file" title="新建文件">📄+</button>
                <button class="fm-btn" data-act="upload" title="上传文件">⬆</button>
                <input type="file" id="fm-upload-input" style="display:none" multiple>
            </div>
            <div class="fm-options">
                <input class="fm-search" type="search" placeholder="搜索当前文件夹" spellcheck="false">
                <select class="fm-sort" title="排序方式">
                    <option value="name-asc">名称 A→Z</option>
                    <option value="name-desc">名称 Z→A</option>
                    <option value="time-desc">修改时间（最新）</option>
                    <option value="time-asc">修改时间（最早）</option>
                    <option value="size-desc">大小（从大到小）</option>
                    <option value="size-asc">大小（从小到大）</option>
                </select>
                <button class="fm-btn" data-act="trash">回收站</button>
                <button class="fm-btn fm-btn-danger" data-act="empty-trash" style="display:none">清空回收站</button>
                <span class="fm-status">0 个项目</span>
            </div>
            <div class="fm-list">
                <div class="fm-list-header">
                    <span>名称</span><span>大小</span><span>类型</span><span>修改时间</span>
                </div>
                <div class="fm-list-body"></div>
            </div>
        `;

        const win = Desktop.createWindow('文件管理', 'files', container, 800, 520);
        const state = {
            path: initialPath || '~', selectedPaths: new Set(), load: null,
            history: [], historyIndex: -1, items: [], visibleItems: [],
            anchorIndex: -1, filter: '', sort: 'name-asc', trashMode: !!options.trash,
        };
        container._fmState = state;
        instances.add(state);
        win.el.addEventListener('desktop-window-close', () => instances.delete(state), { once: true });

        const pathInput = container.querySelector('.fm-path');
        const listBody = container.querySelector('.fm-list-body');
        const searchInput = container.querySelector('.fm-search');
        const sortSelect = container.querySelector('.fm-sort');
        const statusLabel = container.querySelector('.fm-status');
        const trashButton = container.querySelector('[data-act=trash]');

        async function load(path, options = {}) {
            if (!state.trashMode) state.path = path || '~';
            pathInput.value = state.trashMode ? '回收站' : state.path;
            try {
                const url = state.trashMode ? '/api/trash' : '/api/files?path=' + encodeURIComponent(state.path);
                const resp = await fetch(url);
                const data = await resp.json();
                if (!resp.ok || data.error) {
                    listBody.innerHTML = `<div class="fm-empty">${escapeHtml(data.error || '加载失败')}</div>`;
                    return;
                }
                if (!state.trashMode) {
                    state.path = data.path;
                    pathInput.value = data.path;
                    if (!options.fromHistory && state.history[state.historyIndex] !== data.path) {
                        state.history = state.history.slice(0, state.historyIndex + 1);
                        state.history.push(data.path);
                        state.historyIndex = state.history.length - 1;
                    }
                }
                state.items = (data.items || []).map(item => state.trashMode ? {
                    ...item, path: item.stored_path, trashId: item.id, mtime: item.deleted_at,
                    size: 0, originalPath: item.original_path,
                } : item);
                updateHistoryButtons();
                state.selectedPaths.clear();
                state.anchorIndex = -1;
                applyView();
            } catch (e) {
                listBody.innerHTML = `<div class="fm-empty">加载失败: ${escapeHtml(e.message)}</div>`;
            }
        }

        function updateHistoryButtons() {
            const disabled = state.trashMode;
            container.querySelector('[data-act=back]').disabled = disabled || state.historyIndex <= 0;
            container.querySelector('[data-act=forward]').disabled = disabled || state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
            container.querySelector('[data-act=up]').disabled = disabled;
            container.querySelector('[data-act=home]').disabled = disabled;
            container.querySelector('[data-act=go]').disabled = disabled;
            pathInput.disabled = disabled;
            container.querySelector('[data-act=new-dir]').disabled = disabled;
            container.querySelector('[data-act=new-file]').disabled = disabled;
            container.querySelector('[data-act=upload]').disabled = disabled;
            trashButton.textContent = state.trashMode ? '返回文件' : '回收站';
            // 清空回收站按钮仅在回收站模式显示；空回收站时禁用
            const emptyBtn = container.querySelector('[data-act=empty-trash]');
            if (emptyBtn) {
                emptyBtn.style.display = state.trashMode ? '' : 'none';
                emptyBtn.disabled = state.trashMode && state.items.length === 0;
            }
        }

        function navigateHistory(delta) {
            if (state.trashMode) return;
            const next = state.historyIndex + delta;
            if (next < 0 || next >= state.history.length) return;
            state.historyIndex = next;
            load(state.history[next], { fromHistory: true });
        }

        function applyView() {
            const query = state.filter.trim().toLocaleLowerCase();
            const items = state.items.filter(item => !query || item.name.toLocaleLowerCase().includes(query));
            const [key, direction] = state.sort.split('-');
            const factor = direction === 'desc' ? -1 : 1;
            items.sort((a, b) => {
                if (key === 'name') {
                    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) * factor;
                }
                if (key === 'size') return ((a.size || 0) - (b.size || 0)) * factor;
                return String(a.mtime || '').localeCompare(String(b.mtime || '')) * factor;
            });
            state.visibleItems = items;
            const visiblePaths = new Set(items.map(item => item.path));
            state.selectedPaths.forEach(path => { if (!visiblePaths.has(path)) state.selectedPaths.delete(path); });
            render(items);
        }

        function selectedItems() {
            return state.items.filter(item => state.selectedPaths.has(item.path));
        }

        function updateSelectionUI() {
            listBody.querySelectorAll('.fm-item').forEach(el => el.classList.toggle('selected', state.selectedPaths.has(el.dataset.path)));
            const count = state.selectedPaths.size;
            statusLabel.textContent = count ? `已选 ${count} 项 / 共 ${state.visibleItems.length} 项` : `${state.visibleItems.length} 个项目`;
        }

        function selectItem(item, index, event) {
            if (event.shiftKey && state.anchorIndex >= 0) {
                if (!event.ctrlKey && !event.metaKey) state.selectedPaths.clear();
                const start = Math.min(state.anchorIndex, index);
                const end = Math.max(state.anchorIndex, index);
                for (let i = start; i <= end; i++) state.selectedPaths.add(state.visibleItems[i].path);
            } else if (event.ctrlKey || event.metaKey) {
                if (state.selectedPaths.has(item.path)) state.selectedPaths.delete(item.path);
                else state.selectedPaths.add(item.path);
                state.anchorIndex = index;
            } else {
                state.selectedPaths.clear();
                state.selectedPaths.add(item.path);
                state.anchorIndex = index;
            }
            updateSelectionUI();
            container.focus({ preventScroll: true });
        }

        function render(items) {
            if (items.length === 0) {
                listBody.innerHTML = `<div class="fm-empty">${state.filter ? '没有匹配项目' : (state.trashMode ? '回收站为空' : '空文件夹')}</div>`;
                updateSelectionUI();
                return;
            }
            listBody.innerHTML = items.map(item => `
                <div class="fm-item" draggable="${!state.trashMode}" data-path="${escapeAttr(item.path)}" data-name="${escapeAttr(item.name)}" data-isdir="${item.is_dir}" data-trash-id="${escapeAttr(item.trashId || '')}">
                    <span class="fm-item-name">
                        <span class="icon">${item.is_dir ? '📁' : getFileIcon(item.name)}</span>
                        <span>${escapeHtml(item.name)}</span>
                    </span>
                    <span class="fm-item-size">${item.is_dir ? '—' : formatSize(item.size || 0)}</span>
                    <span class="fm-item-type">${state.trashMode ? '已删除' : (item.is_dir ? '文件夹' : getFileType(item.name))}</span>
                    <span class="fm-item-time">${escapeHtml(item.mtime || '')}</span>
                </div>
            `).join('');

            listBody.querySelectorAll('.fm-item').forEach((el, index) => {
                const item = state.visibleItems[index];
                el.addEventListener('dblclick', () => {
                    if (state.trashMode) return;
                    if (item.is_dir) load(item.path);
                    else openFile(item.path);
                });
                el.addEventListener('click', (e) => selectItem(item, index, e));
                el.addEventListener('dragstart', (e) => {
                    if (state.trashMode) { e.preventDefault(); return; }
                    if (!state.selectedPaths.has(item.path)) {
                        state.selectedPaths.clear();
                        state.selectedPaths.add(item.path);
                        updateSelectionUI();
                    }
                    const selected = selectedItems();
                    const payload = {
                        items: selected.map(entry => ({ path: entry.path, name: entry.name, isDir: entry.is_dir })),
                        sourceDir: state.path,
                        path: selected[0]?.path,
                        name: selected[0]?.name,
                        isDir: selected[0]?.is_dir,
                    };
                    e.dataTransfer.effectAllowed = 'all';
                    e.dataTransfer.setData('application/x-termux-file', JSON.stringify(payload));
                    e.dataTransfer.setData('text/plain', payload.items.map(entry => entry.path).join('\n'));
                    el.classList.add('dragging');
                });
                el.addEventListener('dragend', () => el.classList.remove('dragging'));
                if (!state.trashMode && item.is_dir) {
                    el.addEventListener('dragover', (e) => showDropTarget(e, el));
                    el.addEventListener('dragleave', (e) => clearDropTarget(e, el));
                    el.addEventListener('drop', (e) => handleDrop(e, item.path, el));
                }
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    if (!state.selectedPaths.has(item.path)) {
                        state.selectedPaths.clear();
                        state.selectedPaths.add(item.path);
                        state.anchorIndex = index;
                    }
                    updateSelectionUI();
                    state.trashMode ? showTrashMenu(e.clientX, e.clientY) : showItemMenu(e.clientX, e.clientY);
                });
            });
            updateSelectionUI();
        }

        function hasFilePayload(e) {
            return Array.from(e.dataTransfer?.types || []).includes('application/x-termux-file');
        }

        function showDropTarget(e, target) {
            if (!hasFilePayload(e)) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
            target.classList.add('drop-target');
        }

        function clearDropTarget(e, target) {
            if (!target.contains(e.relatedTarget)) target.classList.remove('drop-target');
        }

        async function handleDrop(e, destDir, target) {
            if (!hasFilePayload(e)) return;
            e.preventDefault();
            e.stopPropagation();
            if (target) target.classList.remove('drop-target');
            listBody.classList.remove('drop-target');
            let payload;
            try {
                payload = JSON.parse(e.dataTransfer.getData('application/x-termux-file'));
            } catch (_) {
                alert('无法识别拖放的文件');
                return;
            }
            const draggedItems = payload?.items || (payload?.path ? [payload] : []);
            if (!draggedItems.length) return;
            const action = (e.ctrlKey || e.metaKey) ? 'copy' : 'move';
            try {
                for (const item of draggedItems) {
                    const resp = await fetch('/api/file/transfer', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ src: item.path, dest_dir: destDir, action }),
                    });
                    const data = await resp.json();
                    if (!resp.ok || data.error) throw new Error(`${item.name}: ${data.error || '操作失败'}`);
                }
                refreshAll();
                if (Desktop.showToast) Desktop.showToast(`${action === 'copy' ? '已复制' : '已移动'} ${draggedItems.length} 个项目`);
            } catch (error) {
                alert(`${action === 'copy' ? '复制' : '移动'}失败: ${error.message}`);
            }
        }

        listBody.addEventListener('dragover', (e) => {
            if (e.target.closest('.fm-item[data-isdir="true"]')) return;
            showDropTarget(e, listBody);
        });
        listBody.addEventListener('dragleave', (e) => clearDropTarget(e, listBody));
        listBody.addEventListener('drop', (e) => {
            if (e.target.closest('.fm-item[data-isdir="true"]')) return;
            handleDrop(e, state.path, listBody);
        });

        function showItemMenu(x, y) {
            const selected = selectedItems();
            if (!selected.length) return;
            const first = selected[0];
            const single = selected.length === 1;
            const items = [
                { label: single ? '打开' : `打开（仅首项）`, action: () => {
                    if (first.is_dir) load(first.path);
                    else openFile(first.path);
                }},
                { label: `复制到桌面（${selected.length}）`, action: () => {
                    Desktop.copyToDesktop(selected.map(item => ({ path: item.path, name: item.name, is_dir: item.is_dir })));
                }},
                { label: '重命名', disabled: !single, action: () => {
                    Desktop.prompt('重命名为:', first.name, (newName) => {
                        const newPath = joinPath(state.path, newName);
                        apiPost('/api/file/rename', { src: first.path, dst: newPath }, () => load(state.path));
                    });
                }},
                { label: `复制（${selected.length}）`, action: () => setClipboard(selected, 'copy') },
                { label: `剪切（${selected.length}）`, action: () => setClipboard(selected, 'move') },
                { separator: true },
                { label: `压缩为 zip（${selected.length}）`, action: () => {
                    apiPost('/api/file/compress', { paths: selected.map(item => item.path) }, () => refreshAll());
                }},
                ...((single && isArchiveName(first.name)) ? [
                    { label: '解压到此处', action: () => {
                        apiPost('/api/file/extract', { path: first.path }, () => refreshAll());
                    }},
                ] : []),
                { separator: true },
                { label: '下载', disabled: !single || first.is_dir, action: () => {
                    if (single && !first.is_dir) window.open('/api/file/download?path=' + encodeURIComponent(first.path));
                }},
                { label: `移到回收站（${selected.length}）`, danger: true, action: () => {
                    if (confirm(`将选中的 ${selected.length} 个项目移到回收站吗？`)) {
                        apiPost('/api/file/delete', { paths: selected.map(item => item.path) }, () => refreshAll());
                    }
                }},
            ];
            Desktop.showContextMenu(x, y, items);
        }

        function showTrashMenu(x, y) {
            const selected = selectedItems();
            if (!selected.length) return;
            Desktop.showContextMenu(x, y, [
                { label: `恢复（${selected.length}）`, action: () => {
                    apiPost('/api/trash/restore', { ids: selected.map(item => item.trashId) }, () => refreshAll());
                }},
                { separator: true },
                { label: '清空整个回收站', danger: true, action: () => {
                    if (confirm('确定永久清空回收站吗？此操作不可恢复。')) {
                        apiPost('/api/trash/empty', {}, () => refreshAll());
                    }
                }},
            ]);
        }

        // 空白处右键（列表主体与其外层容器都拦截，避免落到浏览器原生菜单）
        function showBlankMenu(e) {
            if (e.target.closest('.fm-item')) return;   // 点在文件项上交给项菜单
            e.preventDefault();
            const menu = state.trashMode ? [
                { label: '清空回收站', danger: true, action: () => {
                    if (!state.items.length) { Desktop.showToast && Desktop.showToast('回收站已经是空的'); return; }
                    if (confirm('确定永久清空回收站吗？此操作不可恢复。')) apiPost('/api/trash/empty', {}, () => refreshAll());
                }},
                { label: '刷新', action: () => load(state.path, { fromHistory: true }) },
            ] : [
                { label: '新建文件夹', action: () => {
                    Desktop.prompt('文件夹名称:', '新建文件夹', (name) => {
                        apiPost('/api/file/mkdir', { path: joinPath(state.path, name) }, () => load(state.path));
                    });
                }},
                { label: '新建文件', action: () => {
                    Desktop.prompt('文件名称:', '新文件.txt', (name) => {
                        apiPost('/api/file/mkfile', { path: joinPath(state.path, name) }, () => load(state.path));
                    });
                }},
                { separator: true },
                { label: clipboard ? `粘贴 ${clipboard.items.length} 个项目` : '粘贴', disabled: !clipboard, action: () => pasteClipboard(state.path) },
                { label: '刷新', action: () => load(state.path, { fromHistory: true }) },
            ];
            Desktop.showContextMenu(e.clientX, e.clientY, menu);
        }
        listBody.addEventListener('contextmenu', showBlankMenu);
        container.querySelector('.fm-list').addEventListener('contextmenu', (e) => {
            // 仅当事件落在列表空白（非文件项、非列表主体已处理区域）时兜底
            if (e.target.closest('.fm-item') || e.target.closest('.fm-list-body')) return;
            showBlankMenu(e);
        });
        // 兜底：文件管理器窗口内的其余空白（工具栏等）右键不弹浏览器原生菜单
        container.addEventListener('contextmenu', (e) => {
            if (e.target.closest('input, textarea')) return;  // 输入框保留原生菜单（可粘贴）
            e.preventDefault();
        });

        searchInput.addEventListener('input', () => { state.filter = searchInput.value; applyView(); });
        sortSelect.addEventListener('change', () => { state.sort = sortSelect.value; applyView(); });
        trashButton.addEventListener('click', () => {
            state.trashMode = !state.trashMode;
            state.filter = '';
            searchInput.value = '';
            load(state.path, { fromHistory: true });
        });

        // 工具栏按钮
        container.querySelector('[data-act=empty-trash]').addEventListener('click', () => {
            if (!state.items.length) { Desktop.showToast && Desktop.showToast('回收站已经是空的'); return; }
            if (confirm(`确定永久清空回收站吗？将删除 ${state.items.length} 个项目，此操作不可恢复。`)) {
                apiPost('/api/trash/empty', {}, () => refreshAll());
            }
        });
        container.querySelector('[data-act=back]').addEventListener('click', () => navigateHistory(-1));
        container.querySelector('[data-act=forward]').addEventListener('click', () => navigateHistory(1));
        container.querySelector('[data-act=refresh]').addEventListener('click', () => load(state.path, { fromHistory: true }));
        container.querySelector('[data-act=up]').addEventListener('click', () => {
            load(joinPath(state.path, '..'));
        });
        container.querySelector('[data-act=home]').addEventListener('click', () => load('~'));
        container.querySelector('[data-act=go]').addEventListener('click', () => load(pathInput.value));
        pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') load(pathInput.value); });
        container.querySelector('[data-act=new-dir]').addEventListener('click', () => {
            Desktop.prompt('文件夹名称:', '新建文件夹', (name) => {
                apiPost('/api/file/mkdir', { path: joinPath(state.path, name) }, () => load(state.path));
            });
        });
        container.querySelector('[data-act=new-file]').addEventListener('click', () => {
            Desktop.prompt('文件名称:', '新文件.txt', (name) => {
                apiPost('/api/file/mkfile', { path: joinPath(state.path, name) }, () => load(state.path));
            });
        });
        container.querySelector('[data-act=upload]').addEventListener('click', () => {
            container.querySelector('#fm-upload-input').click();
        });
        container.querySelector('#fm-upload-input').addEventListener('change', async (e) => {
            const files = e.target.files;
            if (!files.length) return;
            const formData = new FormData();
            formData.append('dir', state.path);
            for (const f of files) formData.append('file', f);
            try {
                const response = await fetch('/api/file/upload', { method: 'POST', body: formData });
                const data = await response.json();
                if (!response.ok || data.error) throw new Error(data.error || '上传失败');
                if (Desktop.showToast) Desktop.showToast(`已上传 ${data.paths.length} 个文件`);
                load(state.path);
            } catch (error) {
                alert('上传失败: ' + error.message);
            }
            e.target.value = '';
        });

        container.addEventListener('keydown', (e) => {
            if (e.target.matches('input, textarea, select') && e.key !== 'Escape') return;
            const selected = selectedItems();
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
                e.preventDefault();
                state.visibleItems.forEach(item => state.selectedPaths.add(item.path));
                updateSelectionUI();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
                e.preventDefault(); searchInput.focus(); searchInput.select();
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selected.length && !state.trashMode) {
                e.preventDefault(); setClipboard(selected, 'copy');
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'x' && selected.length && !state.trashMode) {
                e.preventDefault(); setClipboard(selected, 'move');
            } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v' && !state.trashMode) {
                e.preventDefault(); pasteClipboard(state.path);
            } else if (e.altKey && e.key === 'ArrowLeft') {
                e.preventDefault(); navigateHistory(-1);
            } else if (e.altKey && e.key === 'ArrowRight') {
                e.preventDefault(); navigateHistory(1);
            } else if (e.key === 'F5') {
                e.preventDefault(); load(state.path, { fromHistory: true });
            } else if (e.key === 'Delete' && selected.length && !state.trashMode) {
                e.preventDefault();
                if (confirm(`将选中的 ${selected.length} 个项目移到回收站吗？`)) {
                    apiPost('/api/file/delete', { paths: selected.map(item => item.path) }, () => refreshAll());
                }
            } else if (e.key === 'Enter' && selected.length === 1 && !state.trashMode) {
                e.preventDefault(); selected[0].is_dir ? load(selected[0].path) : openFile(selected[0].path);
            } else if (e.key === 'Escape') {
                state.selectedPaths.clear(); updateSelectionUI();
            }
        });
        container.tabIndex = 0;

        // 按文件类型打开
        function openFile(path) {
            const kind = getPreviewKind(path);
            if (kind === 'image') openImageViewer(path);
            else if (kind === 'video') openVideoPlayer(path);
            else if (kind === 'audio') openAudioPlayer(path);
            else if (kind === 'pdf') window.open('/api/file/media?path=' + encodeURIComponent(path), '_blank', 'noopener');
            else openFileEditor(path);
        }

        function openImageViewer(path) {
            const viewer = document.createElement('div');
            viewer.className = 'media-viewer image-viewer';
            const url = '/api/file/media?path=' + encodeURIComponent(path);
            viewer.innerHTML = `
                <div class="media-toolbar">
                    <button class="fm-btn" data-act="zoom-out">−</button>
                    <span class="media-zoom">100%</span>
                    <button class="fm-btn" data-act="zoom-in">＋</button>
                    <button class="fm-btn" data-act="fit">适应窗口</button>
                    <button class="fm-btn" data-act="rotate">旋转</button>
                    <a class="fm-btn media-link" href="/api/file/download?path=${encodeURIComponent(path)}">下载</a>
                </div>
                <div class="image-stage"><img alt="${escapeAttr(baseName(path))}" draggable="false"></div>`;
            const mediaWin = Desktop.createWindow(baseName(path), 'image-viewer', viewer, 840, 600);
            const image = viewer.querySelector('img');
            const zoomLabel = viewer.querySelector('.media-zoom');
            let zoom = 1, rotation = 0;
            const apply = () => {
                image.style.transform = `scale(${zoom}) rotate(${rotation}deg)`;
                zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
            };
            image.src = url;
            image.addEventListener('error', () => showMediaError(viewer, '图片加载失败或格式不受浏览器支持', path));
            viewer.querySelector('[data-act=zoom-in]').addEventListener('click', () => { zoom = Math.min(5, zoom + .25); apply(); });
            viewer.querySelector('[data-act=zoom-out]').addEventListener('click', () => { zoom = Math.max(.25, zoom - .25); apply(); });
            viewer.querySelector('[data-act=rotate]').addEventListener('click', () => { rotation = (rotation + 90) % 360; apply(); });
            viewer.querySelector('[data-act=fit]').addEventListener('click', () => { zoom = 1; rotation = 0; image.style.maxWidth = '100%'; image.style.maxHeight = '100%'; apply(); });
            image.addEventListener('dblclick', () => viewer.querySelector('[data-act=fit]').click());
            mediaWin.el.addEventListener('wheel', (e) => {
                if (!e.ctrlKey && !e.metaKey) return;
                e.preventDefault();
                zoom = Math.max(.25, Math.min(5, zoom + (e.deltaY < 0 ? .15 : -.15)));
                apply();
            }, { passive: false });
        }

        function openVideoPlayer(path) {
            const viewer = document.createElement('div');
            viewer.className = 'media-viewer video-viewer';
            const url = '/api/file/media?path=' + encodeURIComponent(path);
            viewer.innerHTML = `
                <video controls preload="metadata" playsinline>
                    <source src="${url}">
                    当前浏览器不支持此视频格式。
                </video>
                <div class="media-footer">
                    <span>${escapeHtml(baseName(path))}</span>
                    <a class="fm-btn media-link" href="/api/file/download?path=${encodeURIComponent(path)}">下载</a>
                </div>`;
            const mediaWin = Desktop.createWindow(baseName(path), 'video-player', viewer, 860, 560);
            const video = viewer.querySelector('video');
            video.addEventListener('error', () => showMediaError(viewer, '视频无法播放；可能是编码不受当前浏览器支持', path));
            mediaWin.el.addEventListener('keydown', (e) => {
                if (e.key === ' ') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
                if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5);
                if (e.key === 'ArrowRight') video.currentTime = Math.min(video.duration || Infinity, video.currentTime + 5);
            });
        }

        function openAudioPlayer(path) {
            const viewer = document.createElement('div');
            viewer.className = 'media-viewer audio-viewer';
            const url = '/api/file/media?path=' + encodeURIComponent(path);
            viewer.innerHTML = `
                <div class="audio-art">♫</div>
                <div class="audio-title">${escapeHtml(baseName(path))}</div>
                <audio controls preload="metadata" src="${url}"></audio>
                <a class="fm-btn media-link" href="/api/file/download?path=${encodeURIComponent(path)}">下载</a>`;
            Desktop.createWindow(baseName(path), 'audio-player', viewer, 520, 300);
            viewer.querySelector('audio').addEventListener('error', () => showMediaError(viewer, '音频无法播放或格式不受支持', path));
        }

        function showMediaError(viewer, message, path) {
            let error = viewer.querySelector('.media-error');
            if (!error) {
                error = document.createElement('div');
                error.className = 'media-error';
                viewer.appendChild(error);
            }
            error.innerHTML = `${escapeHtml(message)}<br><a class="fm-btn media-link" href="/api/file/download?path=${encodeURIComponent(path)}">下载文件</a>`;
        }

        // 文件编辑器
        function openFileEditor(path) {
            fetch('/api/file/read?path=' + encodeURIComponent(path))
                .then(r => r.json())
                .then(data => {
                    if (data.error) { alert(data.error); return; }
                    showEditor(path, data.content);
                })
                .catch(e => alert('读取失败: ' + e.message));
        }

        function showEditor(path, content) {
            const overlay = document.createElement('div');
            overlay.className = 'fm-editor-overlay';
            overlay.innerHTML = `
                <div class="fm-editor">
                    <div class="fm-editor-header">
                        <span class="fm-editor-title">${escapeHtml(path)}</span>
                        <div class="fm-editor-actions">
                            <button class="fm-btn" data-act="cancel">取消</button>
                            <button class="fm-btn" data-act="save" style="background:#E95420;border-color:#E95420;">保存</button>
                        </div>
                    </div>
                    <textarea spellcheck="false"></textarea>
                </div>
            `;
            container.appendChild(overlay);
            const ta = overlay.querySelector('textarea');
            ta.value = content;
            overlay.querySelector('[data-act=cancel]').addEventListener('click', () => overlay.remove());
            overlay.querySelector('[data-act=save]').addEventListener('click', () => {
                apiPost('/api/file/write', { path, content: ta.value }, () => {
                    overlay.remove();
                    load(state.path);
                });
            });
            ta.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') overlay.remove();
                if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                    e.preventDefault();
                    overlay.querySelector('[data-act=save]').click();
                }
            });
            setTimeout(() => ta.focus(), 50);
        }

        // 初始加载；桌面文件快捷方式可直接定位目录或打开文件。
        state.load = load;
        load(initialPath || '~').then(() => {
            if (initialFile) openFile(initialFile);
        });
        return win;
    }

    // ===== 工具函数 =====
    function setClipboard(items, action) {
        const normalized = Array.isArray(items) ? items : [items];
        clipboard = {
            items: normalized.map(item => ({
                path: item.path,
                name: item.name,
                isDir: item.is_dir !== undefined ? item.is_dir : item.isDir,
            })),
            action,
        };
        if (Desktop.showToast) Desktop.showToast(`${action === 'copy' ? '已复制' : '已剪切'} ${clipboard.items.length} 个项目`);
    }

    async function pasteClipboard(destDir) {
        if (!clipboard) return;
        const current = { action: clipboard.action, items: clipboard.items.map(item => ({ ...item })) };
        try {
            for (const item of current.items) {
                const response = await fetch('/api/file/transfer', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ src: item.path, dest_dir: destDir, action: current.action }),
                });
                const data = await response.json();
                if (!response.ok || data.error) throw new Error(`${item.name}: ${data.error || '粘贴失败'}`);
            }
            if (current.action === 'move') clipboard = null;
            refreshAll();
            if (Desktop.showToast) Desktop.showToast(`${current.action === 'copy' ? '已复制' : '已移动'} ${current.items.length} 个项目`);
        } catch (error) {
            alert('粘贴失败: ' + error.message);
        }
    }

    function refreshAll() {
        instances.forEach(state => {
            if (typeof state.load === 'function' && state.path) state.load(state.path);
        });
    }

    function apiPost(url, body, onSuccess) {
        fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        })
        .then(r => r.json())
        .then(data => {
            if (data.error) alert(data.error);
            else onSuccess && onSuccess(data);
        })
        .catch(e => alert('请求失败: ' + e.message));
    }

    function joinPath(base, name) {
        // ~ 路径交给后端展开，这里只做简单拼接
        if (base.endsWith('/')) return base + name;
        return base + '/' + name;
    }

    function isArchiveName(name) {
        const lower = (name || '').toLowerCase();
        return ['.zip', '.tar', '.tar.gz', '.tgz', '.tar.bz2', '.tar.xz'].some(ext => lower.endsWith(ext));
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB';
        return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB';
    }

    function getPreviewKind(path) {
        const ext = (path.split('.').pop() || '').toLowerCase();
        if (['png','jpg','jpeg','gif','svg','webp','bmp','avif'].includes(ext)) return 'image';
        if (['mp4','webm','ogv','mov','m4v'].includes(ext)) return 'video';
        if (['mp3','wav','ogg','oga','m4a','aac','flac'].includes(ext)) return 'audio';
        if (ext === 'pdf') return 'pdf';
        return 'text';
    }

    function baseName(path) {
        return path.split('/').filter(Boolean).pop() || path;
    }

    function getFileIcon(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = {
            png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️',
            mp4: '🎬', mkv: '🎬', avi: '🎬', mov: '🎬', webm: '🎬',
            mp3: '🎵', wav: '🎵', flac: '🎵', ogg: '🎵', m4a: '🎵',
            zip: '📦', tar: '📦', gz: '📦', rar: '📦', '7z': '📦', bz2: '📦', xz: '📦',
            pdf: '📕', doc: '📘', docx: '📘', xls: '📗', xlsx: '📗', ppt: '📙', pptx: '📙',
            txt: '📄', md: '📝', log: '📋',
            js: '📜', ts: '📜', py: '📜', sh: '📜', json: '⚙️', yaml: '⚙️', yml: '⚙️',
            html: '🌐', css: '🎨', xml: '📄',
        };
        return map[ext] || '📄';
    }

    function getFileType(name) {
        const ext = name.split('.').pop().toLowerCase();
        const map = {
            png: '图片', jpg: '图片', jpeg: '图片', gif: '图片',
            mp4: '视频', mkv: '视频', mp3: '音频',
            zip: '压缩包', tar: '压缩包', gz: '压缩包',
            pdf: 'PDF 文档', txt: '文本文件',
            js: 'JavaScript', py: 'Python', sh: 'Shell 脚本',
            json: 'JSON', html: '网页',
        };
        return map[ext] || ext.toUpperCase() + ' 文件';
    }

    function escapeAttr(str) {
        return escapeHtml(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    return { create };
})();
