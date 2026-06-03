const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

// ========== 静态文件服务 ==========
const PORT = process.env.PORT || 3000;
const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    } else if (req.url === '/api/url') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ url: publicUrl }));
    } else {
        res.writeHead(404);
        res.end('Not Found');
    }
});

let publicUrl = ''; // 存储公网地址

const wss = new WebSocketServer({ server });

// ========== 游戏房间状态 ==========
let waitingPlayer = null;
let waitingCoopPlayer = null;
const rooms = new Map();
let roomCounter = 0;

// ========== WebSocket 连接处理 ==========
wss.on('connection', (ws) => {
    ws.playerIndex = -1;
    ws.roomId = null;

    ws.on('message', (data) => {
        let msg;
        try { msg = JSON.parse(data); } catch { return; }

        switch (msg.type) {
            case 'join': handleJoin(ws); break;
            case 'ready': handleReady(ws); break;
            case 'result': handleResult(ws, msg); break;
            case 'rematch': handleRematch(ws); break;
            case 'end': handleEnd(ws); break;
            case 'join_coop': handleJoinCoop(ws); break;
            case 'coop_input': handleCoopInput(ws, msg); break;
            case 'coop_state': handleCoopState(ws, msg); break;
            case 'coop_gameover': handleCoopGameOver(ws, msg); break;
            case 'coop_victory': handleCoopVictory(ws, msg); break;
        }
    });

    ws.on('close', () => handleDisconnect(ws));
});

// ========== 匹配逻辑 ==========
function handleJoin(ws) {
    if (waitingPlayer && waitingPlayer.readyState === 1) {
        const roomId = 'room_' + (++roomCounter);
        const room = {
            id: roomId,
            players: [waitingPlayer, ws],
            results: [null, null],
            ready: [false, false],
            rematch: [false, false],
            wins: [0, 0],
            totalGames: 0,
            state: 'matched',
            countdownTimer: null
        };

        waitingPlayer.playerIndex = 0;
        waitingPlayer.roomId = roomId;
        ws.playerIndex = 1;
        ws.roomId = roomId;

        rooms.set(roomId, room);
        waitingPlayer = null;

        broadcast(room, { type: 'matched', roomId });
    } else {
        waitingPlayer = ws;
        ws.send(JSON.stringify({ type: 'waiting' }));
    }
}

// ========== 协同模式匹配 ==========
function handleJoinCoop(ws) {
    if (waitingCoopPlayer && waitingCoopPlayer.readyState === 1) {
        const roomId = 'coop_' + (++roomCounter);
        const room = {
            id: roomId,
            mode: 'coop',
            players: [waitingCoopPlayer, ws],
            ready: [false, false],
            seed: Math.floor(Math.random() * 999999),
            state: 'matched',
            countdownTimer: null
        };

        waitingCoopPlayer.playerIndex = 0;
        waitingCoopPlayer.roomId = roomId;
        ws.playerIndex = 1;
        ws.roomId = roomId;

        rooms.set(roomId, room);
        waitingCoopPlayer = null;

        for (let i = 0; i < 2; i++) {
            room.players[i].send(JSON.stringify({ type: 'matched_coop', roomId, playerIndex: i }));
        }
    } else {
        waitingCoopPlayer = ws;
        ws.send(JSON.stringify({ type: 'waiting' }));
    }
}

// ========== 协同输入转发 (guest→host) ==========
function handleCoopInput(ws, msg) {
    const room = rooms.get(ws.roomId);
    if (!room || room.mode !== 'coop') return;
    const host = room.players[0];
    if (host.readyState === 1) {
        host.send(JSON.stringify(msg));
    }
}

// ========== 协同状态转发 (host→guest) ==========
function handleCoopState(ws, msg) {
    const room = rooms.get(ws.roomId);
    if (!room || room.mode !== 'coop') return;
    if (ws.playerIndex !== 0) return;
    const guest = room.players[1];
    if (guest.readyState === 1) {
        guest.send(JSON.stringify(msg));
    }
}

// ========== 协同游戏结束 ==========
function handleCoopGameOver(ws, msg) {
    const room = rooms.get(ws.roomId);
    if (!room || room.mode !== 'coop') return;
    broadcast(room, { type: 'coop_gameover', score: msg.score });
    room.state = 'done';
    room.cleanupTimer = setTimeout(() => rooms.delete(room.id), 30000);
}

// ========== 协同胜利 ==========
function handleCoopVictory(ws, msg) {
    const room = rooms.get(ws.roomId);
    if (!room || room.mode !== 'coop') return;
    broadcast(room, { type: 'coop_victory', score: msg.score, frames: msg.frames });
    room.state = 'done';
    room.cleanupTimer = setTimeout(() => rooms.delete(room.id), 30000);
}

// ========== 双方确认就绪 ==========
function handleReady(ws) {
    const room = rooms.get(ws.roomId);
    if (!room || room.state !== 'matched') return;

    room.ready[ws.playerIndex] = true;

    // 通知对方已就绪
    const other = room.players[1 - ws.playerIndex];
    if (other.readyState === 1) {
        other.send(JSON.stringify({ type: 'opponent_ready' }));
    }

    // 双方都确认，开始倒计时
    if (room.ready[0] && room.ready[1]) {
        room.state = 'countdown';
        startCountdown(room);
    }
}

// ========== 倒计时 ==========
function startCountdown(room) {
    let count = 3;
    broadcast(room, { type: 'countdown', count });

    room.countdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
            broadcast(room, { type: 'countdown', count });
        } else {
            clearInterval(room.countdownTimer);
            room.state = 'playing';
            if (room.mode === 'coop') {
                broadcast(room, { type: 'coop_start', seed: room.seed });
            } else {
                broadcast(room, { type: 'start' });
            }
        }
    }, 1000);
}

// ========== 结果处理 ==========
function handleResult(ws, msg) {
    const room = rooms.get(ws.roomId);
    if (!room || room.state === 'done') return;

    room.results[ws.playerIndex] = {
        outcome: msg.outcome,
        score: msg.score,
        frames: msg.frames
    };

    const otherIndex = 1 - ws.playerIndex;

    if (!room.results[otherIndex]) {
        const other = room.players[otherIndex];
        if (other.readyState === 1) {
            other.send(JSON.stringify({
                type: 'opponent_result',
                outcome: msg.outcome,
                score: msg.score,
                frames: msg.frames
            }));
        }
        room.state = 'collecting';
    }

    if (room.results[0] && room.results[1]) {
        room.state = 'done';
        const comparison = compareResults(room.results[0], room.results[1]);

        // 更新比分
        room.totalGames++;
        if (comparison.winner !== 'draw') {
            room.wins[comparison.winner]++;
        }

        for (let i = 0; i < 2; i++) {
            const winner = comparison.winner;
            let personalWinner;
            if (winner === 'draw') personalWinner = 'draw';
            else if (winner === i) personalWinner = 'self';
            else personalWinner = 'opponent';

            room.players[i].send(JSON.stringify({
                type: 'battle_result',
                winner: personalWinner,
                self: room.results[i],
                opponent: room.results[1 - i]
            }));

            // 发送比分更新
            room.players[i].send(JSON.stringify({
                type: 'score_update',
                myWins: room.wins[i],
                totalGames: room.totalGames
            }));
        }

        room.cleanupTimer = setTimeout(() => rooms.delete(room.id), 30000);
    }
}

// ========== 结果比较 ==========
function compareResults(r1, r2) {
    if (r1.outcome === 'victory' && r2.outcome === 'victory') {
        if (r1.frames < r2.frames) return { winner: 0 };
        if (r2.frames < r1.frames) return { winner: 1 };
        return { winner: 'draw' };
    }
    if (r1.outcome === 'victory') return { winner: 0 };
    if (r2.outcome === 'victory') return { winner: 1 };
    if (r1.score > r2.score) return { winner: 0 };
    if (r2.score > r1.score) return { winner: 1 };
    return { winner: 'draw' };
}

// ========== 断线处理 ==========
function handleDisconnect(ws) {
    if (waitingPlayer === ws) {
        waitingPlayer = null;
        return;
    }
    if (waitingCoopPlayer === ws) {
        waitingCoopPlayer = null;
        return;
    }

    const room = rooms.get(ws.roomId);
    if (!room) return;

    const otherIndex = 1 - ws.playerIndex;
    const other = room.players[otherIndex];

    if (room.mode === 'coop') {
        if (other.readyState === 1) {
            if (ws.playerIndex === 0) {
                other.send(JSON.stringify({ type: 'coop_host_disconnect' }));
            } else {
                other.send(JSON.stringify({ type: 'coop_partner_disconnect' }));
            }
        }
        room.state = 'done';
        room.cleanupTimer = setTimeout(() => rooms.delete(room.id), 30000);
        return;
    }

    if (room.state === 'playing' || room.state === 'countdown' || room.state === 'collecting') {
        if (!room.results[ws.playerIndex]) {
            room.results[ws.playerIndex] = { outcome: 'disconnect', score: 0, frames: 0 };
        }

        if (other.readyState === 1) {
            if (room.results[otherIndex]) {
                other.send(JSON.stringify({
                    type: 'battle_result',
                    winner: 'self',
                    self: room.results[otherIndex],
                    opponent: room.results[ws.playerIndex]
                }));
            } else {
                other.send(JSON.stringify({ type: 'opponent_result', outcome: 'disconnect' }));
            }
        }

        room.state = 'done';
        room.cleanupTimer = setTimeout(() => rooms.delete(room.id), 30000);
    }
}

// ========== 再来一局 ==========
function handleRematch(ws) {
    const room = rooms.get(ws.roomId);
    if (!room || room.state !== 'done') return;

    room.rematch[ws.playerIndex] = true;

    const other = room.players[1 - ws.playerIndex];
    if (other.readyState === 1) {
        other.send(JSON.stringify({ type: 'opponent_rematch' }));
    }

    // 双方都选择再来一局
    if (room.rematch[0] && room.rematch[1]) {
        if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
        room.results = [null, null];
        room.ready = [false, false];
        room.rematch = [false, false];
        room.state = 'matched';
        broadcast(room, { type: 'restart' });
    }
}

// ========== 结束对战 ==========
function handleEnd(ws) {
    const room = rooms.get(ws.roomId);
    if (!room) return;

    const other = room.players[1 - ws.playerIndex];
    if (other.readyState === 1) {
        other.send(JSON.stringify({ type: 'opponent_end' }));
    }

    rooms.delete(room.id);
    shutdownServer();
}

// ========== 关闭服务器 ==========
function shutdownServer() {
    console.log('\n  对战结束，正在关闭服务器...');
    for (const room of rooms.values()) {
        for (const p of room.players) {
            if (p.readyState === 1) p.close();
        }
    }
    wss.close(() => {
        server.close(() => {
            console.log('  服务器已关闭，端口已释放\n');
            process.exit(0);
        });
    });
    // 兜底：3秒后强制退出
    setTimeout(() => process.exit(0), 3000);
}

// ========== 广播 ==========
function broadcast(room, msg) {
    const data = JSON.stringify(msg);
    for (const p of room.players) {
        if (p.readyState === 1) p.send(data);
    }
}

// ========== 启动服务器 ==========
server.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`  魂斗罗 双人对战服务器已启动`);
    console.log(`========================================`);
    console.log(`  本地地址: http://localhost:${PORT}`);
    console.log(`========================================\n`);

    // 尝试启动内网穿透
    startTunnel();
});

// ========== 内网穿透 ==========
function startTunnel() {
    const { spawn } = require('child_process');
    const ssh = spawn('ssh', ['-o', 'StrictHostKeyChecking=no', '-R', `80:localhost:${PORT}`, 'localhost.run'], {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let found = false;
    const timeout = setTimeout(() => {
        if (!found) {
            console.log(`\n  [提示] localhost.run 连接超时，仅限局域网访问\n`);
            printLanInfo();
        }
    }, 15000);

    const parseUrl = (data) => {
        const str = data.toString();
        const match = str.match(/(https:\/\/[a-z0-9]+\.lhr\.life)/);
        if (match && !found) {
            found = true;
            clearTimeout(timeout);
            publicUrl = match[1];
            console.log(`\n========================================`);
            console.log(`  公网地址（可分享给对手）:`);
            console.log(`  ${match[1]}`);
            console.log(`========================================\n`);
            console.log(`  对手在浏览器打开此地址，点击"双人对战"即可匹配\n`);
        }
    };

    ssh.stdout.on('data', parseUrl);
    ssh.stderr.on('data', parseUrl);

    ssh.on('close', () => {
        if (found) {
            console.log('  内网穿透隧道已关闭');
            publicUrl = '';
        }
    });
}

function printLanInfo() {
    console.log(`========================================`);
    console.log(`  如需公网联机，请执行以下任一操作:`);
    console.log(`  `);
    console.log(`  方式A: 同一局域网直接用本机IP访问（见下方）`);
    console.log(`  方式B: 另开终端运行: ssh -R 80:localhost:3000 localhost.run`);
    console.log(`  `);
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                console.log(`  局域网地址: http://${net.address}:${PORT}`);
            }
        }
    }
    console.log(`========================================\n`);
}
