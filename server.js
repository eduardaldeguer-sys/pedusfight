const express = require('express');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static('.'));

let players = [];

wss.on('connection', (ws) => {
    if (players.length >= 2) {
        ws.close();
        return;
    }

    players.push(ws);
    ws.playerId = players.length;

    ws.send(JSON.stringify({
        type: 'init',
        playerId: ws.playerId
    }));

    ws.on('message', (message) => {
        players.forEach(player => {
            if (player !== ws && player.readyState === WebSocket.OPEN) {
                player.send(message);
            }
        });
    });

    ws.on('close', () => {
        players = players.filter(p => p !== ws);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log("Servidor iniciado en puerto " + PORT);
});
