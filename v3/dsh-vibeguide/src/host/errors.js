/** An error whose message is safe and meaningful to show a non-technical user. */
export class GuideError extends Error {
  constructor(code, message, status = 400, extra = undefined) {
    super(message)
    this.code = code
    this.status = status
    this.extra = extra
  }
}

export const isGuideError = (e) => e instanceof GuideError
