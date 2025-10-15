import { registerPlugin } from './registry.js'
import { ValidationError } from '../errors/validation.error.js'
import { SC } from '../constants/status-codes.js'
import { getConfig } from '../config.js'
import type { PluginContext, PluginResponse } from '../types/index.js'
import { z } from 'zod'
import OpenAI from 'openai'

// 支持两种输入方式：
// 1. 直接传递内容：{ language, stage_summaries, conversation_text?, file_ids? }
// 2. 传递 lectureId：{ lectureId }，插件自动获取数据
function createInputSchema() {
  const config = getConfig()
  return z.union([
    z.object({
      language: z.string().min(2, 'language is required'),
      stage_summaries: z.string().min(1, 'stage_summaries is required'),
      conversation_text: z.string().optional(),
      file_ids: z.array(z.string().min(1)).max(config.openai.limits.maxFileIds).optional()
    }),
    z.object({
      lectureId: z.string().min(1, 'lectureId is required')
    })
  ])
}

const OUTPUT_SCHEMA = {
  type: 'json_schema',
  name: 'CourseSummaryReport',
  description: '结构化课程总结输出',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      sections: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'summary', 'items'],
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            items: {
              type: 'array',
              minItems: 1,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['heading', 'summary', 'details'],
                properties: {
                  heading: { type: 'string' },
                  summary: { type: 'string' },
                  details: {
                    type: 'array',
                    minItems: 1,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      required: ['point', 'explanation', 'example'],
                      properties: {
                        point: { type: 'string' },
                        explanation: { type: 'string' },
                        example: { type: 'string' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },
      next_actions: {
        type: 'array',
        items: { type: 'string' }
      }
    },
    required: ['sections', 'next_actions']
  }
} as const

registerPlugin('audio.summary', async ({ intent, userId, requestId }: PluginContext): Promise<PluginResponse> => {
  const logPrefix = `[course-summary-plugin] [${requestId}]`
  try {
    console.log(`${logPrefix} 插件被调用`, { operation: intent?.operation, userId })
    
    ensureUser(userId)
    console.log(`${logPrefix} 用户验证通过: ${userId}`)
    
    if(intent?.operation !== 'summarize'){
      console.log(`${logPrefix} 操作不支持: ${intent?.operation}`)
      return { status_code: SC.BAD_REQUEST, message: 'unsupported operation', data: {} }
    }
    
    console.log(`${logPrefix} 开始解析输入参数`)
    const inputSchema = createInputSchema()
    const parsed = inputSchema.safeParse(intent.inputs ?? {})
    if(!parsed.success){
      console.error(`${logPrefix} 输入参数验证失败:`, parsed.error)
      return { status_code: SC.BAD_REQUEST, message: formatZodError(parsed.error), data: {} }
    }
    
    // 检查输入类型并获取数据
    let language: string
    let stage_summaries: string
    let conversation_text: string | undefined
    let file_ids: string[] | undefined
    
    if ('lectureId' in parsed.data) {
      // 模式 2：通过 lectureId 获取数据
      const { lectureId } = parsed.data
      console.log(`${logPrefix} 使用 lectureId 模式，开始获取课程数据: ${lectureId}`)
      
      // 导入 dataServiceRequest 来获取课程数据
      const { dataServiceRequest } = await import('../services/data-service.client.js')
      
      // 获取课程详情
      try {
        const lecture = await dataServiceRequest<any>(
          `/lectures/${lectureId}`,
          { method: 'GET' },
          { userId, requestId }
        )
        language = lecture.lecture?.language || 'zh'
        file_ids = lecture.lecture?.file_ids
        console.log(`${logPrefix} 课程数据获取成功`, { language, fileIdsCount: file_ids?.length || 0 })
      } catch (error) {
        console.error(`${logPrefix} 获取课程数据失败:`, error)
        return { status_code: SC.BAD_REQUEST, message: 'failed to fetch lecture data', data: {} }
      }
      
      // 获取阶段总结数据
      try {
        const summaryResult = await dataServiceRequest<{ stage_summaries_text: string; total_length: number }>(
          `/lectures/${lectureId}/stage-summaries-text`,
          { method: 'GET' },
          { userId, requestId }
        )
        stage_summaries = summaryResult.stage_summaries_text
        console.log(`${logPrefix} 阶段总结获取成功`, { summaryLength: stage_summaries.length, totalLength: summaryResult.total_length })
      } catch (error) {
        console.error(`${logPrefix} 获取阶段总结失败:`, error)
        return { status_code: SC.BAD_REQUEST, message: 'failed to fetch stage summaries', data: {} }
      }
      
      // 对话记录在当前系统中没有存储，保持为 undefined
      // conversation_text 是可选参数，不影响课程总结生成
      console.log(`${logPrefix} 对话记录功能尚未实现，跳过`)
      
      console.log(`${logPrefix} 通过 lectureId 获取数据完成`, {
        language,
        summaryLength: stage_summaries.length,
        hasConversation: !!conversation_text,
        fileIdsCount: file_ids?.length || 0
      })
    } else {
      // 模式 1：直接使用传入的数据
      language = parsed.data.language
      stage_summaries = parsed.data.stage_summaries
      conversation_text = parsed.data.conversation_text
      file_ids = parsed.data.file_ids
      
      console.log(`${logPrefix} 使用直接传入模式，输入参数解析成功`, {
        language,
        summaryLength: stage_summaries.length,
        hasConversation: !!conversation_text,
        fileIdsCount: file_ids?.length || 0
      })
    }
    
    const config = getConfig()
    const minLength = config.openai.limits.minSummaryLength
    if(stage_summaries.trim().length < minLength){
      console.warn(`${logPrefix} 阶段总结长度不足: ${stage_summaries.trim().length} < ${minLength}`)
      return { status_code: SC.BAD_REQUEST, message: `stage_summaries too short (min ${minLength} chars)` , data: {} }
    }
    
    console.log(`${logPrefix} 创建 OpenAI 客户端`)
    const client = createClient()
    
    const model = config.openai.models.courseSummary
    console.log(`${logPrefix} 开始调用 OpenAI API`, { model })
    const response: any = await client.responses.create({
      model,
      input: buildMessages({ language, stage_summaries, conversation_text, file_ids }),
      response_format: {
        type: 'json_schema',
        json_schema: OUTPUT_SCHEMA
      },
      store: false
    } as any)
    console.log(`${logPrefix} OpenAI API 调用完成`)
    
    const report = response.output_parsed ?? extractFromResponse(response)
    if(!report){
      console.error(`${logPrefix} OpenAI 返回空结果`)
      return { status_code: SC.INTERNAL, message: 'empty summary response', data: {} }
    }
    
    const structuredReport = ensureReportStructure(report)
    
    console.log(`${logPrefix} 课程总结生成成功`, {
      sectionsCount: structuredReport?.sections?.length || 0,
      actionsCount: structuredReport?.next_actions?.length || 0
    })
    
    // 如果是通过 lectureId 模式生成的，自动保存到数据库
    if ('lectureId' in parsed.data) {
      const { lectureId } = parsed.data
      try {
        const { dataServiceRequest } = await import('../services/data-service.client.js')
        await dataServiceRequest(
          `/lectures/${lectureId}/report`,
          {
            method: 'POST',
            body: {
              seq_no: 1, // 课程总结固定为 seq_no = 1
              md: JSON.stringify(structuredReport)
            }
          },
          { userId, requestId }
        )
        console.log(`${logPrefix} 课程总结已保存到数据库`, { lectureId })
      } catch (saveError) {
        console.error(`${logPrefix} 保存课程总结到数据库失败:`, saveError)
        // 保存失败不影响返回结果，但记录错误
      }
    }
    
    return {
      status_code: SC.OK,
      message: 'ok',
      data: structuredReport
    }
  } catch (error) {
    console.error(`${logPrefix} 插件执行失败:`, {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined
    })
    
    if(error instanceof ValidationError){
      return { status_code: SC.BAD_REQUEST, message: error.message, data: {} }
    }
    return {
      status_code: SC.INTERNAL,
      message: 'summary failed',
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
  return error.issues.map((issue) => issue.message ?? error.message).join('; ') || 'invalid inputs'
}

function createClient(){
  const config = getConfig()
  if(!config.openai.apiKey) throw new ValidationError('OPENAI_API_KEY is not configured')
  return new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL })
}

interface MessagePayload {
  language: string
  stage_summaries: string
  conversation_text?: string
  file_ids?: string[]
}

function buildMessages(payload: MessagePayload){
  const { language, stage_summaries, conversation_text, file_ids } = payload
  const messages: any[] = []
  messages.push({
    role: 'system',
    content: [{ type: 'input_text', text: buildSystemPrompt(language) }]
  })
  messages.push({
    role: 'developer',
    content: [{ type: 'input_text', text: buildSummaryContext(stage_summaries) }]
  })
  if(conversation_text && conversation_text.trim()){
    messages.push({
      role: 'developer',
      content: [{ type: 'input_text', text: buildDialogueContext(conversation_text) }]
    })
  }
  const userContent: any[] = [{ type: 'input_text', text: buildUserInstruction(language) }]
  if(Array.isArray(file_ids)){
    for(const fileId of file_ids){
      userContent.push({ type: 'input_file', file_id: fileId })
    }
  }
  messages.push({ role: 'user', content: userContent })
  return messages
}

function buildSystemPrompt(language: string){
  return [
    `你是一位教学设计专家，请始终使用 ${language} 输出。`,
    '你的任务是生成以学习者为中心的课程总结。必须结合提供的阶段性总结、课中对话和课程资料，不得凭空编造。',
    '报告需要让学习者能够理解、记忆并付诸实践。内容要严谨、条理清晰，语言专业但易于理解。'
  ].join('\n')
}

function buildSummaryContext(text: string){
  return ['【阶段性总结资料】', text.trim()].join('\n')
}

function buildDialogueContext(text: string){
  return ['【AI 对话记录】', text.trim()].join('\n')
}

function buildUserInstruction(language: string){
  return [
    '请根据以上材料生成课程总结，要求：',
    '1. 输出 JSON，与提供的模式完全一致。',
    '2. `sections` 用层次结构呈现课程要点：',
    '   - 每个 section 代表一个“大点”，包含标题(`title`)、概述(`summary`)。',
    '   - 每个 section 下的 `items` 代表核心主题，每个 item 需包含 `heading`、`summary` 以及 `details`。',
    '   - `details` 数组用于说明该主题下的关键点，元素格式为 { point, explanation, example }。数量不限，由你根据主题的重要性与资料深度自行决定；如果某个要点暂时不需要案例，请将 `example` 置为空字符串。',
    '   - 请根据资料内容自由组织核心主题和要点，覆盖所有重要知识点。',
    '3. `next_actions` 提供针对学习者的后续建议或复习计划，可为空数组。',
    '4. 总结要学习导向，兼顾理解、记忆与应用场景；若资料缺失，请明确指出。',
    `5. 所有文字（包括 JSON 中的字段值）必须使用 中文 表达。`
  ].join('\n')
}

function ensureReportStructure(report: any){
  if(!Array.isArray(report.sections)) report.sections = []
  if(!Array.isArray(report.next_actions)) report.next_actions = []
  for(const section of report.sections){
    if(!section || typeof section !== 'object') continue
    if(typeof section.title !== 'string') section.title = ''
    if(typeof section.summary !== 'string') section.summary = ''
    if(!Array.isArray(section.items)) section.items = []
    for(const item of section.items){
      if(!item || typeof item !== 'object') continue
      if(typeof item.heading !== 'string') item.heading = ''
      if(typeof item.summary !== 'string') item.summary = ''
      if(!Array.isArray(item.details)) item.details = []
      for(const detail of item.details){
        if(!detail || typeof detail !== 'object') continue
        if(typeof detail.point !== 'string') detail.point = ''
        if(typeof detail.explanation !== 'string') detail.explanation = ''
        if(typeof detail.example !== 'string') detail.example = ''
      }
    }
  }
  return report
}

function extractFromResponse(response: any){
  if(!response) return undefined
  const output = Array.isArray(response.output) ? response.output : []
  for(const item of output){
    if(item?.type === 'output_json' && item?.json) return item.json
    const content = Array.isArray(item?.content) ? item.content : []
    for(const part of content){
      if(typeof part?.parsed === 'object' && part.parsed) return part.parsed
      if(part?.type === 'output_json' && part?.json) return part.json
      if(part?.type === 'output_text' && typeof part.text === 'string'){
        const trimmed = part.text.trim()
        if(trimmed.startsWith('{')){
          try {
            return JSON.parse(trimmed)
          } catch {}
        }
      }
    }
  }
  const text = typeof response.output_text === 'string' ? response.output_text.trim() : ''
  if(text){
    try {
      return JSON.parse(text)
    } catch {}
  }
  return undefined
}
