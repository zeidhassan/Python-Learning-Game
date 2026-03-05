const { ZodError } = require('zod');

function errorHandler(err, req, res, next) {
  void next;

  if (res.headersSent) {
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({
      error: 'ValidationError',
      message: 'Request validation failed',
      details: err.flatten(),
    });
    return;
  }

  if (err && err.name === 'HttpError') {
    res.status(err.status || 500).json({
      error: err.name,
      message: err.message || 'Request failed',
      details: err.details || null,
    });
    return;
  }

  if (err && err.code === '23505') {
    const detail = String(err.detail || '');
    let message = 'A record with the same unique value already exists';

    if (detail.includes('(email)')) {
      message = 'That email address is already registered';
    } else if (detail.includes('(qr_payload)')) {
      message = 'That QR payload is already assigned to another board tile';
    } else if (detail.includes('(room_code)')) {
      message = 'Room code conflict occurred. Please try again';
    }

    res.status(409).json({
      error: 'Conflict',
      message,
      details: err.detail || null,
    });
    return;
  }

  if (err && err.code === '23503') {
    res.status(400).json({
      error: 'ForeignKeyViolation',
      message: 'The referenced record does not exist or cannot be linked',
      details: err.detail || null,
    });
    return;
  }

  if (err && err.code === '22P02') {
    res.status(400).json({
      error: 'InvalidInputSyntax',
      message: 'One of the provided values has an invalid format',
      details: err.detail || null,
    });
    return;
  }

  console.error('Unhandled error:', err);

  res.status(500).json({
    error: 'InternalServerError',
    message: 'An unexpected server error occurred',
  });
}

module.exports = {
  errorHandler,
};
