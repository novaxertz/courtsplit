const ApiError = require('../utils/ApiError');
const logger = require('../utils/logger');

function notFound(req, _res, next) {
  next(ApiError.notFound(`No route matches ${req.method} ${req.originalUrl}`));
}

// Express identifies error middleware by its four-argument signature.
function errorHandler(err, _req, res, _next) {
  let error = err;

  if (error.name === 'ValidationError') {
    error = ApiError.badRequest('Validation failed', {
      fields: Object.keys(err.errors || {})
    });
  } else if (error.name === 'CastError') {
    error = ApiError.badRequest(`Malformed identifier: ${err.value}`);
  } else if (error.code === 11000) {
    error = ApiError.conflict('That record already exists', { keys: Object.keys(err.keyPattern || {}) });
  } else if (!(error instanceof ApiError)) {
    logger.error('Unhandled error', { message: err.message, stack: err.stack });
    error = new ApiError(500, 'Internal server error');
  }

  res.status(error.statusCode).json({
    error: error.message,
    ...(error.details ? { details: error.details } : {})
  });
}

module.exports = { notFound, errorHandler };
