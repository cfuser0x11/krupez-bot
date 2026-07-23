export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4
};

const colors = {
  reset: '\x1b[0m',
  timestamp: '\x1b[90m', // Dark gray
  debug: '\x1b[35m',     // Magenta
  info: '\x1b[32m',      // Green
  warn: '\x1b[33m',      // Yellow
  error: '\x1b[31m',     // Red
  cyan: '\x1b[36m',      // Cyan
  bold: '\x1b[1m'
};

let currentLevel: LogLevel = 'info';

export function getLogLevel(): LogLevel {
  return currentLevel;
}

export function setLogLevel(level: string) {
  const normalized = level.toLowerCase() as LogLevel;
  if (normalized in LEVEL_PRIORITY) {
    currentLevel = normalized;
  }
}

function formatTime(): string {
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Initializes global console override to enforce LOG_LEVEL and ANSI colorization across the codebase.
 */
export function initLogger() {
  const envLevel = process.env.LOG_LEVEL || 'info';
  setLogLevel(envLevel);

  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  const originalDebug = console.debug ? console.debug.bind(console) : originalLog;

  console.debug = (...args: any[]) => {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.debug) {
      originalDebug(`${colors.timestamp}[${formatTime()}]${colors.reset} ${colors.debug}[DEBUG]${colors.reset}`, ...args);
    }
  };

  console.log = (...args: any[]) => {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.info) {
      originalLog(`${colors.timestamp}[${formatTime()}]${colors.reset} ${colors.info}[INFO]${colors.reset}`, ...args);
    }
  };

  console.warn = (...args: any[]) => {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.warn) {
      originalWarn(`${colors.timestamp}[${formatTime()}]${colors.reset} ${colors.warn}[WARN]${colors.reset}`, ...args);
    }
  };

  console.error = (...args: any[]) => {
    if (LEVEL_PRIORITY[currentLevel] <= LEVEL_PRIORITY.error) {
      originalError(`${colors.timestamp}[${formatTime()}]${colors.reset} ${colors.error}[ERROR]${colors.reset}`, ...args);
    }
  };

  originalLog(`${colors.timestamp}[${formatTime()}]${colors.reset} ${colors.cyan}${colors.bold}[LOGGER]${colors.reset} Global LOG_LEVEL set to: ${colors.info}${colors.bold}${currentLevel.toUpperCase()}${colors.reset}`);
}
