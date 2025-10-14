import { Ajv, type ErrorObject } from 'ajv'
import schema from '../schemas/lecture.intent.schema.json' with { type: 'json' }
import { registerPlugin } from './registry.js'
import { dataServiceRequest } from '../services/data-service.client.js'
import { ValidationError } from '../errors/validation.error.js'
import { SC } from '../constants/status-codes.js'
import type { PluginContext, PluginResponse } from '../types/index.js'

const ajv = new Ajv({ allErrors: true, strict: false })
const validateIntent = ajv.compile(schema)

type Operation =
  | 'list'
  | 'create'
  | 'update'
  | 'delete'
  | 'get'
  | 'transcription.append'
  | 'summary.append'
  | 'report.upsert'

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  if(!errors || errors.length === 0) return 'invalid payload'
  return errors
    .map((error) => {
      const path = error.instancePath || error.schemaPath || '#'
      return `${path} ${error.message ?? ''}`.trim()
    })
    .join('; ')
}

function ensureIntent(intent: any, expected: Operation){
  const ok = validateIntent(intent)
  if(!ok) throw new ValidationError(formatErrors(validateIntent.errors))
  if(intent.operation !== expected){
    throw new ValidationError(`operation must be ${expected}`)
  }
  return intent.inputs ?? {}
}

function ensureUserId(userId: string | undefined){
  if(!userId) throw new ValidationError('missing user id')
  return userId
}

function handleKnownError(error: any){
  if(error instanceof ValidationError){
    return { status_code: SC.BAD_REQUEST, message: error.message, data: {} }
  }
  const status = typeof error?.statusCode === 'number' ? error.statusCode : undefined
  if(status && status < 500){
    return { status_code: status, message: error.message ?? 'data service error', data: error.details ?? {} }
  }
  throw error
}

registerPlugin('lecture.list', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    ensureIntent(ctx.intent, 'list')
    const userId = ensureUserId(ctx.userId)
    const data = await dataServiceRequest('/lectures', { method: 'GET' }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})

registerPlugin('lecture.create', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    const inputs = ensureIntent(ctx.intent, 'create') as Record<string, unknown>
    const userId = ensureUserId(ctx.userId)
    const body = { ...inputs }
    const data = await dataServiceRequest('/lectures', { method: 'POST', body }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})

registerPlugin('lecture.update', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    const inputs = ensureIntent(ctx.intent, 'update') as Record<string, any>
    const userId = ensureUserId(ctx.userId)
    const lectureId = inputs.lecture_id
    const patch = { ...inputs }
    delete patch.lecture_id
    const data = await dataServiceRequest(`/lectures/${lectureId}`, { method: 'PATCH', body: patch }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})

registerPlugin('lecture.delete', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    const inputs = ensureIntent(ctx.intent, 'delete') as { lecture_id: string }
    const userId = ensureUserId(ctx.userId)
    const data = await dataServiceRequest(`/lectures/${inputs.lecture_id}`, { method: 'DELETE' }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})

registerPlugin('lecture.get', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    const inputs = ensureIntent(ctx.intent, 'get') as { lecture_id: string }
    const userId = ensureUserId(ctx.userId)
    const data = await dataServiceRequest(`/lectures/${inputs.lecture_id}`, { method: 'GET' }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})

registerPlugin('lecture.transcription.append', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    const inputs = ensureIntent(ctx.intent, 'transcription.append') as { lecture_id: string }
    const userId = ensureUserId(ctx.userId)
    const lectureId = inputs.lecture_id
    const body = { ...inputs }
    delete (body as any).lecture_id
    const data = await dataServiceRequest(`/lectures/${lectureId}/transcription`, { method: 'POST', body }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})

registerPlugin('lecture.summary.append', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    const inputs = ensureIntent(ctx.intent, 'summary.append') as { lecture_id: string }
    const userId = ensureUserId(ctx.userId)
    const lectureId = inputs.lecture_id
    const body = { ...inputs }
    delete (body as any).lecture_id
    const data = await dataServiceRequest(`/lectures/${lectureId}/transcription-summary`, { method: 'POST', body }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})

registerPlugin('lecture.report.upsert', async (ctx: PluginContext): Promise<PluginResponse> => {
  try {
    const inputs = ensureIntent(ctx.intent, 'report.upsert') as { lecture_id: string }
    const userId = ensureUserId(ctx.userId)
    const lectureId = inputs.lecture_id
    const body = { ...inputs }
    delete (body as any).lecture_id
    const data = await dataServiceRequest(`/lectures/${lectureId}/report`, { method: 'POST', body }, { userId, requestId: ctx.requestId })
    return { data, status_code: SC.OK, message: 'ok' }
  } catch (error) {
    return handleKnownError(error)
  }
})
