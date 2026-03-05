const express = require('express');
const { query } = require('../db/pool');

const router = express.Router();

router.get('/health', async (req, res) => {
  void req;

  const dbResult = await query('SELECT NOW() AS now');

  res.json({
    status: 'ok',
    database: 'ok',
    serverTime: dbResult.rows[0].now,
  });
});

module.exports = router;

