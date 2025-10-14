import { registerPlugin } from './registry.js'
import { ValidationError } from '../errors/validation.error.js'
import { SC } from '../constants/status-codes.js'
import { getConfig } from '../config.js'
import type { PluginContext, PluginResponse } from '../types/index.js'
import { z } from 'zod'
import OpenAI from 'openai'
import { toFile } from 'openai/uploads'
import path from 'node:path'
import { Buffer } from 'node:buffer'

const AUDIO_EXTS = new Set(['.mp3', '.mp4', '.mpeg', '.mpga', '.m4a', '.wav', '.webm'])

const transcribeSchema = z.object({
  file: z.object({
    name: z.string().min(1, 'file.name is required'),
    mime_type: z.string().min(1, 'file.mime_type is required'),
    data: z.string().min(1, 'file.data (base64) is required'),
    size: z.number().int().positive().optional()
  }),
  keywords: z.array(z.string().min(1)).max(50).optional(),
  language: z.string().min(1).max(12).optional()
})

registerPlugin('audio.transcribe', async ({ intent, userId, requestId }: PluginContext): Promise<PluginResponse> => {
  try {
    ensureUser(userId)
    if(intent?.operation !== 'transcribe'){
      return { status_code: SC.BAD_REQUEST, message: 'unsupported operation', data: {} }
    }
    const parsed = transcribeSchema.safeParse(intent.inputs ?? {})
    if(!parsed.success){
      return { status_code: SC.BAD_REQUEST, message: formatZodError(parsed.error), data: {} }
    }
    const { file, keywords, language } = parsed.data
    console.info('[lecture-transcribe] request received', {
      requestId,
      userId,
      fileName: file.name,
      mimeType: file.mime_type,
      size: file.size,
      keywords: keywords?.length ?? 0,
      language
    })
    const buffer = decodeBase64(file.data)
    enforceAudioLimits(file, buffer)
    const client = createOpenAIClient()
    const transcript = await transcribeAudio(client, buffer, file.name, file.mime_type, keywords, language)
    console.info('[lecture-transcribe] transcription succeeded', {
      requestId,
      userId,
      bytes: buffer.length,
      textLength: transcript?.length ?? 0
    })
    return {
      status_code: SC.OK,
      message: 'ok',
      data: {
        text: transcript
      }
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    console.error('[lecture-transcribe] transcription failed', {
      error: detail,
      stack: error instanceof Error ? error.stack : undefined
    })
    if(error instanceof ValidationError){
      return { status_code: SC.BAD_REQUEST, message: error.message, data: {} }
    }
    return {
      status_code: SC.INTERNAL,
      message: 'audio transcription failed',
      data: {
        error: detail
      }
    }
  }
})

function ensureUser(userId: string | undefined){
  if(!userId) throw new ValidationError('missing user id')
  return userId
}

function formatZodError(error: z.ZodError){
  return error.issues.map((issue) => issue.message ?? issue.code).join('; ') || 'invalid inputs'
}

function decodeBase64(value: string): Buffer {
  const trimmed = value.trim()
  const payload = trimmed.startsWith('data:') ? trimmed.slice(trimmed.indexOf(',') + 1) : trimmed
  try {
    return Buffer.from(payload, 'base64')
  } catch {
    throw new ValidationError('file.data is not valid base64')
  }
}

function enforceAudioLimits(file: { name: string; size?: number }, buffer: Buffer){
  const config = getConfig()
  const ext = path.extname(file.name || '').toLowerCase()
  if(!AUDIO_EXTS.has(ext)){
    throw new ValidationError(`unsupported audio extension: ${ext || '<unknown>'}`)
  }
  const maxBytes = config.openai.limits.maxAudioBytes
  const actualSize = file.size ?? buffer.length
  if(actualSize > maxBytes){
    throw new ValidationError(`audio file too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB)`)
  }
}

function createOpenAIClient(): OpenAI {
  const config = getConfig()
  if(!config.openai.apiKey) throw new ValidationError('OPENAI_API_KEY is not configured')
  return new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL })
}

async function transcribeAudio(
  client: OpenAI,
  buffer: Buffer,
  name: string,
  mimeType: string,
  keywords?: string[],
  language?: string
){
  const file = await toFile(buffer, name || 'audio-upload', { type: mimeType })
  const config = getConfig()
  const prompt = buildPrompt(keywords ?? [])
  const response = await client.audio.transcriptions.create({
    file,
    model: config.openai.models.transcribe,
    ...(prompt ? { prompt } : {}),
    ...(language ? { language } : {})
  } as any)
  return response.text ?? ''
}

function buildPrompt(keywords: string[]): string | undefined {
  if(!keywords.length) return undefined
  const sanitized = keywords
    .map((word) => word.replace(/[\r\n]+/g, ' ').trim())
    .filter(Boolean)
  if(!sanitized.length) return undefined
  const list = sanitized.map((word, index) => `${index + 1}. ${word}`).join('\n')
  return [
    'Transcribe the audio accurately.',
    'When the following terms occur, prefer these exact forms:',
    list
  ].join('\n')
}
