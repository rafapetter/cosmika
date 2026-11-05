import type { FileType } from '@cosmika/db'

/** What a flow media bubble emits: the author's declared type and a URL. */
export type FlowMediaEmission = {
  mediaType: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE'
  url: string
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  mp4: 'video/mp4',
  '3gp': 'video/3gpp',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  amr: 'audio/amr',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  pdf: 'application/pdf',
}

// When the URL carries no recognisable extension (a signed or CDN link), trust
// the type the flow author picked and let the provider sniff the bytes.
const DEFAULT_MIME: Record<FlowMediaEmission['mediaType'], string | null> = {
  IMAGE: 'image/jpeg',
  VIDEO: 'video/mp4',
  AUDIO: 'audio/mpeg',
  FILE: null,
}

const FILE_TYPE: Record<FlowMediaEmission['mediaType'], FileType> = {
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  FILE: 'FILE',
}

function lastSegment(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    path = url.replace(/[?#].*$/, '')
  }
  const seg = path.slice(path.lastIndexOf('/') + 1)
  try {
    return decodeURIComponent(seg)
  } catch {
    return seg
  }
}

/**
 * The attachment-shaped facts an adapter needs to pick a provider media type
 * for a flow bubble: file type, best-guess mime and the file name to show on
 * a document send.
 */
export function flowMediaFor(emission: FlowMediaEmission): {
  fileType: FileType
  mimeType: string | null
  fileName: string | null
} {
  const name = lastSegment(emission.url)
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return {
    fileType: FILE_TYPE[emission.mediaType],
    mimeType: EXT_MIME[ext] ?? DEFAULT_MIME[emission.mediaType],
    fileName: name || null,
  }
}
