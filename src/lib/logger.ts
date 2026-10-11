/**
 * Minimal structured logger.
 *
 * SECURITY (see .kiro/steering/security.md, OWASP A09): logs MUST NOT contain
 * PII or secrets — no tokens, no user profile details, no full request/response
 * bodies. Log opaque identifiers (ids, status codes, error messages) instead.
 *
 * All output goes to STDERR. On the stdio transport, stdout is the MCP protocol
 * channel and must never carry log lines.
 *
 * `fields` is intentionally typed to discourage dumping arbitrary objects.
 * Callers should pass pre-reduced, non-sensitive scalars. A future iteration
 * can add an explicit redaction allow-list here.
 */
type LogFields = Record<string, string | number | boolean>

type Level = 'debug' | 'info' | 'warn' | 'error'

function emit(level: Level, message: string, fields?: LogFields): void {
  const line = {
    ts: new Date().toISOString(),
    level,
    message,
    ...fields,
  }
  process.stderr.write(`${JSON.stringify(line)}\n`)
}

export const logger = {
  debug: (message: string, fields?: LogFields) => emit('debug', message, fields),
  info: (message: string, fields?: LogFields) => emit('info', message, fields),
  warn: (message: string, fields?: LogFields) => emit('warn', message, fields),
  error: (message: string, fields?: LogFields) => emit('error', message, fields),
}
