const { Server } = require('socket.io');
const { config } = require('../config/env');

function initializeSocket(httpServer) {
  const io = new Server(httpServer, {
    cors: {
      origin: config.clientOrigin,
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    socket.emit('socket:ready', { socketId: socket.id });

    socket.on('room:join', (payload = {}) => {
      const roomCode = String(payload.roomCode || '').trim().toUpperCase();
      if (!roomCode) return;

      socket.join(roomCode);
      io.to(roomCode).emit('room:presence', {
        roomCode,
        socketId: socket.id,
        action: 'join',
      });
    });

    socket.on('room:leave', (payload = {}) => {
      const roomCode = String(payload.roomCode || '').trim().toUpperCase();
      if (!roomCode) return;

      socket.leave(roomCode);
      io.to(roomCode).emit('room:presence', {
        roomCode,
        socketId: socket.id,
        action: 'leave',
      });
    });
  });

  return io;
}

module.exports = {
  initializeSocket,
};

