import { packageId } from "./constants.js";

const loggingContext = "FXMaster";
const loggingSeparator = "|";
const loggerSettingKey = "enableLogger";

/**
 * Determine whether console logging is currently enabled.
 *
 * @returns {boolean}
 */
export function isLoggerEnabled() {
  try {
    const settings = globalThis.game?.settings ?? null;
    if (!settings) return false;

    const fullKey = `${packageId}.${loggerSettingKey}`;
    const registry = settings.settings ?? null;
    if (registry && typeof registry.has === "function" && !registry.has(fullKey)) return false;

    return settings.get(packageId, loggerSettingKey) === true;
  } catch (_err) {
    return false;
  }
}

/**
 * Gets a logging function for the requested log level.
 * @typedef {'debug' | 'info' | 'warn' | 'error'} LogLevel
 * @typedef {(...args: unknown[]) => void} LoggingFunction
 * @param {LogLevel} [type = 'info'] - The log level of the requested logger
 * @returns {LoggingFunction}
 */
function getLoggingFunction(type = "info") {
  const log = console[type] ?? console.log;
  return (...data) => {
    if (!isLoggerEnabled()) return;
    log.call(console, loggingContext, loggingSeparator, ...data);
  };
}

/**
 * Format a message for logging.
 * @param {string} msg The message to format for logging.
 * @returns {string}
 */
export function format(msg) {
  return `${loggingContext} ${loggingSeparator} ${msg}`;
}

/**
 * A singleton logger object.
 */
export const logger = Object.freeze({
  debug: getLoggingFunction("debug"),
  info: getLoggingFunction("info"),
  warn: getLoggingFunction("warn"),
  error: getLoggingFunction("error"),
  getLoggingFunction,
  isEnabled: isLoggerEnabled,
});
