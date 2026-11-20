// Пересылка сообщения (P-W6): подготовка содержимого без конверта целевого
// чата — порт domain/MessageForward.kt. Чужая цитата не утекает: из ответа
// берём только текст, медиа едет тем же дескриптором с атрибуцией «fwd».
// Целевой чат сам оборачивает payload в свой групповой конверт.
import { innerContent, parse } from '../protocol/codec.js'
import { MediaJson, ReplyFormat, type MediaInfo } from '../protocol/formats.js'
import * as Env from '../protocol/envelope.js'
import { validLogin } from '../protocol/validators.js'

export type ForwardPayload =
  | { kind: 'text'; text: string; fwd?: string }
  | { kind: 'media'; info: MediaInfo }

// payload пересылки или null — пересылать нечего (опрос, гео, служебное)
export function forwardPayload(content: Uint8Array, author: string | null, keepAuthor = true): ForwardPayload | null {
  const parsed = parse(innerContent(content), false)
  if (parsed.kind !== 'content') return null
  const kind = parsed.content
  // повторная пересылка сохраняет ИСХОДНОГО автора: цепочка не затирает его
  const fwd = keepAuthor ? author : null
  switch (kind.kind) {
    case 'text':
      return textPayload(fwd, kind.text)
    case 'reply':
      return textPayload(kind.reply.fwd ?? fwd, kind.reply.text)
    case 'media':
      return { kind: 'media', info: withFwd(kind.info, fwd) }
    default:
      return null
  }
}

// конверт пересланного сообщения для целевого чата
export function encodeForward(payload: ForwardPayload): Uint8Array {
  if (payload.kind === 'media') return MediaJson.message(payload.info)
  const author = payload.fwd && validLogin(payload.fwd) ? payload.fwd : undefined
  return author ? ReplyFormat.encodeForward(author, payload.text) : Env.escapeText(payload.text)
}

function textPayload(author: string | null | undefined, text: string): ForwardPayload {
  return author && validLogin(author) ? { kind: 'text', text, fwd: author } : { kind: 'text', text }
}

// копия дескриптора с атрибуцией: исходный автор уже стоит — не трогаем;
// keepAuthor=false снимает атрибуцию совсем (пересылка без автора)
function withFwd(info: MediaInfo, author: string | null): MediaInfo {
  if (author === null || !validLogin(author)) {
    if (info.forwardFrom === undefined) return info
    return { ...info, forwardFrom: undefined }
  }
  if (info.forwardFrom !== undefined) return info
  return { ...info, forwardFrom: author }
}