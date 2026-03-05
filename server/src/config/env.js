const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function readRequired(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const port = Number(process.env.PORT || 4000);
if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

const config = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  clientOrigin: process.env.CLIENT_ORIGIN || 'http://localhost:5173',
  databaseUrl: readRequired('DATABASE_URL'),
  sessionSecret: readRequired('SESSION_SECRET'),
  sessionMaxAgeMs: 1000 * 60 * 60 * 24 * 7,
};

module.exports = {
  config,
  isProduction: config.nodeEnv === 'production',
};

