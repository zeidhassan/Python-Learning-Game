const express = require('express');
const cors = require('cors');
const session = require('express-session');
const pgSessionFactory = require('connect-pg-simple');
const { config, isProduction } = require('./config/env');
const { pool } = require('./db/pool');
const healthRoutes = require('./routes/health.routes');
const authRoutes = require('./routes/auth.routes');
const questionsRoutes = require('./routes/questions.routes');
const roomsRoutes = require('./routes/rooms.routes');
const boardRoutes = require('./routes/board.routes');
const { notFoundHandler } = require('./middleware/not-found');
const { errorHandler } = require('./middleware/error-handler');

const PgSessionStore = pgSessionFactory(session);

const app = express();

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(
  cors({
    origin: config.clientOrigin,
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    store: new PgSessionStore({
      pool,
      tableName: 'session',
      createTableIfMissing: true,
    }),
    name: 'fwdd.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isProduction,
      maxAge: config.sessionMaxAgeMs,
    },
  }),
);

app.get('/', (req, res) => {
  void req;

  res.json({
    message: 'FWDD Hybrid Game API',
    apiBase: '/api',
  });
});

app.use('/api', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/questions', questionsRoutes);
app.use('/api/rooms', roomsRoutes);
app.use('/api', boardRoutes);

app.use(notFoundHandler);
app.use(errorHandler);

module.exports = app;
