const express = require('express');
const { z } = require('zod');
const { withTransaction, query } = require('../db/pool');
const { requireAuth } = require('../middleware/require-auth');
const { requireAdmin } = require('../middleware/require-admin');
const { HttpError } = require('../utils/http-error');
const { groupQuestions } = require('../utils/question-format');

const router = express.Router();

const optionSchema = z.object({
  optionText: z.string().trim().min(1).max(300),
  isCorrect: z.boolean(),
});

const createQuestionSchema = z.object({
  prompt: z.string().trim().min(5).max(1000),
  difficulty: z.enum(['easy', 'medium', 'hard']),
  explanation: z.string().trim().max(2000).optional().or(z.literal('')),
  isActive: z.boolean().optional(),
  options: z.array(optionSchema).min(2).max(6),
});

const updateQuestionSchema = z.object({
  prompt: z.string().trim().min(5).max(1000).optional(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  explanation: z.string().trim().max(2000).optional(),
  isActive: z.boolean().optional(),
  options: z.array(optionSchema).min(2).max(6).optional(),
});

function parseBody(schema, body) {
  const result = schema.safeParse(body);
  if (!result.success) throw result.error;
  return result.data;
}

function validateExactlyOneCorrect(options) {
  const correctCount = options.filter((option) => option.isCorrect).length;
  if (correctCount !== 1) {
    throw new HttpError(400, 'A question must have exactly one correct option');
  }
}

function sanitizeQuestion(question, includeAnswers) {
  if (includeAnswers) {
    return question;
  }

  return {
    ...question,
    options: question.options.map((option) => ({
      id: option.id,
      optionText: option.optionText,
      position: option.position,
    })),
  };
}

async function loadQuestions({ includeInactive = false } = {}) {
  const rows = await query(
    `
      SELECT q.id,
             q.concept,
             q.prompt,
             q.question_type,
             q.difficulty,
             q.explanation,
             q.is_active,
             q.created_by,
             q.created_at,
             q.updated_at,
             qo.id AS option_id,
             qo.option_text,
             qo.is_correct AS option_is_correct,
             qo.position AS option_position
      FROM questions q
      LEFT JOIN question_options qo ON qo.question_id = q.id
      WHERE ($1::boolean = TRUE OR q.is_active = TRUE)
      ORDER BY q.created_at DESC, qo.position ASC
    `,
    [includeInactive],
  );

  return groupQuestions(rows.rows);
}

async function loadQuestionById(id) {
  const rows = await query(
    `
      SELECT q.id,
             q.concept,
             q.prompt,
             q.question_type,
             q.difficulty,
             q.explanation,
             q.is_active,
             q.created_by,
             q.created_at,
             q.updated_at,
             qo.id AS option_id,
             qo.option_text,
             qo.is_correct AS option_is_correct,
             qo.position AS option_position
      FROM questions q
      LEFT JOIN question_options qo ON qo.question_id = q.id
      WHERE q.id = $1
      ORDER BY qo.position ASC
    `,
    [id],
  );

  if (rows.rowCount === 0) {
    return null;
  }

  return groupQuestions(rows.rows)[0];
}

router.get('/', requireAuth, async (req, res) => {
  const isAdmin = req.session.user.role === 'admin';
  const includeInactive =
    isAdmin && String(req.query.includeInactive || '').toLowerCase() === 'true';

  const questions = await loadQuestions({ includeInactive });
  res.json({ questions: questions.map((question) => sanitizeQuestion(question, isAdmin)) });
});

router.get('/:id', requireAuth, async (req, res) => {
  const question = await loadQuestionById(req.params.id);
  if (!question) {
    throw new HttpError(404, 'Question not found');
  }

  if (!question.isActive && req.session.user.role !== 'admin') {
    throw new HttpError(404, 'Question not found');
  }

  res.json({ question: sanitizeQuestion(question, req.session.user.role === 'admin') });
});

router.post('/', requireAdmin, async (req, res) => {
  const payload = parseBody(createQuestionSchema, req.body);
  validateExactlyOneCorrect(payload.options);

  const question = await withTransaction(async (client) => {
    const questionResult = await client.query(
      `
        INSERT INTO questions (prompt, difficulty, explanation, is_active, created_by)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [
        payload.prompt,
        payload.difficulty,
        payload.explanation || null,
        payload.isActive ?? true,
        req.session.user.id,
      ],
    );

    const questionId = questionResult.rows[0].id;
    for (let i = 0; i < payload.options.length; i += 1) {
      const option = payload.options[i];
      await client.query(
        `
          INSERT INTO question_options (question_id, option_text, is_correct, position)
          VALUES ($1, $2, $3, $4)
        `,
        [questionId, option.optionText, option.isCorrect, i + 1],
      );
    }

    const loaded = await client.query(
      `
        SELECT q.id,
               q.concept,
               q.prompt,
               q.question_type,
               q.difficulty,
               q.explanation,
               q.is_active,
               q.created_by,
               q.created_at,
               q.updated_at,
               qo.id AS option_id,
               qo.option_text,
               qo.is_correct AS option_is_correct,
               qo.position AS option_position
        FROM questions q
        LEFT JOIN question_options qo ON qo.question_id = q.id
        WHERE q.id = $1
        ORDER BY qo.position ASC
      `,
      [questionId],
    );

    return groupQuestions(loaded.rows)[0];
  });

  res.status(201).json({ question });
});

router.patch('/:id', requireAdmin, async (req, res) => {
  const payload = parseBody(updateQuestionSchema, req.body);

  if (Object.keys(payload).length === 0) {
    throw new HttpError(400, 'No fields provided for update');
  }

  if (payload.options) {
    validateExactlyOneCorrect(payload.options);
  }

  const existing = await loadQuestionById(req.params.id);
  if (!existing) {
    throw new HttpError(404, 'Question not found');
  }

  const question = await withTransaction(async (client) => {
    const nextPrompt = payload.prompt ?? existing.prompt;
    const nextDifficulty = payload.difficulty ?? existing.difficulty;
    const nextExplanation =
      payload.explanation !== undefined ? payload.explanation || null : existing.explanation;
    const nextIsActive = payload.isActive ?? existing.isActive;

    await client.query(
      `
        UPDATE questions
        SET prompt = $1,
            difficulty = $2,
            explanation = $3,
            is_active = $4
        WHERE id = $5
      `,
      [nextPrompt, nextDifficulty, nextExplanation, nextIsActive, req.params.id],
    );

    if (payload.options) {
      await client.query('DELETE FROM question_options WHERE question_id = $1', [req.params.id]);
      for (let i = 0; i < payload.options.length; i += 1) {
        const option = payload.options[i];
        await client.query(
          `
            INSERT INTO question_options (question_id, option_text, is_correct, position)
            VALUES ($1, $2, $3, $4)
          `,
          [req.params.id, option.optionText, option.isCorrect, i + 1],
        );
      }
    }

    const loaded = await client.query(
      `
        SELECT q.id,
               q.concept,
               q.prompt,
               q.question_type,
               q.difficulty,
               q.explanation,
               q.is_active,
               q.created_by,
               q.created_at,
               q.updated_at,
               qo.id AS option_id,
               qo.option_text,
               qo.is_correct AS option_is_correct,
               qo.position AS option_position
        FROM questions q
        LEFT JOIN question_options qo ON qo.question_id = q.id
        WHERE q.id = $1
        ORDER BY qo.position ASC
      `,
      [req.params.id],
    );

    return groupQuestions(loaded.rows)[0];
  });

  res.json({ question });
});

router.delete('/:id', requireAdmin, async (req, res) => {
  const result = await query(
    `
      UPDATE questions
      SET is_active = FALSE
      WHERE id = $1
      RETURNING id
    `,
    [req.params.id],
  );

  if (result.rowCount === 0) {
    throw new HttpError(404, 'Question not found');
  }

  res.status(204).send();
});

module.exports = router;
