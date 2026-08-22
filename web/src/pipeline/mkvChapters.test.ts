import { describe, expect, it } from 'vitest'
import { readMkvChapters } from './mkvChapters'

// A real ffmpeg-muxed Matroska (base64-inlined), chapters and all. ffmpeg
// writes Chapters after the clusters with a SeekHead pointing at them, so
// this exercises the seek-and-fetch path, not just the head scan.
const FIXTURE_B64 =
  'GkXfo6NChoEBQveBAULygQRC84EIQoKIbWF0cm9za2FCh4EEQoWBAhhTgGcBAAAAAAAIfRFNm3TPv4TuMbs5TbuLU6uEFUmpZlOs' +
  'gaFNu4tTq4QWVK5rU6yB7027jFOrhBBDp3BTrIIB4E27jFOrhBJUw2dTrIICXk27jFOrhBxTu2tTrIIIYewBAAAAAAAARAAAAAAA' +
  'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFUmpZsm/hIXuALAq' +
  '17GDD0JATYCMTGF2ZjYzLjEuMTAxV0GMTGF2ZjYzLjEuMTAxc6SQqlBVWElJbH1l0MxQtoZiEkSJiECP+AAAAAAAFlSua0Drv4QP' +
  '9CkhrgEAAAAAAACA14EBc8WI1B1TsWlqt/acgQAitZyDdW5kiIEAho9WX01QRUc0L0lTTy9BVkODgQEj44OEB3NZQOCQsIFAuoFA' +
  'moECVbCEVbmBAVXugQDsAQAAAAAAAAIAAGOipQFCwAr/4QAWZ0LACtoQmwEQAAADABAAAAMBAPEiagEABGjOD8iuAQAAAAAAAFPX' +
  'gQJzxYjGlebb+12h/ZyBACK1nIN1bmSIgQCGhUFfQUFDVqqEAWJO84OBAiPjg4QBYk7y4ZGfgQK1iEDliIAAAAAAYmSBIFXugQBj' +
  'ooUSEFblABBDp3D5v4RjkfBoRbkBAAAAAAAAaUXbgQG2n3PEgQGRgQCShBfXhACAkIWIQWJlcnR1cmFDfIN1bmS2o3PEgQKRhBfX' +
  'hACShDWk6QCAkYWJRXBpc8OzZGlvQ3yDdW5ktp1zxIEDkYQ1pOkAkoQ7msoAgIuFg0ZpbUN8g3VuZBJUw2dA1r+EC+u0nnNzn2PA' +
  'gGfImUWjh0VOQ09ERVJEh4xMYXZmNjMuMS4xMDFzc9ZjwItjxYjUHVOxaWq39mfIoUWjh0VOQ09ERVJEh5RMYXZjNjMuMS4xMDEg' +
  'bGlieDI2NGfIoUWjiERVUkFUSU9ORIeTMDA6MDA6MDEuMDAwMDAwMDAwAHNz0mPAi2PFiMaV5tv7XaH9Z8idRaOHRU5DT0RFUkSH' +
  'kExhdmM2My4xLjEwMSBhYWNnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAyMzAwMDAwMAAfQ7Z1RSG/hCn9tYTngQCjmYIAAIDc' +
  'AExhdmM2My4xLjEwMQBCIAjBGDijQnWBAACAAAACUwYF//9P3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMiBi' +
  'MzU2MDVhIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4u' +
  'b3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTAgcmVmPTEgZGVibG9jaz0wOjA6MCBhbmFseXNlPTA6MCBtZT1kaWEgc3Vi' +
  'bWU9MCBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0wIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MCA4' +
  'eDhkY3Q9MCBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0wIHRocmVhZHM9MiBsb29r' +
  'YWhlYWRfdGhyZWFkcz0xIHNsaWNlZF90aHJlYWRzPTAgbnI9MCBkZWNpbWF0ZT0xIGludGVybGFjZWQ9MCBibHVyYXlfY29tcGF0' +
  'PTAgY29uc3RyYWluZWRfaW50cmE9MCBiZnJhbWVzPTAgd2VpZ2h0cD0wIGtleWludD0yNTAga2V5aW50X21pbj04IHNjZW5lY3V0' +
  'PTAgaW50cmFfcmVmcmVzaD0wIHJjPWNyZiBtYnRyZWU9MCBjcmY9MjMuMCBxY29tcD0wLjYwIHFwbWluPTAgcXBtYXg9NjkgcXBz' +
  'dGVwPTQgaXBfcmF0aW89MS40MCBhcT0wAIAAAAAWZYiEOiYoAAkCycnJ1111111111114KOKggAXgCEQBGCMHKOKggAugCEQBGCM' +
  'HKOKggBFgCEQBGCMHKOKggBdgCEQBGCMHKOKggB0gCEQBGCMHKOKggCLgCEQBGCMHKOOgQB9AAAAAAZBmiASoIyjioIAooAhEARg' +
  'jByjioIAuoAhEARgjByjioIA0YAhEARgjByjioIA6IAhEARgjByjioIA/4AhEARgjByjjoEA+gAAAAAGQZpAE6CMo4qCARaAIRAE' +
  'YIwco4qCAS6AIRAEYIwco4qCAUWAIRAEYIwco4qCAVyAIRAEYIwco4qCAXOAIRAEYIwco4qCAYuAIRAEYIwco46BAXcAAAAABkGa' +
  'YBOgjKOKggGigCEQBGCMHKOKggG5gCEQBGCMHKOKggHQgCEQBGCMHKOKggHngCEQBGCMHKOKggH/gCEQBGCMHKOOgQH0AAAAAAZB' +
  'moAToIyjioICFoAhEARgjByjioICLYAhEARgjByjioICRIAhEARgjByjioICW4AhEARgjByjioICc4AhEARgjByjjoECcQAAAAAG' +
  'QZqgE6CMo4qCAoqAIRAEYIwco4qCAqGAIRAEYIwco4qCAriAIRAEYIwco4qCAtCAIRAEYIwco4qCAueAIRAEYIwco4qCAv6AIRAE' +
  'YIwco46BAu4AAAAABkGawBOgjKOKggMVgCEQBGCMHKOKggMsgCEQBGCMHKOKggNEgCEQBGCMHKOKggNbgCEQBGCMHKOKggNygCEQ' +
  'BGCMHKOOgQNrAAAAAAZBmuAToIyjioIDiYAhEARgjByjioIDoYAhEARgjByjioIDuIAhEARgjByjioIDz4AhEARgjByjioID5oAh' +
  'EARgjBygj6GKggP9ACEQBGCMHJuBAhxTu2uXv4QjvBmYu4+zgQC3iveBAfGCAzrwgSQ='
const fixture = Uint8Array.from(atob(FIXTURE_B64), (c) => c.charCodeAt(0))

describe('readMkvChapters', () => {
  it('reads the chapter atoms ffmpeg wrote', async () => {
    const file = new File([fixture], 'chaptered.mkv')

    const chapters = await readMkvChapters(file)

    expect(chapters).toEqual([
      { startMs: 0, endMs: 400, title: 'Abertura' },
      { startMs: 400, endMs: 900, title: 'Episódio' },
      { startMs: 900, endMs: 1000, title: 'Fim' },
    ])
  })

  it('answers nothing for a file that is not Matroska', async () => {
    const file = new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], 'movie.mp4')
    expect(await readMkvChapters(file)).toEqual([])
  })
})
