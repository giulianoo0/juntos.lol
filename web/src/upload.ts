import Uppy from '@uppy/core'
import Tus from '@uppy/tus'

interface CreateRoomResponse {
  id: string
  uploadEndpoint: string
}

export async function createRoomAndUpload(
  file: File,
  nickname: string,
  onProgress: (percentage: number) => void,
): Promise<string> {
  const response = await fetch('/api/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fileName: file.name, nickname }),
  })
  if (!response.ok) throw new Error('create room failed')
  const room = (await response.json()) as CreateRoomResponse
  const uppy = new Uppy({ autoProceed: false })
  uppy.use(Tus, { endpoint: room.uploadEndpoint })
  uppy.setMeta({ roomID: room.id })
  uppy.addFile({ name: file.name, type: file.type, data: file })
  try {
    await new Promise<void>((resolve, reject) => {
      uppy.on('upload-progress', (_file, progress) => {
        const total = progress.bytesTotal ?? file.size
        onProgress(total > 0 ? Math.round((progress.bytesUploaded / total) * 100) : 0)
      })
      uppy.on('complete', () => resolve())
      uppy.on('error', reject)
      void uppy.upload().catch(reject)
    })
  } finally {
    uppy.destroy()
  }
  return room.id
}
