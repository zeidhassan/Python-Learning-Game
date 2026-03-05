const { Pool } = require('pg');
const { config } = require('../config/env');

const pool = new Pool({
  connectionString: config.databaseUrl,
});

pool.on('error', (error) => {
  console.error('Unexpected PostgreSQL pool error:', error);
});

function query(text, params) {
  return pool.query(text, params);
}

async function withTransaction(work) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  pool,
  query,
  withTransaction,
};

