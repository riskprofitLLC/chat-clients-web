// Медиа: шифрование блоба, превью через canvas, сжатие фото, файлы, голос.
// Формат блоба совпадает с Android (media/Media.kt):
//   blob = IV 12Б || AES-GCM(случайный ключ 32Б, AAD пустой)
// Ключ едет в дескрипторе сообщения, сервер видит только шифротекст.
import { aesGcmDecrypt, aesGcmEncrypt, randomBytes } from '../crypto/primitives.js'
import { concat } from '../util/bytes.js'
import { toBase64 } from '../util/b64.js'
import { mediaInfo, type MediaInfo } from '../protocol/formats.js'

export const MAX_BLOB = 10 * 1024 * 1024
const IV_SIZE = 12
const THUMB_EDGE = 480
// потолок base64-превью в дескрипторе (MediaJson): 131 072 символа
const THUMB_MAX_B64 = 131_072
const PHOTO_EDGE = 1920

export interface EncryptedBlob {
  blob: Uint8Array
  key: Uint8Array
}

export async function encryptBlob(plain: Uint8Array): Promise<EncryptedBlob> {
  if (plain.length + IV_SIZE + 16 > MAX_BLOB) {
    throw new Error('вложение слишком большое (макс 10 МБ)')
  }
  const key = randomBytes(32)
  const iv = randomBytes(IV_SIZE)
  const ct = await aesGcmEncrypt(key, iv, plain, new Uint8Array(0))
  return { blob: concat(iv, ct), key }
}

export async function decryptBlob(key: Uint8Array, blob: Uint8Array): Promise<Uint8Array> {
  if (blob.length < IV_SIZE + 16) throw new Error('блоб повреждён')
  return aesGcmDecrypt(key, blob.subarray(0, IV_SIZE), blob.subarray(IV_SIZE), new Uint8Array(0))
}

// ─── изображения ─────────────────────────────────────────────────────────

async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file)
}

function drawScaled(bitmap: ImageBitmap, maxEdge: number): { canvas: HTMLCanvasElement; width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('canvas недоступен')
  // прозрачность заливаем белым: JPEG превратил бы её в чёрный фон
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  return { canvas, width, height }
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('не удалось закодировать изображение'))),
      type,
      quality,
    )
  })
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

// превью: JPEG ~480px, при переполнении потолка base64 — мельче и хуже
export async function makeThumb(bitmap: ImageBitmap): Promise<string> {
  let edge = THUMB_EDGE
  let quality = 0.7
  for (let attempt = 0; attempt < 6; attempt++) {
    const { canvas } = drawScaled(bitmap, edge)
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality)
    const b64 = toBase64(await blobBytes(blob))
    if (b64.length <= THUMB_MAX_B64) return b64
    if (quality > 0.4) quality -= 0.15
    else edge = Math.round(edge * 0.8)
  }
  throw new Error('превью не влезает в потолок дескриптора')
}

export interface PreparedPhoto {
  info: MediaInfo
  plain: Uint8Array
}

// фото: сжимаем до 1920px по длинной стороне, готовим превью
export async function preparePhoto(file: File, options: { spoiler?: boolean; silent?: boolean } = {}): Promise<PreparedPhoto> {
  const bitmap = await loadBitmap(file)
  try {
    const { canvas, width, height } = drawScaled(bitmap, PHOTO_EDGE)
    const encoded = await canvasToBlob(canvas, 'image/jpeg', 0.85)
    const plain = await blobBytes(encoded)
    const thumb = await makeThumb(bitmap)
    return {
      info: mediaInfo({
        id: '',
        key: new Uint8Array(0),
        size: plain.length,
        width,
        height,
        thumb,
        type: 'media',
        spoiler: options.spoiler === true,
        silent: options.silent === true,
      }),
      plain,
    }
  } finally {
    bitmap.close()
  }
}

// GIF и видео отправляем как файл: пересжатие убило бы анимацию
export async function prepareFile(file: File, options: { silent?: boolean } = {}): Promise<PreparedPhoto> {
  const plain = new Uint8Array(await file.arrayBuffer())
  if (plain.length + IV_SIZE + 16 > MAX_BLOB) throw new Error('файл больше 10 МБ')
  const mime = file.type || 'application/octet-stream'
  let thumb = ''
  let width = 0
  let height = 0
  if (mime.startsWith('image/')) {
    try {
      const bitmap = await loadBitmap(file)
      width = bitmap.width
      height = bitmap.height
      thumb = await makeThumb(bitmap)
      bitmap.close()
    } catch {
      // превью необязательно
    }
  }
  return {
    info: mediaInfo({
      id: '',
      key: new Uint8Array(0),
      size: plain.length,
      width,
      height,
      thumb,
      name: file.name.slice(0, 256) || 'file',
      mime,
      type: 'file',
      silent: options.silent === true,
    }),
    plain,
  }
}

// ─── голосовые ───────────────────────────────────────────────────────────

export interface VoiceRecording {
  stop(): Promise<{ data: Uint8Array; duration: number; waveform: Uint8Array }>
  cancel(): void
  readonly startedAt: number
}

// запись голосового: MediaRecorder + анализатор для формы волны (~10 сэмплов/с)
export async function startVoiceRecording(): Promise<VoiceRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  const chunks: Blob[] = []
  const mime = pickVoiceMime()
  const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data)
  }
  const startedAt = Date.now()
  const waveform: number[] = []

  // анализ амплитуды: по одному значению на 100 мс
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  source.connect(analyser)
  const buffer = new Uint8Array(analyser.fftSize)
  const timer = setInterval(() => {
    analyser.getByteTimeDomainData(buffer)
    let peak = 0
    for (const value of buffer) peak = Math.max(peak, Math.abs(value - 128))
    waveform.push(Math.min(255, Math.round((peak / 128) * 255)))
  }, 100)

  recorder.start()

  const cleanup = (): void => {
    clearInterval(timer)
    for (const track of stream.getTracks()) track.stop()
    void context.close()
  }

  return {
    startedAt,
    cancel(): void {
      try {
        recorder.stop()
      } catch {
        // уже остановлен
      }
      cleanup()
    },
    async stop(): Promise<{ data: Uint8Array; duration: number; waveform: Uint8Array }> {
      const done = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve()
      })
      recorder.stop()
      await done
      cleanup()
      const data = new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer())
      const duration = Math.max(1, Math.round((Date.now() - startedAt) / 1000))
      return { data, duration, waveform: new Uint8Array(waveform.slice(0, 8640)) }
    },
  }
}

function pickVoiceMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']
  for (const candidate of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) return candidate
  }
  return ''
}

// аудио-элемент из расшифрованного блоба
export function audioUrl(data: Uint8Array, mime = 'audio/webm'): string {
  return URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mime }))
}

export function imageUrl(data: Uint8Array, mime = 'image/jpeg'): string {
  return URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: mime }))
}

// превью из дескриптора (base64) — показывается до загрузки полного блоба
export function thumbUrl(thumbB64: string): string {
  return `data:image/jpeg;base64,${thumbB64}`
}
