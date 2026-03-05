const express = require('express');
const { z } = require('zod');
const QRCode = require('qrcode');
const { query } = require('../db/pool');
const { requireAuth } = require('../middleware/require-auth');
const { requireAdmin } = require('../middleware/require-admin');
const { HttpError } = require('../utils/http-error');

const router = express.Router();

const BOARD_PRINT_QR_WIDTH = 240;
const BOARD_QR_PAYLOAD_PATTERN = /^[A-Z0-9:_-]{3,120}$/;

const updateBoardTileSchema = z.object({
  questionId: z.string().uuid().nullable().optional(),
  qrPayload: z.string().trim().min(3).max(120).optional(),
  isActive: z.boolean().optional(),
});

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw result.error;
  }
  return result.data;
}

function parseTileNumberParam(rawValue) {
  const tileNumber = Number(rawValue);
  if (!Number.isInteger(tileNumber) || tileNumber < 1) {
    throw new HttpError(400, 'Invalid tile number');
  }
  return tileNumber;
}

router.get('/board-tiles', requireAuth, async (req, res) => {
  const result = await query(
    `
      SELECT bt.id,
             bt.tile_number,
             bt.qr_payload,
             bt.is_active,
             bt.question_id,
             q.prompt,
             q.difficulty,
             q.is_active AS question_is_active
      FROM board_tiles bt
      LEFT JOIN questions q ON q.id = bt.question_id
      ORDER BY bt.tile_number ASC
    `,
  );

  res.json({
    boardTiles: result.rows.map((row) => ({
      id: row.id,
      tileNumber: row.tile_number,
      qrPayload: row.qr_payload,
      isActive: row.is_active,
      questionId: row.question_id,
      questionPrompt: row.prompt,
      questionDifficulty: row.difficulty || null,
      questionIsActive: row.question_is_active ?? null,
    })),
  });
});

router.get('/board-tiles/print-sheet', requireAuth, async (req, res) => {
  const result = await query(
    `
      SELECT bt.id,
             bt.tile_number,
             bt.qr_payload,
             bt.question_id
      FROM board_tiles bt
      WHERE bt.is_active = TRUE
      ORDER BY bt.tile_number ASC
    `,
  );

  const seenQuestionIds = new Set();
  const printRows = result.rows.filter((row) => {
    if (!row.question_id) {
      return true;
    }
    if (seenQuestionIds.has(row.question_id)) {
      return false;
    }
    seenQuestionIds.add(row.question_id);
    return true;
  });

  const tiles = await Promise.all(
    printRows.map(async (row) => {
      const qrDataUrl = await QRCode.toDataURL(row.qr_payload, {
        margin: 1,
        width: BOARD_PRINT_QR_WIDTH,
      });

      return {
        id: row.id,
        tileNumber: row.tile_number,
        qrPayload: row.qr_payload,
        qrDataUrl,
      };
    }),
  );

  res.json({
    board: {
      title: 'Function Quest Race',
      generatedAt: new Date().toISOString(),
      scoring: {
        easy: 5,
        medium: 10,
        hard: 15,
        speedBonusPoints: 2,
        speedBonusMaxMs: 15000,
      },
    },
    tiles,
  });
});

router.patch('/board-tiles/:tileNumber', requireAdmin, async (req, res) => {
  const tileNumber = parseTileNumberParam(req.params.tileNumber);
  const payload = parseBody(updateBoardTileSchema, req.body);

  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, 'No board tile fields provided for update');
  }

  const existingResult = await query(
    `
      SELECT id, tile_number, qr_payload, is_active, question_id
      FROM board_tiles
      WHERE tile_number = $1
    `,
    [tileNumber],
  );

  if (existingResult.rowCount === 0) {
    throw new HttpError(404, 'Board tile not found');
  }

  const existing = existingResult.rows[0];
  let nextQuestionId = existing.question_id;

  if (payload.questionId !== undefined) {
    if (payload.questionId === null) {
      nextQuestionId = null;
    } else {
      const questionResult = await query(
        `
          SELECT id, is_active
          FROM questions
          WHERE id = $1
        `,
        [payload.questionId],
      );

      if (questionResult.rowCount === 0) {
        throw new HttpError(404, 'Question not found');
      }

      if (!questionResult.rows[0].is_active) {
        throw new HttpError(409, 'Cannot assign an inactive question to a board tile');
      }

      nextQuestionId = questionResult.rows[0].id;
    }
  }

  let nextQrPayload = existing.qr_payload;
  if (payload.qrPayload !== undefined) {
    nextQrPayload = payload.qrPayload.trim().toUpperCase();
    if (!BOARD_QR_PAYLOAD_PATTERN.test(nextQrPayload)) {
      throw new HttpError(
        400,
        'QR payload must be 3-120 characters and use only letters, numbers, colon, underscore, or hyphen',
      );
    }
  }

  const nextIsActive = payload.isActive ?? existing.is_active;

  if (nextIsActive && !nextQuestionId) {
    throw new HttpError(400, 'Active board tiles must be assigned to a question');
  }

  if (nextIsActive && nextQuestionId) {
    const duplicateQuestionTileResult = await query(
      `
        SELECT tile_number
        FROM board_tiles
        WHERE question_id = $1
          AND is_active = TRUE
          AND tile_number <> $2
        LIMIT 1
      `,
      [nextQuestionId, tileNumber],
    );

    if (duplicateQuestionTileResult.rowCount > 0) {
      throw new HttpError(
        409,
        `That question is already assigned to active tile ${duplicateQuestionTileResult.rows[0].tile_number}`,
      );
    }
  }

  const updatedResult = await query(
    `
      UPDATE board_tiles
      SET question_id = $1,
          qr_payload = $2,
          is_active = $3
      WHERE tile_number = $4
      RETURNING id, tile_number, qr_payload, is_active, question_id
    `,
    [nextQuestionId, nextQrPayload, nextIsActive, tileNumber],
  );

  const updated = updatedResult.rows[0];

  const hydratedResult = await query(
    `
      SELECT bt.id,
             bt.tile_number,
             bt.qr_payload,
             bt.is_active,
             bt.question_id,
             q.prompt,
             q.difficulty,
             q.is_active AS question_is_active
      FROM board_tiles bt
      LEFT JOIN questions q ON q.id = bt.question_id
      WHERE bt.id = $1
    `,
    [updated.id],
  );

  const row = hydratedResult.rows[0];
  res.json({
    boardTile: {
      id: row.id,
      tileNumber: row.tile_number,
      qrPayload: row.qr_payload,
      isActive: row.is_active,
      questionId: row.question_id,
      questionPrompt: row.prompt,
      questionDifficulty: row.difficulty || null,
      questionIsActive: row.question_is_active ?? null,
    },
  });
});

router.get('/board-tiles/:tileNumber/qr', requireAuth, async (req, res) => {
  const tileNumber = parseTileNumberParam(req.params.tileNumber);

  const result = await query(
    `
      SELECT tile_number, qr_payload
      FROM board_tiles
      WHERE tile_number = $1 AND is_active = TRUE
    `,
    [tileNumber],
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, 'Board tile not found');
  }

  const row = result.rows[0];
  const dataUrl = await QRCode.toDataURL(row.qr_payload, {
    margin: 1,
    width: BOARD_PRINT_QR_WIDTH,
  });

  res.json({
    tileNumber: row.tile_number,
    qrPayload: row.qr_payload,
    qrDataUrl: dataUrl,
  });
});

module.exports = router;
