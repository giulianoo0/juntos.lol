// What the page says for each way Google Drive can fail to open. Kept apart
// from the client so every page that opens Drive links agrees on it. Drive
// errors carry a `code` (see `drive.ts`); matching stays structural so this
// module never pulls the Drive client — and its mediabunny import — into the
// first-paint chunk.
export function driveErrorKey(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  switch (code) {
    case 'missing-key': return 'drive.noKey'
    case 'bad-id': return 'drive.badLink'
    case 'not-shared': return 'drive.notShared'
    case 'quota': return 'drive.quota'
    case 'too-many': return 'drive.tooMany'
    default: return 'drive.failed'
  }
}
