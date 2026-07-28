const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const active = levels[process.env.LOG_LEVEL] ?? levels.info;

function emit(level, message, meta) {
  if (levels[level] > active) return;
  const line = { timestamp: new Date().toISOString(), level, message };
  if (meta !== undefined) line.meta = meta;
  const stream = level === 'error' ? console.error : console.log;
  stream(JSON.stringify(line));
}

module.exports = {
  error: (message, meta) => emit('error', message, meta),
  warn: (message, meta) => emit('warn', message, meta),
  info: (message, meta) => emit('info', message, meta),
  debug: (message, meta) => emit('debug', message, meta)
};
