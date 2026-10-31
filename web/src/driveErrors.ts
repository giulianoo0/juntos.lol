// Message keys for each way Drive can fail to open. Matching on `code` stays structural
// so the Drive client (and mediabunny) never land in the first-paint chunk.
export function driveErrorKey(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  switch (code) {
    case 'missing-key': return 'drive.noKey'
    case 'bad-id': return 'drive.badLink'
    case 'not-shared': return 'drive.notShared'
    case 'quota': return 'drive.quota'
    case 'download-quota': return 'drive.downloadQuota'
    case 'storage-full': return 'drive.storageFull'
    case 'too-many': return 'drive.tooMany'
    default: return 'drive.failed'
  }
}
