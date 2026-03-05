const http = require('http');
const app = require('./app');
const { config } = require('./config/env');
const { pool } = require('./db/pool');
const { initializeSocket } = require('./socket');

let httpServer;

async function start() {
  await pool.query('SELECT 1');

  httpServer = http.createServer(app);
  const io = initializeSocket(httpServer);
  app.set('io', io);

  httpServer.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port}`);
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}, shutting down...`);

  try {
    if (httpServer) {
      await new Promise((resolve, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }

    await pool.end();
    process.exit(0);
  } catch (error) {
    console.error('Shutdown error:', error);
    process.exit(1);
  }
}

process.on('SIGINT', () => {
  shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  shutdown('SIGTERM');
});

start().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});

