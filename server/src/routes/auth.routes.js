const express = require('express');
const bcrypt = require('bcrypt');
const { z } = require('zod');
const { query } = require('../db/pool');
const { HttpError } = require('../utils/http-error');

const router = express.Router();

const registerSchema = z.object({
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
  password: z.string().min(6).max(128),
  displayName: z.string().trim().min(2).max(50),
});

const loginSchema = z.object({
  email: z.string().trim().email().max(255).transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(128),
});

function toSafeUser(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
  };
}

function parseBody(schema, body) {
  const result = schema.safeParse(body);

  if (!result.success) {
    throw result.error;
  }

  return result.data;
}

function saveSession(req) {
  return new Promise((resolve, reject) => {
    req.session.save((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function destroySession(req) {
  return new Promise((resolve, reject) => {
    req.session.destroy((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

router.get('/me', (req, res) => {
  res.json({
    user: req.session?.user || null,
  });
});

router.post('/register', async (req, res) => {
  const { email, password, displayName } = parseBody(registerSchema, req.body);

  const existing = await query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount > 0) {
    throw new HttpError(409, 'An account with this email already exists');
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const result = await query(
    `
      INSERT INTO users (email, password_hash, display_name, role)
      VALUES ($1, $2, $3, 'player')
      RETURNING id, email, display_name, role
    `,
    [email, passwordHash, displayName],
  );

  const user = toSafeUser(result.rows[0]);
  req.session.user = user;
  await saveSession(req);

  res.status(201).json({ user });
});

router.post('/login', async (req, res) => {
  const { email, password } = parseBody(loginSchema, req.body);

  const result = await query(
    `
      SELECT id, email, password_hash, display_name, role
      FROM users
      WHERE email = $1
    `,
    [email],
  );

  if (result.rowCount === 0) {
    throw new HttpError(401, 'Invalid email or password');
  }

  const userRow = result.rows[0];
  const passwordMatches = await bcrypt.compare(password, userRow.password_hash);

  if (!passwordMatches) {
    throw new HttpError(401, 'Invalid email or password');
  }

  const user = toSafeUser(userRow);
  req.session.user = user;
  await saveSession(req);

  res.json({ user });
});

router.post('/logout', async (req, res) => {
  if (!req.session) {
    res.status(204).send();
    return;
  }

  await destroySession(req);
  res.clearCookie('fwdd.sid');
  res.status(204).send();
});

module.exports = router;

