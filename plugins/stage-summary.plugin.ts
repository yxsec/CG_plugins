import { registerPlugin } from './registry.js'
import { ValidationError } from '../errors/validation.error.js'
import { SC } from '../constants/status-codes.js'
import { getConfig } from '../config.js'
import type { PluginContext, PluginResponse } from '../types/index.js'
import { z } from 'zod'
import OpenAI from 'openai'

const stageSchema = z.object({
  previous2: z.string().optional(),
  previous: z.string().optional(),
  current: z.string().min(20, 'current text is too short'),
  language: z.string().min(2, 'language is required'),
  keywords: z.array(z.string().min(1)).max(50).optional()
})

const JSON_SCHEMA = {
  name: 'StageTranscriptionSummary',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', description: '一句话总结当前阶段的核心内容。' },
      highlights: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 6,
        description: '列出最重要、需要记住的要点（3-6条）。'
      },
      knowledge_keywords: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        description: '与当前内容相关的知识点关键词。'
      }
    },
    required: ['summary', 'highlights', 'knowledge_keywords']
  }
} as const

registerPlugin('audio.stage-summary', async ({ intent, userId }: PluginContext): Promise<PluginResponse> => {
  try {
    ensureUser(userId)
    if (intent?.operation !== 'stage') {
      return { status_code: SC.BAD_REQUEST, message: 'unsupported operation', data: {} }
    }
    const parsed = stageSchema.safeParse(intent.inputs ?? {})
    if (!parsed.success) {
      return { status_code: SC.BAD_REQUEST, message: formatZodError(parsed.error), data: {} }
    }
    const { previous2, previous, current, language, keywords } = parsed.data
    const client = createOpenAIClient()
    const result = await summarizeStage(client, { previous2, previous, current, language, keywords: keywords ?? [] })
    return { status_code: SC.OK, message: 'ok', data: result }
  } catch (error) {
    if (error instanceof ValidationError) {
      return { status_code: SC.BAD_REQUEST, message: error.message, data: {} }
    }
    return {
      status_code: SC.INTERNAL,
      message: 'stage summary failed',
      data: { error: error instanceof Error ? error.message : String(error) }
    }
  }
})

function ensureUser(userId: string | undefined) {
  if (!userId) throw new ValidationError('missing user id')
  return userId
}

function formatZodError(error: z.ZodError) {
  return error.issues.map((issue) => issue.message ?? issue.code).join('; ') || 'invalid inputs'
}

interface StagePayload {
  previous2?: string
  previous?: string
  current: string
  language: string
  keywords: string[]
}

function createOpenAIClient(): OpenAI {
  const config = getConfig()
  if (!config.openai.apiKey) throw new ValidationError('OPENAI_API_KEY is not configured')
  return new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL })
}

async function summarizeStage(client: OpenAI, payload: StagePayload) {
  const config = getConfig()
  const prompt = buildPrompt(payload)

  const response: any = await client.responses.create({
    model: config.openai.models.stageSummary,
    input: [
      { role: 'system', content: '只输出合法 JSON，不要任何额外文字。' },
      { role: 'user', content: [{ type: 'input_text', text: prompt }] }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: JSON_SCHEMA
    },
    temperature: 0,
    store: false
  } as any)

  const parsed = response.output_parsed ?? extractJsonPayload(response)
  return normalizeSummary(parsed)
}

function buildPrompt({ previous2, previous, current, language, keywords }: StagePayload) {
  const sections = [{ title: '当前片段原文', body: current.trim() }]
  if (previous) { sections.unshift({ title: '上一个阶段内容', body: previous.trim() }) }
  if (previous2) { sections.unshift({ title: '上上一个阶段内容', body: previous2.trim() }) }
  const keywordText = keywords.length
    ? `偏好术语：${keywords.map((w) => w.replace(/[\r\n]+/g, ' ').trim()).filter(Boolean).join('，')}`
    : ''
  const instruction = [
    `请使用${language || '中文'}输出阶段性总结，保持专业口吻。`,
    '输出一个 JSON，包含：',
    '- summary: 一句话总结当前阶段。',
    '- highlights: 3-6 条最重要要点。',
    '- knowledge_keywords: 与内容相关的知识点关键词（5-8个词语）。',
    '如果上文有前序阶段内容，请综合考虑以保持连贯，强调本阶段的新信息，但不需要总结前序阶段内容。'
  ]
  if (keywordText) instruction.push(keywordText)
  const content = sections.map((s) => `【${s.title}】\n${s.body}`).join('\n\n')
  return [instruction.join('\n'), content].join('\n\n')
}

function extractJsonPayload(response: any) {
  if (!response) return undefined
  const output = Array.isArray(response.output) ? response.output : []
  for (const item of output) {
    if (item?.type === 'output_json' && item?.json) return item.json
    const content = Array.isArray(item?.content) ? item.content : []
    for (const part of content) {
      if (typeof part?.parsed === 'object' && part.parsed) return part.parsed
      if (part?.type === 'output_json' && part.json) return part.json
      if (part?.type === 'output_text' && typeof part.text === 'string') {
        const trimmed = part.text.trim()
        if (trimmed.startsWith('{')) {
          try { return JSON.parse(trimmed) } catch {}
        }
      }
    }
  }
  const text = typeof response.output_text === 'string' ? response.output_text.trim() : ''
  if (text) { try { return JSON.parse(text) } catch {} }
  throw new Error('OpenAI response missing JSON payload')
}

function normalizeSummary(raw: any) {
  return {
    summary: ensureString(raw?.summary),
    highlights: ensureArray(raw?.highlights),
    knowledge_keywords: ensureArray(raw?.knowledge_keywords)
  }
}

function ensureString(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (value === null || value === undefined) return ''
  return String(value)
}

function ensureArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((item) => ensureString(item)).filter(Boolean)
  if (typeof value === 'string') return value.split(/\r?\n|[,;；、]/).map((s) => s.trim()).filter(Boolean)
  return []
}
