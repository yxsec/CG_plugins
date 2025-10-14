import { z } from 'zod'
import { registerPlugin } from './registry.js'
import { dataServiceRequest } from '../services/data-service.client.js'
import type { PluginContext, PluginResponse } from '../types/index.js'

// ==================== Schema 定义 ====================

// 获取讲座详情
const getLectureSchema = z.object({
  lectureId: z.string().min(1, 'lectureId is required')
})

// 创建讲座
const createLectureSchema = z.object({
  lecture_id: z.string().nullish(),
  file_id: z.string().nullish(),
  courseCode: z.string().nullish(),
  language: z.string().nullish(),
  sessionName: z.string().nullish(),
  subtitle: z.string().nullish(),
  description: z.string().nullish(),
  outline: z.unknown().optional(),
  audioDeviceId: z.string().nullish(),
  audioDeviceLabel: z.string().nullish(),
  audioReady: z.boolean().optional(),
  status: z.number().nullish()
})

// 更新讲座
const updateLectureSchema = z.object({
  lectureId: z.string().min(1),
  file_id: z.string().nullish(),
  courseCode: z.string().nullish(),
  language: z.string().nullish(),
  sessionName: z.string().nullish(),
  subtitle: z.string().nullish(),
  description: z.string().nullish(),
  outline: z.unknown().optional(),
  audioDeviceId: z.string().nullish(),
  audioDeviceLabel: z.string().nullish(),
  audioReady: z.boolean().optional(),
  status: z.number().nullish()
})

// 删除讲座
const deleteLectureSchema = z.object({
  lectureId: z.string().min(1)
})

// 列出讲座
const listLecturesSchema = z.object({})

// 添加转录
const appendTranscriptionSchema = z.object({
  lecture_id: z.string().min(1),
  t_start_ms: z.number().nonnegative(),
  t_end_ms: z.number().nonnegative(),
  content: z.string().min(1),
  seq_no: z.number().positive().optional(),
  start_at: z.string().optional(),
  end_at: z.string().optional()
})

// 添加总结
const appendSummarySchema = appendTranscriptionSchema

// 更新报告
const upsertReportSchema = z.object({
  lecture_id: z.string().min(1),
  seq_no: z.number().positive(),
  md: z.string().min(1)
})

// 获取课后背景信息
const getPostClassBackgroundSchema = z.object({
  lectureId: z.string().min(1, 'lectureId is required')
})

// 获取阶段总结文本
const getStageSummariesTextSchema = z.object({
  lectureId: z.string().min(1)
})

// ==================== Operation 映射 ====================

const OPERATION_SCHEMAS: Record<string, z.ZodSchema> = {
  'getLecture': getLectureSchema,
  'createLecture': createLectureSchema,
  'updateLecture': updateLectureSchema,
  'deleteLecture': deleteLectureSchema,
  'listLectures': listLecturesSchema,
  'appendTranscription': appendTranscriptionSchema,
  'appendSummary': appendSummarySchema,
  'upsertReport': upsertReportSchema,
  'getPostClassBackground': getPostClassBackgroundSchema,
  'getStageSummariesText': getStageSummariesTextSchema
}

// ==================== Plugin Handler ====================

registerPlugin('data.proxy', async ({ intent, userId, requestId }: PluginContext): Promise<PluginResponse> => {
  const operation = intent?.operation
  const inputs = intent?.inputs || {}
  
  console.log('[data-proxy] 接收请求', {
    operation,
    userId,
    requestId,
    inputKeys: Object.keys(inputs)
  })
  
  // 1. 验证 operation
  const schema = OPERATION_SCHEMAS[operation]
  if (!schema) {
    console.error('[data-proxy] 不支持的操作', { operation })
    return {
      status_code: 400,
      message: `不支持的操作: ${operation}`,
      data: null
    }
  }
  
  // 2. 验证输入
  const parseResult = schema.safeParse(inputs)
  if (!parseResult.success) {
    console.error('[data-proxy] 输入验证失败', {
      operation,
      errors: parseResult.error.errors
    })
    return {
      status_code: 400,
      message: '输入参数验证失败',
      data: parseResult.error.errors
    }
  }
  
  const validatedInputs = parseResult.data
  
  try {
    // 3. 根据 operation 调用 Data Service
    let result: any
    
    switch (operation) {
      case 'getLecture': {
        const { lectureId } = validatedInputs as z.infer<typeof getLectureSchema>
        result = await dataServiceRequest(
          `/lectures/${lectureId}`,
          { method: 'GET' },
          { userId, requestId }
        )
        break
      }
      
      case 'createLecture': {
        result = await dataServiceRequest(
          '/lectures',
          {
            method: 'POST',
            body: validatedInputs
          },
          { userId, requestId }
        )
        break
      }
      
      case 'updateLecture': {
        const { lectureId, ...patch } = validatedInputs as z.infer<typeof updateLectureSchema>
        result = await dataServiceRequest(
          `/lectures/${lectureId}`,
          {
            method: 'PATCH',
            body: patch
          },
          { userId, requestId }
        )
        break
      }
      
      case 'deleteLecture': {
        const { lectureId } = validatedInputs as z.infer<typeof deleteLectureSchema>
        result = await dataServiceRequest(
          `/lectures/${lectureId}`,
          { method: 'DELETE' },
          { userId, requestId }
        )
        break
      }
      
      case 'listLectures': {
        result = await dataServiceRequest(
          '/lectures',
          { method: 'GET' },
          { userId, requestId }
        )
        break
      }
      
      case 'appendTranscription': {
        const { lecture_id, ...entry } = validatedInputs as z.infer<typeof appendTranscriptionSchema>
        result = await dataServiceRequest(
          `/lectures/${lecture_id}/transcription`,
          {
            method: 'POST',
            body: entry
          },
          { userId, requestId }
        )
        break
      }
      
      case 'appendSummary': {
        const { lecture_id, ...entry } = validatedInputs as z.infer<typeof appendSummarySchema>
        result = await dataServiceRequest(
          `/lectures/${lecture_id}/transcription-summary`,
          {
            method: 'POST',
            body: entry
          },
          { userId, requestId }
        )
        break
      }
      
      case 'upsertReport': {
        const { lecture_id, seq_no, md } = validatedInputs as z.infer<typeof upsertReportSchema>
        result = await dataServiceRequest(
          `/lectures/${lecture_id}/report`,
          {
            method: 'POST',
            body: { seq_no, md }
          },
          { userId, requestId }
        )
        break
      }
      
      case 'getPostClassBackground': {
        const { lectureId } = validatedInputs as z.infer<typeof getPostClassBackgroundSchema>
        result = await dataServiceRequest(
          `/lectures/${lectureId}/post-class-background`,
          { method: 'GET' },
          { userId, requestId }
        )
        break
      }
      
      case 'getStageSummariesText': {
        const { lectureId } = validatedInputs as z.infer<typeof getStageSummariesTextSchema>
        result = await dataServiceRequest(
          `/lectures/${lectureId}/stage-summaries-text`,
          { method: 'GET' },
          { userId, requestId }
        )
        break
      }
      
      default:
        console.error('[data-proxy] 未实现的操作', { operation })
        return {
          status_code: 400,
          message: `未实现的操作: ${operation}`,
          data: null
        }
    }
    
    console.log('[data-proxy] 调用成功', {
      operation,
      requestId,
      hasResult: !!result
    })
    
    return {
      status_code: 200,
      message: 'success',
      data: result
    }
    
  } catch (error) {
    console.error('[data-proxy] 调用失败', {
      operation,
      requestId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
    
    return {
      status_code: 500,
      message: error instanceof Error ? error.message : '未知错误',
      data: null
    }
  }
})
