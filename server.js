const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: { origin: "*" }
});

app.use(express.static('public'));

const rooms = {};

io.on('connection', (socket) => {
    // Host creates a room
    socket.on('create-room', (roomId) => {
        rooms[roomId] = { host: socket.id, guest: null, frameColor: null, ready: { host: false, guest: false } };
        socket.join(roomId);
        socket.emit('room-created', roomId);
    });

    // Guest joins a room
    socket.on('join-room', (roomId) => {
        if (rooms[roomId]) {
            if (!rooms[roomId].guest) {
                rooms[roomId].guest = socket.id;
                socket.join(roomId);
                socket.emit('join-success', roomId);
                // Notify the host that guest has joined
                io.to(rooms[roomId].host).emit('guest-joined');
            } else {
                socket.emit('room-error', 'Room is full.');
            }
        } else {
            socket.emit('room-error', 'Room not found.');
        }
    });

    // WebRTC Signaling
    socket.on('signal', (data) => {
        socket.to(data.room).emit('signal', {
            sender: socket.id,
            signal: data.signal
        });
    });

    // Host selects a frame color
    socket.on('select-frame', ({ room, color }) => {
        if (rooms[room] && rooms[room].host === socket.id) {
            rooms[room].frameColor = color;
            rooms[room].ready = { host: false, guest: false };
            io.to(room).emit('start-booth', color);
        }
    });

    socket.on('start-session-request', ({ room, action }) => {
        if (!rooms[room]) return;
        io.to(room).emit('begin-session', action || 'start');
    });

    socket.on('disconnect', () => {
        for (const roomId in rooms) {
            if (rooms[roomId].host === socket.id || rooms[roomId].guest === socket.id) {
                io.to(roomId).emit('peer-disconnected');
                delete rooms[roomId];
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});