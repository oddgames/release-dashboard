const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3
};

const currentLevel = LOG_LEVELS[process.env.LOG_LEVEL || 'debug'] ?? LOG_LEVELS.info;
const jsonFormat = process.env.LOG_FORMAT === 'json';

function formatTimestamp() {
  return new Date().toISOString();
}

function log(level, context, message, metadata = {}) {
  if (LOG_LEVELS[level] > currentLevel) return;

  const timestamp = formatTimestamp();
  const levelUpper = level.toUpperCase().padEnd(5);

  if (jsonFormat) {
    console.log(JSON.stringify({
      timestamp,
      level,
      context,
      message,
      ...metadata
    }));
  } else {
    const metaStr = Object.keys(metadata).length > 0
      ? ` ${JSON.stringify(metadata)}`
      : '';
    console.log(`[${timestamp}] [${levelUpper}] [${context}] ${message}${metaStr}`);
  }
}

module.exports = {
  error: (context, message, metadata) => log('error', context, message, metadata),
  warn: (context, message, metadata) => log('warn', context, message, metadata),
  info: (context, message, metadata) => log('info', context, message, metadata),
  debug: (context, message, metadata) => log('debug', context, message, metadata)
};
