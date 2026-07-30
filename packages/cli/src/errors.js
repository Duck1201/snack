export const ExitCode = Object.freeze({
  success: 0,
  usage: 2,
  config: 3,
  unavailable: 4,
  storage: 5,
  io: 6,
  internal: 10,
});

export class SnackError extends Error {
  /**
   * @param {string} message
   * @param {{code?: number, reason?: string, cause?: unknown}} [options]
   */
  constructor(message, options = {}) {
    super(message, { cause: options.cause });
    this.name = "SnackError";
    this.exitCode = options.code ?? ExitCode.internal;
    this.reason = options.reason ?? "internal_error";
  }
}
