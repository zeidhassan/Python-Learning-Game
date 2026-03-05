const { query } = require('../db/pool');

function buildTurnState(room, players, attemptsCount) {
  if (!players.length) {
    return {
      attemptsCount,
      currentTurnIndex: null,
      currentTurnUserId: null,
      currentTurnDisplayName: null,
      roundNumber: 1,
    };
  }

  const currentTurnIndex = attemptsCount % players.length;
  const currentPlayer = players[currentTurnIndex];
  const roundNumber = Math.floor(attemptsCount / players.length) + 1;

  return {
    attemptsCount,
    currentTurnIndex,
    currentTurnUserId: room.status === 'finished' ? null : currentPlayer.userId,
    currentTurnDisplayName: room.status === 'finished' ? null : currentPlayer.displayName,
    roundNumber,
  };
}

async function getRoomStateByCode(roomCode) {
  const roomResult = await query(
    `
      SELECT id, room_code, host_user_id, status, created_at, started_at, ended_at
      FROM game_rooms
      WHERE room_code = $1
    `,
    [roomCode],
  );

  if (roomResult.rowCount === 0) {
    return null;
  }

  const room = roomResult.rows[0];
  const playersResult = await query(
    `
      SELECT rp.id,
             rp.room_id,
             rp.user_id,
             rp.player_order,
             rp.score,
             rp.current_tile,
             rp.joined_at,
             u.display_name,
             u.email
      FROM room_players rp
      JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = $1
      ORDER BY COALESCE(rp.player_order, 9999), rp.joined_at, u.display_name
    `,
    [room.id],
  );

  const players = playersResult.rows.map((player) => ({
      id: player.id,
      userId: player.user_id,
      displayName: player.display_name,
      email: player.email,
      playerOrder: player.player_order,
      score: player.score,
      currentTile: player.current_tile,
      joinedAt: player.joined_at,
    }));

  const attemptsResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM attempts
      WHERE room_id = $1
    `,
    [room.id],
  );

  const attemptsCount = attemptsResult.rows[0]?.count ?? 0;

  return {
    room: {
      id: room.id,
      roomCode: room.room_code,
      hostUserId: room.host_user_id,
      status: room.status,
      createdAt: room.created_at,
      startedAt: room.started_at,
      endedAt: room.ended_at,
    },
    turn: buildTurnState(room, players, attemptsCount),
    players,
  };
}

async function emitRoomState(io, roomCode) {
  if (!io) return;

  const state = await getRoomStateByCode(roomCode);
  if (!state) return;

  io.to(roomCode).emit('room:state', state);
  io.to(roomCode).emit('scoreboard:update', {
    roomCode,
    players: state.players,
  });
}

module.exports = {
  getRoomStateByCode,
  emitRoomState,
};
