const { HttpError } = require('../utils/http-error');

function requireAuth(req, res, next) {
  void res;

  if (!req.session || !req.session.user) {
    next(new HttpError(401, 'Authentication required'));
    return;
  }

  next();
}

module.exports = {
  requireAuth,
};

