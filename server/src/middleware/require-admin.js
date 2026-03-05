const { HttpError } = require('../utils/http-error');

function requireAdmin(req, res, next) {
  void res;

  if (!req.session || !req.session.user) {
    next(new HttpError(401, 'Authentication required'));
    return;
  }

  if (req.session.user.role !== 'admin') {
    next(new HttpError(403, 'Admin access required'));
    return;
  }

  next();
}

module.exports = {
  requireAdmin,
};

