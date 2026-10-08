/**
 * Error type shared by the settings surface (provider registry, credential
 * store, settings API routes). Carries an HTTP status plus a recovery hint so
 * every failure the console shows explains how to fix it.
 */
export class SettingsError extends Error {
  /** HTTP status the API layer should answer with (400/404/409/415/...). */
  readonly status: number
  /** One-line recovery instruction shown to the user next to the message. */
  readonly hint: string

  constructor(message: string, options: { status?: number; hint?: string } = {}) {
    super(message)
    this.name = 'SettingsError'
    this.status = options.status ?? 400
    this.hint = options.hint ?? ''
  }
}
