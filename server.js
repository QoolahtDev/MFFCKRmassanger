const path = require('path');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const ROOM_CODE_LENGTH = 6;
const ROOM_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const MAX_MESSAGES_PER_ROOM = 200;

const rooms = Object.create(null);

app.use(express.json());
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));

app.get('/', (_, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.post('/api/create-room', (_, res) => {
  const roomCode = createRoom();
  res.json({ roomCode });
});

io.on('connection', (socket) => {
  socket.emit('session', { socketId: socket.id });

  socket.on('joinRoom', (payload = {}, callback = () => {}) => {
    const roomCode = normalizeRoomCode(payload.roomCode);
    const name = sanitizeName(payload.name);

    if (!roomCode || !name) {
      return callback({ ok: false, error: 'Некорректные данные' });
    }

    const room = rooms[roomCode];
    if (!room) {
      return callback({ ok: false, error: 'Комната не найдена' });
    }

    leaveRoom(socket);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.displayName = name;

    room.users[socket.id] = {
      name,
      inVoice: false,
      speaking: false
    };

    socket.emit('roomHistory', room.messages);
    emitRoomUsers(roomCode);
    callback({ ok: true, roomCode });
  });

  socket.on('leaveRoom', () => {
    const prevRoom = socket.data.roomCode;
    leaveRoom(socket);
    if (prevRoom) {
      socket.emit('leftRoom', { roomCode: prevRoom });
    }
  });

  socket.on('chatMessage', (payload = {}, callback = () => {}) => {
    const text = String(payload.text || '').trim();
    const roomCode = normalizeRoomCode(payload.roomCode || socket.data.roomCode);

    if (!text || !roomCode) {
      return callback({ ok: false });
    }

    const room = rooms[roomCode];
    const user = room?.users?.[socket.id];
    if (!room || !user) {
      return callback({ ok: false });
    }

    const message = {
      id: createMessageId(),
      senderId: socket.id,
      name: user.name,
      text,
      timestamp: Date.now()
    };

    room.messages.push(message);
    if (room.messages.length > MAX_MESSAGES_PER_ROOM) {
      room.messages.shift();
    }

    io.to(roomCode).emit('chatMessage', message);
    callback({ ok: true });
  });

  socket.on('voice:join', () => toggleVoice(socket, true));
  socket.on('voice:leave', () => toggleVoice(socket, false));

  socket.on('voice:activity', (payload = {}) => {
    const roomCode = socket.data.roomCode;
    const room = rooms[roomCode];
    const user = room?.users?.[socket.id];

    if (!room || !user || !user.inVoice) return;

    user.speaking = Boolean(payload.speaking);
    io.to(roomCode).emit('voice:activity', { socketId: socket.id, speaking: user.speaking });
  });

  socket.on('webrtc-offer', (payload = {}) => relaySignal(socket, 'webrtc-offer', payload));
  socket.on('webrtc-answer', (payload = {}) => relaySignal(socket, 'webrtc-answer', payload));
  socket.on('webrtc-ice', (payload = {}) => relaySignal(socket, 'webrtc-ice', payload));

  socket.on('disconnect', () => leaveRoom(socket));
});

function createRoom() {
  let code;
  do {
    code = generateRoomCode();
  } while (rooms[code]);

  rooms[code] = {
    createdAt: Date.now(),
    users: {},
    messages: []
  };

  return code;
}

function generateRoomCode() {
  let result = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const idx = randomIndex(ROOM_CODE_CHARS.length);
    result += ROOM_CODE_CHARS[idx];
  }
  return result;
}

function normalizeRoomCode(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

function sanitizeName(raw) {
  return String(raw || '').trim().slice(0, 32);
}

function emitRoomUsers(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  const payload = Object.entries(room.users).map(([id, user]) => ({
    id,
    name: user.name,
    inVoice: Boolean(user.inVoice),
    speaking: Boolean(user.speaking)
  }));

  io.to(roomCode).emit('roomUsers', payload);
}

function leaveRoom(socket) {
  const roomCode = socket.data.roomCode;
  if (!roomCode) return;

  const room = rooms[roomCode];
  if (!room) {
    socket.leave(roomCode);
    socket.data.roomCode = undefined;
    return;
  }

  delete room.users[socket.id];
  socket.leave(roomCode);
  socket.data.roomCode = undefined;

  if (!Object.keys(room.users).length) {
    delete rooms[roomCode];
    return;
  }

  io.to(roomCode).emit('userLeft', { socketId: socket.id });
  emitRoomUsers(roomCode);
}

function toggleVoice(socket, value) {
  const roomCode = socket.data.roomCode;
  const room = rooms[roomCode];
  const user = room?.users?.[socket.id];

  if (!room || !user) return;

  user.inVoice = Boolean(value);
  if (!user.inVoice) {
    user.speaking = false;
  }

  emitRoomUsers(roomCode);
}

function relaySignal(socket, eventName, payload) {
  const targetId = payload?.targetId;
  if (!targetId) return;

  const roomCode = socket.data.roomCode;
  const room = rooms[roomCode];
  const sender = room?.users?.[socket.id];
  const target = room?.users?.[targetId];

  if (!room || !sender || !target || !sender.inVoice || !target.inVoice) return;

  io.to(targetId).emit(eventName, {
    from: socket.id,
    sdp: payload.sdp,
    candidate: payload.candidate
  });
}

function createMessageId() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function randomIndex(max) {
  if (typeof crypto.randomInt === 'function') {
    return crypto.randomInt(max);
  }
  return Math.floor(Math.random() * max);
}

server.listen(PORT, () => {
  const { port } = server.address();
  console.log(`MFFCKRmassanger server running on http://localhost:${port}`);
});
