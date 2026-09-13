/**
 * 终端应用
 * 每个窗口使用独立 Socket.IO 连接和独立 Termux PTY。
 */
const TerminalApp = (function () {
    function create() {
        const container = document.createElement('div');
        container.className = 'terminal-container';
        const win = Desktop.createWindow('终端', 'terminal', container, 720, 460);

        const term = new Terminal({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: '"Ubuntu Mono", "Consolas", "Monaco", monospace',
            theme: {
                background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#E95420',
                selectionBackground: 'rgba(233, 84, 32, 0.3)',
                black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510',
                blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
                brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b',
                brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6',
                brightCyan: '#29b8db', brightWhite: '#ffffff',
            },
            scrollback: 5000,
            convertEol: true,
        });
        const fitAddon = new FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        term.open(container);
        container._terminal = term;
        win.terminal = term;
        win.terminalFit = fitAddon;

        let socketReady = false;
        let closed = false;
        const socket = io({ transports: ['websocket', 'polling'] });

        function resizeTerminal() {
            if (!socketReady || closed) return;
            socket.emit('terminal_resize', { cols: term.cols, rows: term.rows });
        }

        socket.on('connect', () => {
            socketReady = true;
            requestAnimationFrame(() => {
                if (closed) return;
                fitAddon.fit();
                resizeTerminal();
                term.focus();
            });
        });
        socket.on('disconnect', () => { socketReady = false; });
        socket.on('terminal_output', data => {
            if (!closed && data && typeof data.data === 'string') term.write(data.data);
        });
        socket.on('terminal_exit', () => {
            if (!closed) term.write('\r\n\x1b[31m[终端进程已退出]\x1b[0m\r\n');
        });
        socket.on('connect_error', error => {
            if (!closed) term.write(`\r\n\x1b[31m[连接失败: ${error.message}]\x1b[0m\r\n`);
        });

        term.onData(data => {
            if (socketReady && !closed) socket.emit('terminal_input', { data });
        });

        const resizeObserver = new ResizeObserver(() => {
            if (closed) return;
            fitAddon.fit();
            resizeTerminal();
        });
        resizeObserver.observe(container);

        term.attachCustomKeyEventHandler(e => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                navigator.clipboard.readText().then(text => {
                    if (socketReady && !closed) socket.emit('terminal_input', { data: text });
                }).catch(() => {});
                return false;
            }
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && term.hasSelection()) {
                navigator.clipboard.writeText(term.getSelection()).catch(() => {});
                return false;
            }
            return true;
        });

        win.el.addEventListener('desktop-window-close', () => {
            closed = true;
            resizeObserver.disconnect();
            socket.disconnect();
            try { term.dispose(); } catch (_) {}
        }, { once: true });

        requestAnimationFrame(() => fitAddon.fit());
        return win;
    }

    return { create };
})();
