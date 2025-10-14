import { registerPlugin } from './registry.js'
import { ValidationError } from '../errors/validation.error.js'
import { SC } from '../constants/status-codes.js'
import { getConfig } from '../config.js'
import type { PluginContext, PluginResponse } from '../types/index.js'
import { z } from 'zod'
import OpenAI from 'openai'
import { randomUUID } from 'node:crypto'

const inputSchema = z.object({
  language: z.string().min(2, 'language is required'),
  summaries: z.string().min(1).optional(),
  question: z.string().min(1, 'question is required').max(4000, 'question too long'),
  conversation_id: z.string().min(1).optional()
})

type MessageRole = 'system' | 'user' | 'assistant' | 'developer'

registerPlugin('audio.dialogue', async ({ intent, userId }: PluginContext): Promise<PluginResponse> => {
  try {
    ensureUser(userId)
    if(intent?.operation !== 'chat'){
      return { status_code: SC.BAD_REQUEST, message: 'unsupported operation', data: {} }
    }
    const parsed = inputSchema.safeParse(intent.inputs ?? {})
    if(!parsed.success){
      return { status_code: SC.BAD_REQUEST, message: formatZodError(parsed.error), data: {} }
    }
    const { language, summaries, question, conversation_id } = parsed.data
    const { client, apiKey, baseURL } = createClient()

    if(conversation_id){
      const meta = await fetchConversation(apiKey, baseURL, conversation_id)
      const effectiveLanguage = language || meta.metadata.language || 'zh-CN'
      const now = new Date().toISOString()
      const answer = await continueConversation(client, conversation_id, { language: effectiveLanguage, summaries, question })
      const nextTurn = (Number(meta.metadata.turn ?? '0') || 0) + 1
      await updateConversation(apiKey, baseURL, conversation_id, meta.metadata, { language: effectiveLanguage, turn: String(nextTurn) })
      return {
        status_code: SC.OK,
        message: 'ok',
        data: {
          answer,
          conversation_id,
          turn: nextTurn,
          created_at: now
        }
      }
    }

    if(!summaries){
      return { status_code: SC.BAD_REQUEST, message: 'summaries is required for a new conversation', data: {} }
    }
    const { id: convId, metadata } = await createConversation(apiKey, baseURL, { language, turn: '0' })
    try {
      const answer = await startConversation(client, convId, { language, summaries, question })
      await updateConversation(apiKey, baseURL, convId, metadata, { language, turn: '1' })
      return {
        status_code: SC.OK,
        message: 'ok',
        data: {
          answer,
          conversation_id: convId,
          turn: 1,
          created_at: new Date().toISOString()
        }
      }
    } catch (error) {
      await deleteConversation(apiKey, baseURL, convId)
      throw error
    }
  } catch (error) {
    if(error instanceof ValidationError){
      return { status_code: SC.BAD_REQUEST, message: error.message, data: {} }
    }
    return {
      status_code: SC.INTERNAL,
      message: 'dialogue failed',
      data: {
        error: error instanceof Error ? error.message : String(error)
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

function createClient(){
  const config = getConfig()
  if(!config.openai.apiKey) throw new ValidationError('OPENAI_API_KEY is not configured')
  const { apiKey, baseURL } = config.openai
  return { client: new OpenAI({ apiKey, baseURL }), apiKey, baseURL }
}

async function createConversation(apiKey: string, baseURL: string, metadata: Record<string, string>){
  const url = new URL(baseURL.endsWith('/') ? `${baseURL}conversations` : `${baseURL}/conversations`)
  const payload: Record<string, string> = {}
  for(const [key, value] of Object.entries(metadata)){
    if(value === undefined || value === null) continue
    payload[key] = value
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ metadata: payload })
  })
  if(!res.ok){
    const text = await res.text().catch(() => '')
    throw new Error(`failed to create conversation: ${res.status} ${text}`)
  }
  const data = await res.json()
  const id = typeof data?.id === 'string' ? data.id : randomUUID()
  const meta = data?.metadata ?? metadata
  return { id, metadata: meta }
}

async function fetchConversation(apiKey: string, baseURL: string, id: string){
  const url = new URL(baseURL.endsWith('/') ? `${baseURL}conversations/${id}` : `${baseURL}/conversations/${id}`)
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    }
  })
  if(res.status === 404){
    throw new ValidationError(`unknown conversation: ${id}`)
  }
  if(!res.ok){
    const text = await res.text().catch(() => '')
    throw new Error(`failed to fetch conversation: ${res.status} ${text}`)
  }
  const data = await res.json()
  const rawMeta = typeof data?.metadata === 'object' && data.metadata ? data.metadata : {}
  const metadata: Record<string, string> = {}
  for(const [key, value] of Object.entries(rawMeta)){
    if(value === undefined || value === null) continue
    metadata[key] = typeof value === 'string' ? value : JSON.stringify(value)
  }
  return { metadata }
}

async function updateConversation(apiKey: string, baseURL: string, id: string, current: Record<string, string>, updates: Record<string, string>){
  const url = new URL(baseURL.endsWith('/') ? `${baseURL}conversations/${id}` : `${baseURL}/conversations/${id}`)
  const metadata: Record<string, string> = {}
  for(const [key, value] of Object.entries({ ...current, ...updates })){
    if(value === undefined || value === null) continue
    metadata[key] = value
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ metadata })
  })
  if(!res.ok){
    const text = await res.text().catch(() => '')
    throw new Error(`failed to update conversation: ${res.status} ${text}`)
  }
}

async function deleteConversation(apiKey: string, baseURL: string, id: string){
  const url = new URL(baseURL.endsWith('/') ? `${baseURL}conversations/${id}` : `${baseURL}/conversations/${id}`)
  await fetch(url, {
    method: 'DELETE',
    headers: {
      'authorization': `Bearer ${apiKey}`,
      'content-type': 'application/json'
    }
  }).catch(() => {})
}

interface StartPayload {
  language: string
  summaries: string
  question: string
}

async function startConversation(client: OpenAI, conversationId: string, payload: StartPayload){
  const config = getConfig()
  const request: any = {
    model: config.openai.models.dialogue,
    conversation: conversationId,
    input: [
      { role: 'system', content: [{ type: 'input_text', text: buildInitialPrompt(payload.language, payload.summaries) }] },
      { role: 'user', content: [{ type: 'input_text', text: payload.question }] }
    ]
  }
  const response = await (client.responses.create as any)(request)
  return extractAnswer(response)
}

interface ContinuePayload {
  language: string
  summaries?: string
  question: string
}

async function continueConversation(client: OpenAI, conversationId: string, payload: ContinuePayload){
  const config = getConfig()
  const messages: Array<{ role: MessageRole; content: { type: string; text: string }[] }> = []
  if(payload.summaries){
    messages.push({ role: 'developer', content: [{ type: 'input_text', text: buildAdditionalSummary(payload.summaries) }] })
  }
  messages.push({ role: 'user', content: [{ type: 'input_text', text: payload.question }] })
  const request: any = {
    model: config.openai.models.dialogue,
    conversation: conversationId,
    input: messages
  }
  const response = await (client.responses.create as any)(request)
  return extractAnswer(response)
}

function buildInitialPrompt(language: string, summaries: string){
  return [
    `你是一个助手，请使用中文回答问题。`,
    '请使用以下课程阶段摘要来回答问题。如果答案不存在，请说明无法找到相关信息。',
    '阶段摘要：',
    summaries.trim()
  ].join('\n\n')
}

function buildAdditionalSummary(summaries: string){
  return ['附加阶段信息：', summaries.trim()].join('\n')
}

function extractAnswer(response: any): string {
  if(typeof response?.output_text === 'string' && response.output_text.trim()){
    return response.output_text.trim()
  }
  if(Array.isArray(response?.output)){
    const parts: string[] = []
    for(const item of response.output){
      const content = Array.isArray(item?.content) ? item.content : []
      for(const part of content){
        if(typeof part?.text === 'string') parts.push(part.text)
      }
    }
    if(parts.length) return parts.join('\n').trim()
  }
  return ''
}
