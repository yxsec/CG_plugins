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

const SUPPORTED_EXTS = new Set([
  '.pdf',
  '.ppt',
  '.pptx',
  '.doc',
  '.docx',
  '.txt',
  '.md',
  '.markdown'
])

const analyzeSchema = z.object({
  file: z.object({
    name: z.string().min(1, 'file.name is required'),
    mime_type: z.string().min(1, 'file.mime_type is required'),
    data: z.string().min(1, 'file.data (base64) is required'),
    size: z.number().int().positive().optional()
  })
})

const COURSE_PROFILE_FORMAT = {
  type: 'json_schema',
  name: 'CourseProfile',
  description: '课程画像 JSON 输出格式',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      courseCode: { type: 'string', description: '课程代码；若缺失请返回空字符串。' },
      sessionName: { type: 'string', description: '本次会话/课程标题（最能代表这个文件内容的推测标题）；若缺失请返回空字符串。' },
      subtitle: { type: 'string', description: '会话副标题/讲次标题（比如Lecture 3 (26 & 29 Aug 2025)；若缺失请返回空字符串。' },
      description: { type: 'string', description: '课程简介，50-120 字；若缺失请返回空字符串。' },
      outline: {
        type: 'array',
        items: { type: 'string' },
        description: '课程大纲，数组元素为简短主题；若缺失请返回空数组。'
      }
    },
    required: ['courseCode', 'sessionName', 'subtitle', 'description', 'outline']
  }
} as const

registerPlugin('material.analyze', async ({ intent, userId }: PluginContext): Promise<PluginResponse> => {
  console.log('[course-material] 开始材料分析请求', { userId, operation: intent?.operation })
  
  try {
    ensureUser(userId)
    if(intent?.operation !== 'analyze'){
      console.log('[course-material] 操作类型错误:', intent?.operation)
      return { status_code: SC.BAD_REQUEST, message: 'unsupported operation', data: {} }
    }
    
    console.log('[course-material] 验证输入参数...')
    const parsed = analyzeSchema.safeParse(intent.inputs ?? {})
    if(!parsed.success){
      console.error('[course-material] 参数验证失败:', parsed.error)
      return { status_code: SC.BAD_REQUEST, message: formatZodError(parsed.error), data: {} }
    }
    
    const { file } = parsed.data
    console.log('[course-material] 文件信息:', { 
      name: file.name, 
      mime_type: file.mime_type, 
      size: file.size,
      dataLength: file.data.length 
    })
    
    console.log('[course-material] 解码 base64 文件数据...')
    const buffer = decodeBase64(file.data)
    console.log('[course-material] 文件解码完成，大小:', buffer.length, 'bytes')
    
    console.log('[course-material] 检查文件限制...')
    enforceLimits(file, buffer)
    
    console.log('[course-material] 创建 OpenAI 客户端...')
    const client = createOpenAIClient()
    
    console.log('[course-material] 上传文件到 OpenAI...')
    const uploaded = await uploadFile(client, buffer, file.name, file.mime_type)
    console.log('[course-material] 文件上传成功, file_id:', uploaded.id)
    
    console.log('[course-material] 开始分析文件内容...')
    // 默认中文；后续若有外部语言参数，可替换第四个参数
    const profile = await requestAnalysis(client, uploaded.id, file.name, '中文')
    console.log('[course-material] 分析完成:', profile)
    
    return {
      status_code: SC.OK,
      message: 'ok',
      data: {
        ...profile,
        fileID: uploaded.id
      }
    }
  } catch (error) {
    console.error('[course-material] 材料分析失败:', error)
    if(error instanceof ValidationError){
      return { status_code: SC.BAD_REQUEST, message: error.message, data: {} }
    }
    return {
      status_code: SC.INTERNAL,
      message: 'material analysis failed',
      data: {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      }
    }
  }
})

function ensureUser(userId: string | undefined): string {
  if(!userId) throw new ValidationError('missing user id')
  return userId
}

function formatZodError(error: z.ZodError){
  return error.issues.map((issue) => issue.message ?? issue.code).join('; ') || 'invalid inputs'
}

function decodeBase64(value: string): Buffer {
  console.log('[course-material] 解码 base64, 长度:', value.length)
  const trimmed = value.trim()
  const payload = trimmed.startsWith('data:') ? trimmed.slice(trimmed.indexOf(',') + 1) : trimmed
  try {
    const buffer = Buffer.from(payload, 'base64')
    console.log('[course-material] base64 解码成功, 缓冲区大小:', buffer.length)
    return buffer
  } catch (error) {
    console.error('[course-material] base64 解码失败:', error)
    throw new ValidationError('file.data is not valid base64')
  }
}

function enforceLimits(file: { name: string; size?: number }, buffer: Buffer){
  const config = getConfig()
  const ext = normalizeExt(file.name)
  console.log('[course-material] 检查文件限制:', { ext, bufferSize: buffer.length, maxBytes: config.openai.limits.maxFileBytes })
  
  if(!SUPPORTED_EXTS.has(ext)){
    console.error('[course-material] 不支持的文件扩展名:', ext)
    throw new ValidationError(`unsupported file extension: ${ext || '<unknown>'}`)
  }
  const maxBytes = config.openai.limits.maxFileBytes
  if(buffer.length > maxBytes || (file.size ?? buffer.length) > maxBytes){
    console.error('[course-material] 文件太大:', { size: buffer.length, max: maxBytes })
    throw new ValidationError(`file too large (max ${Math.floor(maxBytes / 1024 / 1024)} MB)`)
  }
  console.log('[course-material] 文件限制检查通过')
}

function normalizeExt(filename: string): string {
  return path.extname(filename || '').toLowerCase()
}

function createOpenAIClient(): OpenAI {
  const config = getConfig()
  console.log('[course-material] 创建 OpenAI 客户端:', { 
    hasApiKey: !!config.openai.apiKey, 
    apiKeyPrefix: config.openai.apiKey?.substring(0, 10),
    baseURL: config.openai.baseURL 
  })
  
  if(!config.openai.apiKey) {
    console.error('[course-material] OpenAI API Key 未配置')
    throw new ValidationError('OPENAI_API_KEY is not configured')
  }
  
  return new OpenAI({ apiKey: config.openai.apiKey, baseURL: config.openai.baseURL })
}

async function uploadFile(client: OpenAI, buffer: Buffer, name: string, mimeType: string){
  console.log('[course-material] 准备上传文件:', { name, mimeType, size: buffer.length })
  try {
    const file = await toFile(buffer, name || 'material-upload', { type: mimeType })
    const result = await client.files.create({ file, purpose: 'assistants' })
    console.log('[course-material] 文件上传成功:', result.id)
    return result
  } catch (error) {
    console.error('[course-material] 文件上传失败:', error)
    throw error
  }
}

/**
 * 新签名：增加 language，默认中文
 */
async function requestAnalysis(
  client: OpenAI,
  fileId: string,
  fileName: string = 'material',
  language: string = '中文'
){
  const config = getConfig()
  console.log('[course-material] 请求 OpenAI 分析, file_id:', fileId, 'model:', config.openai.models.material, 'language:', language)
  
  try {
    const response: any = await client.responses.create({
      model: config.openai.models.material,
      input: [
        {
          role: 'system',
          content: [{ type: 'input_text', text: buildSystemPrompt(language) }]
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: (language && !/^zh/i.test(language))
                ? `Please generate the course profile JSON from the uploaded material (“${fileName}”).`
                : `请根据我上传的课程资料（${fileName}）生成课程画像 JSON。`
            },
            { type: 'input_file', file_id: fileId }
          ]
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: COURSE_PROFILE_FORMAT
      },
      store: false
    } as any)
    
    console.log('[course-material] OpenAI 响应状态:', response?.status || 'unknown')
    console.log('[course-material] 提取 JSON 结果...')
    
    const raw = response.output_parsed ?? extractJsonPayload(response)
    if (!raw) {
      console.error('[course-material] 无法从响应中提取 JSON:', response)
      throw new Error('OpenAI response missing JSON payload')
    }
    
    console.log('[course-material] JSON 提取成功')
    return normalizeProfile(raw)
    
  } catch (error) {
    console.error('[course-material] OpenAI 分析失败:', {
      error: error instanceof Error ? error.message : String(error),
      type: (error as any)?.constructor?.name,
      status: (error as any)?.status,
      code: (error as any)?.code
    })
    throw new Error(`OpenAI analysis failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * 带语言切换的系统提示：默认中文，否则用传入语言
 */
function buildSystemPrompt(language: string): string {
  const lang = (language || '').trim() || '中文'
  const isZh = lang === '中文' || /^(zh|zh-CN|zh-TW|Chinese)$/i.test(lang)

  const l1 = isZh
    ? '你是一名教育内容分析师。'
    : 'You are an educational content analyst.'

  const l2 = isZh
    ? '请阅读用户提供的课程资料（可能是 PDF、PPT、Word 或文本文件），生成课程画像字段，严格遵守 JSON Schema。'
    : 'Read the provided course material (PDF, PPT, Word, or text) and produce a course profile strictly following the JSON Schema.'

  const l3 = isZh
    ? '规则：'
    : 'Rules:'

  const r1 = isZh
    ? '- 所有内容必须来自材料本身，不得编造。'
    : '- All content must come from the material; do not invent.'

  const r2 = isZh
    ? '- 若资料中缺少某字段，填空字符串 "" 或空数组 [].'
    : '- If a field is missing in the material, use empty string "" or empty array [].'

  const r3 = isZh
    ? '- outline 字段请给出 8-12 个要点，若不足则给出材料中能识别的主题。'
    : '- For "outline", provide 8–12 bullets; if fewer are available, list identifiable topics.'

  const r4 = isZh
    ? `- 所有输出必须使用${lang}。`
    : `- All output must be in ${lang}.`

  return [l1, l2, l3, r1, r2, r3, r4].join('\n')
}

function extractJsonPayload(response: any){
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
  throw new Error('OpenAI response missing JSON payload')
}

interface NormalizedProfile {
  courseCode: string
  sessionName: string
  subtitle: string
  description: string
  outline: string[]
}

function normalizeProfile(raw: any): NormalizedProfile {
  return {
    courseCode: ensureString(raw?.courseCode),
    sessionName: ensureString(raw?.sessionName),
    subtitle: ensureString(raw?.subtitle),
    description: ensureString(raw?.description),
    outline: normalizeOutline(raw?.outline)
  }
}

function ensureString(value: unknown): string {
  if(typeof value === 'string') return value.trim()
  if(value === null || value === undefined) return ''
  return String(value)
}

function normalizeOutline(value: unknown): string[] {
  if(Array.isArray(value)){
    return value.map((item) => ensureString(item)).filter(Boolean).slice(0, 12)
  }
  if(typeof value === 'string'){
    return value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 12)
  }
  return []
}