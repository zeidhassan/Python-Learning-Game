const express = require('express');
const { z } = require('zod');
const { query, withTransaction } = require('../db/pool');
const { requireAuth } = require('../middleware/require-auth');
const { HttpError } = require('../utils/http-error');
const { generateRoomCode } = require('../utils/room-code');
const { getRoomStateByCode, emitRoomState } = require('../utils/room-state');

const router = express.Router();

const createRoomSchema = z.object({
  roomName: z.string().trim().max(80).optional(),
});

const joinRoomSchema = z.object({
  roomCode: z.string().trim().min(4).max(12).optional(),
});

const scanSchema = z.object({
  qrPayload: z.string().trim().min(1).max(200),
});

const attemptSchema = z.object({
  questionId: z.string().uuid(),
  selectedOptionId: z.string().uuid(),
  responseTimeMs: z.number().int().min(0).max(300000).optional(),
  currentTile: z.number().int().min(1).max(999).optional(),
});

const POINTS_BY_DIFFICULTY = {
  easy: 5,
  medium: 10,
  hard: 15,
};

const SPEED_BONUS_POINTS = 2;
const SPEED_BONUS_MS = 15000;

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) throw result.error;
  return result.data;
}

function normalizeRoomCode(roomCode) {
  return String(roomCode || '').trim().toUpperCase();
}

function getBasePointsForDifficulty(difficulty) {
  return POINTS_BY_DIFFICULTY[String(difficulty || '').toLowerCase()] ?? POINTS_BY_DIFFICULTY.medium;
}

async function getRoomByCode(roomCode) {
  const result = await query(
    `
      SELECT id, room_code, host_user_id, status, created_at, started_at, ended_at
      FROM game_rooms
      WHERE room_code = $1
    `,
    [roomCode],
  );

  return result.rows[0] || null;
}

function ensureRoomIsActiveForGameplay(room) {
  if (room.status === 'lobby') {
    throw new HttpError(409, 'Room has not started yet');
  }

  if (room.status === 'finished') {
    throw new HttpError(409, 'Room has already finished');
  }
}

async function requireRoomMembership(roomId, userId) {
  const result = await query(
    `
      SELECT id, score, current_tile
      FROM room_players
      WHERE room_id = $1 AND user_id = $2
    `,
    [roomId, userId],
  );

  if (result.rowCount === 0) {
    throw new HttpError(403, 'You must join the room first');
  }

  return result.rows[0];
}

async function createUniqueRoomCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const roomCode = generateRoomCode(6);
    const existing = await query('SELECT 1 FROM game_rooms WHERE room_code = $1', [roomCode]);
    if (existing.rowCount === 0) return roomCode;
  }

  throw new HttpError(500, 'Failed to generate a unique room code');
}

async function getScoreboard(roomId) {
  const result = await query(
    `
      SELECT rp.user_id,
             u.display_name,
             rp.score,
             rp.current_tile,
             rp.player_order,
             rp.joined_at
      FROM room_players rp
      JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = $1
      ORDER BY rp.score DESC, COALESCE(rp.player_order, 9999), rp.joined_at
    `,
    [roomId],
  );

  return result.rows.map((row) => ({
    userId: row.user_id,
    displayName: row.display_name,
    score: row.score,
    currentTile: row.current_tile,
    playerOrder: row.player_order,
    joinedAt: row.joined_at,
  }));
}

async function getTurnContext(roomId) {
  const playersResult = await query(
    `
      SELECT rp.user_id, rp.player_order, u.display_name
      FROM room_players rp
      JOIN users u ON u.id = rp.user_id
      WHERE rp.room_id = $1
      ORDER BY COALESCE(rp.player_order, 9999), rp.joined_at, u.display_name
    `,
    [roomId],
  );

  const players = playersResult.rows;
  if (players.length === 0) {
    return {
      playerCount: 0,
      attemptsCount: 0,
      roundNumber: 1,
      currentTurnUserId: null,
      currentTurnDisplayName: null,
      currentTurnIndex: null,
    };
  }

  const attemptsResult = await query(
    `
      SELECT COUNT(*)::int AS count
      FROM attempts
      WHERE room_id = $1
    `,
    [roomId],
  );

  const attemptsCount = attemptsResult.rows[0]?.count ?? 0;
  const currentTurnIndex = attemptsCount % players.length;
  const currentPlayer = players[currentTurnIndex];

  return {
    playerCount: players.length,
    attemptsCount,
    roundNumber: Math.floor(attemptsCount / players.length) + 1,
    currentTurnIndex,
    currentTurnUserId: currentPlayer.user_id,
    currentTurnDisplayName: currentPlayer.display_name,
  };
}

async function hasUserAnsweredQuestionInRoom(roomId, userId, questionId) {
  const result = await query(
    `
      SELECT 1
      FROM attempts
      WHERE room_id = $1
        AND user_id = $2
        AND question_id = $3
      LIMIT 1
    `,
    [roomId, userId, questionId],
  );

  return result.rowCount > 0;
}

async function autoFinishRoomIfAllQuestionsAnswered(roomId) {
  const countsResult = await query(
    `
      SELECT
        (SELECT COUNT(*)::int FROM room_players WHERE room_id = $1) AS player_count,
        (
          SELECT COUNT(DISTINCT bt.question_id)::int
          FROM board_tiles bt
          JOIN questions q ON q.id = bt.question_id
          WHERE bt.is_active = TRUE
            AND bt.question_id IS NOT NULL
            AND q.is_active = TRUE
        ) AS question_count,
        (
          SELECT COUNT(DISTINCT (a.user_id, a.question_id))::int
          FROM attempts a
          WHERE a.room_id = $1
        ) AS answered_pairs_count
    `,
    [roomId],
  );

  const counts = countsResult.rows[0] || {};
  const playerCount = counts.player_count ?? 0;
  const questionCount = counts.question_count ?? 0;
  const answeredPairsCount = counts.answered_pairs_count ?? 0;

  if (playerCount <= 0 || questionCount <= 0) {
    return false;
  }

  const requiredAttempts = playerCount * questionCount;
  if (answeredPairsCount < requiredAttempts) {
    return false;
  }

  const updateResult = await query(
    `
      UPDATE game_rooms
      SET status = 'finished',
          ended_at = COALESCE(ended_at, NOW())
      WHERE id = $1
        AND status <> 'finished'
      RETURNING id
    `,
    [roomId],
  );

  return updateResult.rowCount > 0;
}

function mapQuestionForGameplay(rowGroup) {
  return {
    id: rowGroup.id,
    prompt: rowGroup.prompt,
    difficulty: rowGroup.difficulty,
    questionType: rowGroup.question_type,
    options: rowGroup.options.map((option) => ({
      id: option.id,
      optionText: option.optionText,
      position: option.position,
    })),
  };
}

async function loadQuestionForGameplay(questionId) {
  const result = await query(
    `
      SELECT q.id,
             q.prompt,
             q.difficulty,
             q.question_type,
             q.explanation,
             q.is_active,
             qo.id AS option_id,
             qo.option_text,
             qo.is_correct AS option_is_correct,
             qo.position AS option_position
      FROM questions q
      JOIN question_options qo ON qo.question_id = q.id
      WHERE q.id = $1
      ORDER BY qo.position ASC
    `,
    [questionId],
  );

  if (result.rowCount === 0) return null;

  const first = result.rows[0];
  const grouped = {
    id: first.id,
    prompt: first.prompt,
    difficulty: first.difficulty,
    question_type: first.question_type,
    explanation: first.explanation,
    is_active: first.is_active,
    options: result.rows.map((row) => ({
      id: row.option_id,
      optionText: row.option_text,
      isCorrect: row.option_is_correct,
      position: row.option_position,
    })),
  };

  return grouped;
}

router.post('/', requireAuth, async (req, res) => {
  parseBody(createRoomSchema, req.body || {});

  const roomCode = await createUniqueRoomCode();
  const userId = req.session.user.id;

  await withTransaction(async (client) => {
    const roomResult = await client.query(
      `
        INSERT INTO game_rooms (room_code, host_user_id, status)
        VALUES ($1, $2, 'lobby')
        RETURNING id
      `,
      [roomCode, userId],
    );

    const roomId = roomResult.rows[0].id;
    await client.query(
      `
        INSERT INTO room_players (room_id, user_id, player_order, score, current_tile)
        VALUES ($1, $2, 1, 0, 1)
      `,
      [roomId, userId],
    );
  });

  const state = await getRoomStateByCode(roomCode);
  res.status(201).json(state);
});

router.post('/:roomCode/join', requireAuth, async (req, res) => {
  const body = parseBody(joinRoomSchema, req.body || {});
  const roomCode = normalizeRoomCode(req.params.roomCode || body.roomCode);

  if (!roomCode) {
    throw new HttpError(400, 'Room code is required');
  }

  const room = await getRoomByCode(roomCode);
  if (!room) {
    throw new HttpError(404, 'Room not found');
  }

  if (room.status === 'finished') {
    throw new HttpError(409, 'Room has already finished');
  }

  const userId = req.session.user.id;

  await withTransaction(async (client) => {
    const existing = await client.query(
      'SELECT id FROM room_players WHERE room_id = $1 AND user_id = $2',
      [room.id, userId],
    );

    if (existing.rowCount === 0) {
      const orderResult = await client.query(
        'SELECT COALESCE(MAX(player_order), 0) + 1 AS next_order FROM room_players WHERE room_id = $1',
        [room.id],
      );

      await client.query(
        `
          INSERT INTO room_players (room_id, user_id, player_order, score, current_tile)
          VALUES ($1, $2, $3, 0, 1)
        `,
        [room.id, userId, orderResult.rows[0].next_order],
      );
    }
  });

  const io = req.app.get('io');
  await emitRoomState(io, roomCode);

  const state = await getRoomStateByCode(roomCode);
  res.json(state);
});

router.get('/:roomCode', requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const state = await getRoomStateByCode(roomCode);

  if (!state) {
    throw new HttpError(404, 'Room not found');
  }

  await requireRoomMembership(state.room.id, req.session.user.id);
  res.json(state);
});

router.post('/:roomCode/start', requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const room = await getRoomByCode(roomCode);

  if (!room) {
    throw new HttpError(404, 'Room not found');
  }

  if (room.host_user_id !== req.session.user.id) {
    throw new HttpError(403, 'Only the host can start the room');
  }

  if (room.status === 'finished') {
    throw new HttpError(409, 'Room has already finished');
  }

  const result = await query(
    `
      UPDATE game_rooms
      SET status = 'active',
          started_at = COALESCE(started_at, NOW())
      WHERE id = $1
      RETURNING id
    `,
    [room.id],
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, 'Room not found');
  }

  const io = req.app.get('io');
  await emitRoomState(io, roomCode);

  const state = await getRoomStateByCode(roomCode);
  res.json(state);
});

router.post('/:roomCode/finish', requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const room = await getRoomByCode(roomCode);

  if (!room) {
    throw new HttpError(404, 'Room not found');
  }

  if (room.host_user_id !== req.session.user.id) {
    throw new HttpError(403, 'Only the host can finish the room');
  }

  if (room.status === 'finished') {
    const existingState = await getRoomStateByCode(roomCode);
    res.json(existingState);
    return;
  }

  await query(
    `
      UPDATE game_rooms
      SET status = 'finished',
          ended_at = COALESCE(ended_at, NOW())
      WHERE id = $1
    `,
    [room.id],
  );

  const io = req.app.get('io');
  await emitRoomState(io, roomCode);

  const state = await getRoomStateByCode(roomCode);
  res.json(state);
});

router.get('/:roomCode/scoreboard', requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const room = await getRoomByCode(roomCode);

  if (!room) {
    throw new HttpError(404, 'Room not found');
  }

  await requireRoomMembership(room.id, req.session.user.id);
  const state = await getRoomStateByCode(roomCode);
  res.json(state);
});

router.post('/:roomCode/scan', requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const { qrPayload } = parseBody(scanSchema, req.body);

  const room = await getRoomByCode(roomCode);
  if (!room) {
    throw new HttpError(404, 'Room not found');
  }

  ensureRoomIsActiveForGameplay(room);

  await requireRoomMembership(room.id, req.session.user.id);
  const turnContext = await getTurnContext(room.id);

  if (turnContext.currentTurnUserId && turnContext.currentTurnUserId !== req.session.user.id) {
    throw new HttpError(409, `It is currently ${turnContext.currentTurnDisplayName}'s turn`);
  }

  const tileResult = await query(
    `
      SELECT bt.id,
             bt.tile_number,
             bt.qr_payload,
             bt.is_active,
             bt.question_id
      FROM board_tiles bt
      WHERE bt.qr_payload = $1
    `,
    [qrPayload],
  );

  if (tileResult.rowCount === 0) {
    throw new HttpError(404, 'QR payload not recognized');
  }

  const tile = tileResult.rows[0];
  if (!tile.is_active || !tile.question_id) {
    throw new HttpError(409, 'This board tile is inactive');
  }

  const question = await loadQuestionForGameplay(tile.question_id);
  if (!question || !question.is_active) {
    throw new HttpError(404, 'Question for this tile is not available');
  }

  const alreadyAnswered = await hasUserAnsweredQuestionInRoom(
    room.id,
    req.session.user.id,
    question.id,
  );
  if (alreadyAnswered) {
    throw new HttpError(
      409,
      'You already answered this question in this room. This tile is mapped to a repeated question.',
    );
  }

  res.json({
    tileNumber: tile.tile_number,
    qrPayload: tile.qr_payload,
    turn: turnContext,
    question: mapQuestionForGameplay(question),
  });
});

router.post('/:roomCode/attempts', requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const payload = parseBody(attemptSchema, req.body);
  const userId = req.session.user.id;

  const room = await getRoomByCode(roomCode);
  if (!room) {
    throw new HttpError(404, 'Room not found');
  }

  ensureRoomIsActiveForGameplay(room);

  const membership = await requireRoomMembership(room.id, userId);
  const turnContext = await getTurnContext(room.id);

  if (turnContext.currentTurnUserId && turnContext.currentTurnUserId !== userId) {
    throw new HttpError(409, `It is currently ${turnContext.currentTurnDisplayName}'s turn`);
  }

  const alreadyAnswered = await hasUserAnsweredQuestionInRoom(room.id, userId, payload.questionId);
  if (alreadyAnswered) {
    throw new HttpError(409, 'You have already answered this question in this room');
  }

  const optionResult = await query(
    `
      SELECT qo.id,
             qo.question_id,
             qo.is_correct,
             q.explanation,
             q.difficulty,
             q.is_active
      FROM question_options qo
      JOIN questions q ON q.id = qo.question_id
      WHERE qo.id = $1
    `,
    [payload.selectedOptionId],
  );

  if (optionResult.rowCount === 0) {
    throw new HttpError(400, 'Selected option does not exist');
  }

  const option = optionResult.rows[0];
  if (option.question_id !== payload.questionId) {
    throw new HttpError(400, 'Selected option does not belong to the question');
  }

  if (!option.is_active) {
    throw new HttpError(409, 'Question is inactive');
  }

  const isCorrect = option.is_correct;
  const difficulty = String(option.difficulty || 'medium').toLowerCase();
  const basePoints = isCorrect ? getBasePointsForDifficulty(difficulty) : 0;
  const bonus =
    isCorrect && payload.responseTimeMs !== undefined && payload.responseTimeMs <= SPEED_BONUS_MS
      ? SPEED_BONUS_POINTS
      : 0;
  const awardedPoints = basePoints + bonus;

  await withTransaction(async (client) => {
    await client.query(
      `
        INSERT INTO attempts (
          room_id,
          user_id,
          question_id,
          selected_option_id,
          is_correct,
          response_time_ms,
          awarded_points
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        room.id,
        userId,
        payload.questionId,
        payload.selectedOptionId,
        isCorrect,
        payload.responseTimeMs ?? null,
        awardedPoints,
      ],
    );

    const nextTile = payload.currentTile ?? membership.current_tile;
    await client.query(
      `
        UPDATE room_players
        SET score = score + $1,
            current_tile = $2
        WHERE room_id = $3 AND user_id = $4
      `,
      [awardedPoints, nextTile, room.id, userId],
    );
  });

  const roomAutoFinished = await autoFinishRoomIfAllQuestionsAnswered(room.id);
  const updatedState = await getRoomStateByCode(roomCode);
  const players = updatedState?.players || (await getScoreboard(room.id));
  const io = req.app.get('io');
  if (io) {
    await emitRoomState(io, roomCode);
    io.to(roomCode).emit('attempt:result', {
      roomCode,
      userId,
      questionId: payload.questionId,
      isCorrect,
      awardedPoints,
      difficulty,
      basePoints,
      bonusPoints: bonus,
      roomAutoFinished,
      nextTurnUserId: updatedState?.turn?.currentTurnUserId || null,
      nextTurnDisplayName: updatedState?.turn?.currentTurnDisplayName || null,
    });
  }

  res.json({
    isCorrect,
    awardedPoints,
    explanation: option.explanation,
    scoring: {
      difficulty,
      basePoints,
      bonusPoints: bonus,
      speedBonusApplied: bonus > 0,
      speedBonusThresholdMs: SPEED_BONUS_MS,
    },
    roomAutoFinished,
    roomStatus: updatedState?.room?.status || room.status,
    turn: updatedState?.turn || null,
    scoreboard: players,
  });
});

router.get('/:roomCode/history', requireAuth, async (req, res) => {
  const roomCode = normalizeRoomCode(req.params.roomCode);
  const room = await getRoomByCode(roomCode);
  if (!room) {
    throw new HttpError(404, 'Room not found');
  }

  await requireRoomMembership(room.id, req.session.user.id);

  const result = await query(
    `
      SELECT a.id,
             a.user_id,
             u.display_name,
             a.question_id,
             q.prompt,
             a.is_correct,
             a.awarded_points,
             a.response_time_ms,
             a.created_at
      FROM attempts a
      JOIN users u ON u.id = a.user_id
      JOIN questions q ON q.id = a.question_id
      WHERE a.room_id = $1
      ORDER BY a.created_at DESC
      LIMIT 50
    `,
    [room.id],
  );

  res.json({
    attempts: result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      displayName: row.display_name,
      questionId: row.question_id,
      prompt: row.prompt,
      isCorrect: row.is_correct,
      awardedPoints: row.awarded_points,
      responseTimeMs: row.response_time_ms,
      createdAt: row.created_at,
    })),
  });
});

module.exports = router;
