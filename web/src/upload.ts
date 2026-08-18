import Uppy from '@uppy/core'
import Tus from '@uppy/tus'

const TUS_CHUNK_BYTES = 50 * 1024 * 1024

interface CreateRoomResponse {
  id: string
  nickname: string
  uploadEndpoint: string
}

export interface UploadResult {
  roomID: string
  nickname: string
}

export async function createRoomAndUpload(
  file: File,
  nickname: string,
  onProgress: (percentage: number) => void,
): Promise<UploadResult> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, nickname }),
  })
  if (!response.ok) throw new Error('create room failed')
  const room = (await response.json()) as CreateRoomResponse
  const uppy = new Uppy({ autoProceed: false })
  // Keep each PATCH below the common reverse-proxy upload cap while still
  // allowing the server's 10 GB room limit to be reached resumably.
  uppy.use(Tus, { endpoint: room.uploadEndpoint, chunkSize: TUS_CHUNK_BYTES })
  uppy.setMeta({ roomID: room.id })
  uppy.addFile({ name: file.name, type: file.type, data: file })
  try {
    await new Promise<void>((resolve, reject) => {
      uppy.on('upload-progress', (_file, progress) => {
        const total = progress.bytesTotal ?? file.size
        onProgress(total > 0 ? Math.round((progress.bytesUploaded / total) * 100) : 0)
      })
      uppy.on('complete', (result) => {
        if (result.failed?.length) {
          reject(new Error('upload failed'))
          return
        }
        resolve()
      })
      uppy.on('error', reject)
      void uppy.upload().catch(reject)
    })
  } finally {
    uppy.destroy()
  }
  return { roomID: room.id, nickname: room.nickname }
}
