/** A source the pipeline will not take, with why when it can say. */
export class UnsupportedMediaError extends Error {
  readonly reason: string | null
  constructor(reason: string | null = null) {
    super(reason ? `unsupported media: ${reason}` : 'unsupported media')
    this.name = 'UnsupportedMediaError'
    this.reason = reason
  }
}
