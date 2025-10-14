# ClassGuru Mainline 插件系统文档

## 目录

- [概述](#概述)
- [插件架构](#插件架构)
- [插件注册机制](#插件注册机制)
- [通用类型定义](#通用类型定义)
- [配置管理](#配置管理)
- [插件列表](#插件列表)
  - [认证插件](#认证插件)
  - [数据代理插件](#数据代理插件)
  - [讲座数据插件](#讲座数据插件)
  - [课程资料分析插件](#课程资料分析插件)
  - [音频转录插件](#音频转录插件)
  - [阶段总结插件](#阶段总结插件)
  - [对话交互插件](#对话交互插件)
  - [课程总结插件](#课程总结插件)
- [错误处理](#错误处理)
- [OpenAI 集成](#openai-集成)
- [开发指南](#开发指南)

---

## 概述

ClassGuru Mainline 插件系统是一个模块化、可扩展的架构，用于处理前端发送的各种业务请求。每个插件负责特定的业务逻辑，通过统一的注册机制和标准化的接口实现松耦合设计。

### 核心特性

- **模块化设计**：每个插件独立实现特定功能，易于维护和扩展
- **统一接口**：所有插件遵循相同的 `PluginHandler` 类型定义
- **集中配置**：通过 `config.json` 统一管理所有配置，避免硬编码
- **类型安全**：使用 TypeScript 严格类型检查
- **错误处理**：统一的错误处理机制和响应格式
- **并发控制**：每个插件可配置独立的并发限制

---

## 插件架构

### 架构图

```
┌─────────────────────────────────────────────────────────────┐
│                      Frontend Request                        │
│                    (PluginEnvelope)                          │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    Auth Gateway                              │
│              (HMAC Signature Verification)                   │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                  Mainline Orchestrator                       │
│              (Route to Plugin Registry)                      │
└──────────────────────────┬──────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   Plugin Registry                            │
│            Map<pluginName, PluginHandler>                    │
└──────────────────────────┬──────────────────────────────────┘
                           │
        ┌──────────────────┼──────────────────┐
        │                  │                  │
        ▼                  ▼                  ▼
┌──────────────┐  ┌──────────────┐  ┌──────────────┐
│Auth Plugins  │  │Data Plugins  │  │AI Plugins    │
├──────────────┤  ├──────────────┤  ├──────────────┤
│- auth        │  │- data.proxy  │  │- material    │
│  _password   │  │- lecture.*   │  │  .analyze    │
│- auth        │  │              │  │- audio       │
│  _register   │  │              │  │  .transcribe │
│              │  │              │  │- audio       │
│              │  │              │  │  .stage-     │
│              │  │              │  │  summary     │
│              │  │              │  │- audio       │
│              │  │              │  │  .dialogue   │
│              │  │              │  │- audio       │
│              │  │              │  │  .summary    │
└──────────────┘  └──────────────┘  └──────────────┘
        │                  │                  │
        └──────────────────┼──────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────┐
│             External Services / Data Storage                 │
│  - Auth Service (8785)                                       │
│  - Data Service (8788) [with HMAC signing]                  │
│  - OpenAI API                                                │
└─────────────────────────────────────────────────────────────┘
```

### 请求流程

1. **前端请求** → 发送 `PluginEnvelope` (包含 `pluginName` 和 `intent`)
2. **Auth Gateway** → HMAC 签名验证
3. **Orchestrator** → 从 Registry 获取对应的 `PluginHandler`
4. **插件执行** → 处理业务逻辑
5. **响应返回** → 返回统一的 `PluginResponse` 格式

---

## 插件注册机制

### registry.ts

```typescript
import type { PluginContext, PluginResponse } from '../types/index.js'

export type PluginHandler = (payload: PluginContext) => Promise<PluginResponse>

const registry = new Map<string, PluginHandler>()

export function registerPlugin(name: string, handler: PluginHandler) {
  registry.set(name, handler)
}

export function getPlugin(name: string): PluginHandler | undefined {
  return registry.get(name)
}
```

### 注册插件

每个插件文件通过调用 `registerPlugin()` 注册自己：

```typescript
import { registerPlugin } from './registry.js'
import type { PluginContext, PluginResponse } from '../types/index.js'

registerPlugin('my.plugin', async (ctx: PluginContext): Promise<PluginResponse> => {
  // 插件逻辑
  return {
    status_code: 200,
    message: 'success',
    data: { result: 'ok' }
  }
})
```

### index.ts - 自动加载

`plugins/index.ts` 负责导入所有插件文件，触发注册：

```typescript
import './auth-service.plugin.js'
import './data-proxy.plugin.js'
import './lecture-data.plugin.js'
import './course-material.plugin.js'
import './lecture-transcribe.plugin.js'
import './stage-summary.plugin.js'
import './conversation-dialogue.plugin.js'
import './course-summary.plugin.js'
```

---

## 通用类型定义

所有插件使用 `src/types/index.ts` 中定义的标准类型：

### PluginContext

插件接收的上下文参数：

```typescript
export interface PluginContext {
  intent: {
    operation: string
    inputs?: Record<string, unknown>
  }
  envelope: PluginEnvelope  // 原始请求信封
  headers: Record<string, string>
  userId?: string           // 从 x-user-id 提取
  requestId?: string        // 从 x-request-id 提取
}
```

### PluginResponse

插件返回的响应格式：

```typescript
export interface PluginResponse {
  status_code: number       // HTTP 状态码 (200, 400, 500, etc.)
  message: string           // 响应消息
  data?: unknown            // 业务数据 (可选)
  partial?: boolean         // 是否为部分响应 (可选)
}
```

### PluginEnvelope

前端发送的请求信封：

```typescript
export interface PluginEnvelope {
  pluginName: string        // 插件名称 (如 'audio.transcribe')
  intent: {
    operation: string       // 操作类型 (如 'transcribe')
    inputs?: Record<string, unknown>  // 输入参数
  }
}
```

---

## 配置管理

所有插件通过 `getConfig()` 访问统一配置，配置文件位于项目根目录的 `config.json`。

### 配置结构

```json
{
  "services": {
    "authService": {
      "url": "http://localhost:8785"
    },
    "mainline": {
      "port": 8787,
      "concurrency": {
        "global": 1024,
        "plugins": {
          "default": 64,
          "audio.transcribe": 16,
          "audio.stage-summary": 32,
          "material.analyze": 8
        }
      }
    },
    "dataService": {
      "url": "http://localhost:8788"
    }
  },
  "openai": {
    "apiKey": "sk-xxx",
    "baseURL": "https://api.openai.com/v1",
    "models": {
      "transcribe": "gpt-4o-mini-transcribe",
      "material": "gpt-4o-mini",
      "stageSummary": "gpt-4o-mini",
      "dialogue": "gpt-4o-mini",
      "courseSummary": "gpt-4o-mini"
    },
    "limits": {
      "maxAudioBytes": 26214400,
      "maxFileBytes": 10485760,
      "maxFileIds": 5,
      "minSummaryLength": 200
    }
  }
}
```

### 在插件中使用配置

```typescript
import { getConfig } from '../config.js'

const config = getConfig()

// 访问 OpenAI 配置
const apiKey = config.openai.apiKey
const model = config.openai.models.transcribe
const maxBytes = config.openai.limits.maxAudioBytes

// 访问服务 URL
const authUrl = config.authService.url
const dataUrl = config.dataService.url
```

---

## 插件列表

### 认证插件

#### 1. auth_password - 用户登录

**插件名称**: `auth_password`  
**文件**: `auth-service.plugin.ts`  
**功能**: 用户密码登录

**请求格式**:
```json
{
  "pluginName": "auth_password",
  "intent": {
    "operation": "login",
    "inputs": {
      "username": "user@example.com",
      "password": "password123"
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "accessToken": "eyJhbGc...",
    "refreshToken": "eyJhbGc...",
    "userId": "123",
    "username": "user@example.com"
  }
}
```

**依赖服务**: Auth Service (http://localhost:8785)

---

#### 2. auth_register - 用户注册

**插件名称**: `auth_register`  
**文件**: `auth-service.plugin.ts`  
**功能**: 新用户注册

**请求格式**:
```json
{
  "pluginName": "auth_register",
  "intent": {
    "operation": "register",
    "inputs": {
      "username": "newuser@example.com",
      "password": "securepass123"
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "userId": "124",
    "username": "newuser@example.com"
  }
}
```

---

### 数据代理插件

#### 3. data.proxy - 通用数据代理

**插件名称**: `data.proxy`  
**文件**: `data-proxy.plugin.ts`  
**功能**: 通过单一插件代理多种数据操作，使用 Zod schema 验证

**支持的操作**:
- `getLecture` - 获取讲座详情
- `createLecture` - 创建讲座
- `updateLecture` - 更新讲座
- `deleteLecture` - 删除讲座
- `listLectures` - 列出讲座
- `appendTranscription` - 添加转录
- `appendSummary` - 添加总结
- `upsertReport` - 更新报告
- `getPostClassBackground` - 获取课后背景
- `getStageSummariesText` - 获取阶段总结文本

**请求格式** (以 createLecture 为例):
```json
{
  "pluginName": "data.proxy",
  "intent": {
    "operation": "createLecture",
    "inputs": {
      "courseCode": "CS101",
      "sessionName": "Introduction to Programming",
      "language": "zh-CN",
      "status": 1
    }
  }
}
```

**依赖服务**: Data Service (http://localhost:8788) [需要 HMAC 签名]

---

### 讲座数据插件

#### 4-11. lecture.* - 讲座 CRUD 操作

**插件名称**: `lecture.list`, `lecture.get`, `lecture.create`, `lecture.update`, `lecture.delete`, `lecture.transcription.append`, `lecture.summary.append`, `lecture.report.upsert`  
**文件**: `lecture-data.plugin.ts`  
**功能**: 讲座数据的增删改查及关联数据管理

**验证**: 使用 AJV 验证 JSON Schema (`lecture.intent.schema.json`)

**请求格式** (以 lecture.create 为例):
```json
{
  "pluginName": "lecture.create",
  "intent": {
    "operation": "create",
    "inputs": {
      "courseCode": "MATH201",
      "sessionName": "Linear Algebra",
      "language": "en",
      "status": 1
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "lecture_id": "lec_789",
    "courseCode": "MATH201",
    "sessionName": "Linear Algebra",
    "created_at": "2025-10-13T10:00:00Z"
  }
}
```

**依赖服务**: Data Service (http://localhost:8788) [需要 HMAC 签名]

---

### 课程资料分析插件

#### 12. material.analyze - 课程资料智能分析

**插件名称**: `material.analyze`  
**文件**: `course-material.plugin.ts`  
**功能**: 使用 AI 分析上传的课程资料 (PDF/PPT/Word/TXT/Markdown)，生成课程画像

**支持格式**: `.pdf`, `.ppt`, `.pptx`, `.doc`, `.docx`, `.txt`, `.md`, `.markdown`  
**文件大小限制**: 10MB (可通过 `config.openai.limits.maxFileBytes` 配置)

**请求格式**:
```json
{
  "pluginName": "material.analyze",
  "intent": {
    "operation": "analyze",
    "inputs": {
      "file": {
        "name": "lecture1.pdf",
        "mime_type": "application/pdf",
        "data": "base64_encoded_file_content",
        "size": 1048576
      }
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "courseCode": "CS101",
    "sessionName": "Introduction to Algorithms",
    "subtitle": "Lecture 3 (26 & 29 Aug 2025)",
    "description": "本次课程介绍算法分析的基本概念，包括时间复杂度和空间复杂度...",
    "outline": [
      "算法复杂度分析",
      "大O表示法",
      "常见排序算法",
      "递归与分治",
      "动态规划基础"
    ],
    "fileID": "file-abc123xyz"
  }
}
```

**OpenAI API 调用**:
- **模型**: `config.openai.models.material` (默认: `gpt-4o-mini`)
- **功能**: `client.files.create()` + `client.responses.create()`
- **输出格式**: JSON Schema (`CourseProfile`)

**错误处理**:
- `400 Bad Request`: 文件格式不支持 / 文件过大 / Base64 解码失败
- `500 Internal Server Error`: OpenAI API 调用失败

---

### 音频转录插件

#### 13. audio.transcribe - 音频转文字

**插件名称**: `audio.transcribe`  
**文件**: `lecture-transcribe.plugin.ts`  
**功能**: 使用 Whisper API 将音频转录为文本

**支持格式**: `.mp3`, `.mp4`, `.mpeg`, `.mpga`, `.m4a`, `.wav`, `.webm`  
**文件大小限制**: 25MB (可通过 `config.openai.limits.maxAudioBytes` 配置)

**请求格式**:
```json
{
  "pluginName": "audio.transcribe",
  "intent": {
    "operation": "transcribe",
    "inputs": {
      "file": {
        "name": "lecture_recording.mp3",
        "mime_type": "audio/mpeg",
        "data": "base64_encoded_audio_data",
        "size": 5242880
      },
      "keywords": ["机器学习", "深度学习", "神经网络"],
      "language": "zh"
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "text": "大家好，今天我们讲解机器学习的基本概念。首先是监督学习..."
  }
}
```

**OpenAI API 调用**:
- **模型**: `config.openai.models.transcribe` (默认: `gpt-4o-mini-transcribe`)
- **功能**: `client.audio.transcriptions.create()`
- **Prompt**: 可选，提供关键词列表以提高识别准确度

**日志记录**:
```
[lecture-transcribe] request received { requestId, userId, fileName, mimeType, size, keywords, language }
[lecture-transcribe] transcription succeeded { requestId, userId, bytes, textLength }
[lecture-transcribe] transcription failed { error, stack }
```

---

### 阶段总结插件

#### 14. audio.stage-summary - 阶段性总结生成

**插件名称**: `audio.stage-summary`  
**文件**: `stage-summary.plugin.ts`  
**功能**: 根据当前和历史转录文本生成阶段性总结

**请求格式**:
```json
{
  "pluginName": "audio.stage-summary",
  "intent": {
    "operation": "stage",
    "inputs": {
      "previous2": "上上个阶段的转录文本...",
      "previous": "上个阶段的转录文本...",
      "current": "当前阶段的转录文本 (至少20字)...",
      "language": "zh-CN",
      "keywords": ["深度学习", "卷积神经网络"]
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "summary": "本阶段讲解了卷积神经网络的基本结构和工作原理",
    "highlights": [
      "卷积层的作用是特征提取",
      "池化层降低计算复杂度",
      "全连接层进行分类决策",
      "激活函数引入非线性"
    ],
    "knowledge_keywords": [
      "卷积层",
      "池化层",
      "激活函数",
      "特征图",
      "感受野"
    ]
  }
}
```

**OpenAI API 调用**:
- **模型**: `config.openai.models.stageSummary` (默认: `gpt-4o-mini`)
- **输出格式**: JSON Schema (`StageTranscriptionSummary`)
- **Prompt 构建**: 综合当前、上一个、上上个阶段内容，保持连贯性

---

### 对话交互插件

#### 15. audio.dialogue - 课程问答对话

**插件名称**: `audio.dialogue`  
**文件**: `conversation-dialogue.plugin.ts`  
**功能**: 基于课程阶段总结的智能问答系统，支持多轮对话

**特性**:
- **新对话**: 需要提供 `summaries`，自动创建 `conversation_id`
- **继续对话**: 使用已有 `conversation_id`，可选补充新的 `summaries`
- **会话管理**: 使用 OpenAI Conversations API 管理对话历史

**请求格式** (新对话):
```json
{
  "pluginName": "audio.dialogue",
  "intent": {
    "operation": "chat",
    "inputs": {
      "language": "zh-CN",
      "summaries": "【阶段1】介绍了深度学习基本概念...\n【阶段2】讲解了卷积神经网络...",
      "question": "什么是卷积层的作用？"
    }
  }
}
```

**请求格式** (继续对话):
```json
{
  "pluginName": "audio.dialogue",
  "intent": {
    "operation": "chat",
    "inputs": {
      "language": "zh-CN",
      "conversation_id": "conv_abc123",
      "question": "那池化层呢？"
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "answer": "卷积层的主要作用是进行特征提取。通过滑动卷积核在输入图像上进行卷积运算，可以检测图像中的局部特征...",
    "conversation_id": "conv_abc123",
    "turn": 1,
    "created_at": "2025-10-13T10:30:00Z"
  }
}
```

**OpenAI API 调用**:
- **模型**: `config.openai.models.dialogue` (默认: `gpt-4o-mini`)
- **API**: `client.responses.create()` with `conversation` parameter
- **管理**: 自动创建/获取/更新 conversation metadata (language, turn)

**会话生命周期**:
1. **创建**: `POST /v1/conversations` → 返回 `conversation_id`
2. **查询**: `GET /v1/conversations/{id}` → 获取 metadata
3. **更新**: `POST /v1/conversations/{id}` → 更新 metadata (turn++)
4. **删除**: `DELETE /v1/conversations/{id}` (错误时自动清理)

---

### 课程总结插件

#### 16. audio.summary - 完整课程总结报告

**插件名称**: `audio.summary`  
**文件**: `course-summary.plugin.ts`  
**功能**: 生成结构化的课程总结报告，整合阶段总结、对话记录和课程资料

**支持两种模式**:

**模式 1: 直接传入数据**
```json
{
  "pluginName": "audio.summary",
  "intent": {
    "operation": "summarize",
    "inputs": {
      "language": "zh-CN",
      "stage_summaries": "【阶段1】...\n【阶段2】...",
      "conversation_text": "Q: 什么是...\nA: ...",
      "file_ids": ["file-abc123", "file-def456"]
    }
  }
}
```

**模式 2: 通过 lectureId 自动获取**
```json
{
  "pluginName": "audio.summary",
  "intent": {
    "operation": "summarize",
    "inputs": {
      "lectureId": "lec_789"
    }
  }
}
```

**响应示例**:
```json
{
  "status_code": 200,
  "message": "ok",
  "data": {
    "sections": [
      {
        "title": "深度学习基础",
        "summary": "本部分介绍了深度学习的核心概念和理论基础",
        "items": [
          {
            "heading": "神经网络结构",
            "summary": "详细讲解了神经网络的层次结构",
            "details": [
              {
                "point": "输入层",
                "explanation": "接收原始数据的第一层",
                "example": "图像识别中接收像素矩阵"
              },
              {
                "point": "隐藏层",
                "explanation": "进行特征提取和转换",
                "example": "卷积层、池化层等"
              }
            ]
          }
        ]
      }
    ],
    "next_actions": [
      "复习卷积神经网络的数学原理",
      "完成课后练习题",
      "阅读推荐论文：LeNet-5"
    ]
  }
}
```

**OpenAI API 调用**:
- **模型**: `config.openai.models.courseSummary` (默认: `gpt-4o-mini`)
- **输出格式**: JSON Schema (`CourseSummaryReport`)
- **多模态输入**: 文本 + 文件 (通过 `file_ids`)

**自动保存**: 当使用 `lectureId` 模式时，生成的总结会自动保存到 Data Service (`seq_no = 1`)

**验证规则**:
- `stage_summaries` 最小长度: `config.openai.limits.minSummaryLength` (默认 200 字符)
- `file_ids` 最大数量: `config.openai.limits.maxFileIds` (默认 5 个)

---

## 错误处理

### 统一错误响应格式

所有插件使用相同的错误响应格式：

```typescript
{
  status_code: number,  // 400, 401, 403, 404, 500, etc.
  message: string,      // 错误描述
  data: {}              // 空对象或错误详情
}
```

### ValidationError 类

```typescript
// src/errors/validation.error.ts
export class ValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationError'
  }
}
```

**使用场景**:
- 输入参数验证失败
- 必填字段缺失
- 文件格式/大小不符合要求
- OpenAI API Key 未配置

### 错误处理模式

```typescript
try {
  // 参数验证
  ensureUser(userId)
  const parsed = schema.safeParse(inputs)
  if (!parsed.success) {
    return { status_code: 400, message: formatZodError(parsed.error), data: {} }
  }

  // 业务逻辑
  const result = await someOperation()
  return { status_code: 200, message: 'ok', data: result }

} catch (error) {
  // ValidationError → 400
  if (error instanceof ValidationError) {
    return { status_code: 400, message: error.message, data: {} }
  }
  
  // 其他错误 → 500
  return {
    status_code: 500,
    message: 'internal error',
    data: { error: error instanceof Error ? error.message : String(error) }
  }
}
```

### 常见错误码

| 状态码 | 含义 | 典型场景 |
|--------|------|----------|
| 200 | 成功 | 正常返回数据 |
| 400 | 客户端错误 | 参数验证失败、文件格式错误 |
| 401 | 未授权 | JWT token 无效 |
| 403 | 禁止访问 | 权限不足 |
| 404 | 资源不存在 | 讲座/对话 ID 不存在 |
| 500 | 服务器错误 | OpenAI API 调用失败、数据库错误 |

---

## OpenAI 集成

### 配置管理

所有 OpenAI 相关配置集中在 `config.json`:

```json
{
  "openai": {
    "apiKey": "sk-xxx",
    "baseURL": "https://api.openai.com/v1",
    "models": {
      "transcribe": "gpt-4o-mini-transcribe",
      "material": "gpt-4o-mini",
      "stageSummary": "gpt-4o-mini",
      "dialogue": "gpt-4o-mini",
      "courseSummary": "gpt-4o-mini"
    },
    "limits": {
      "maxAudioBytes": 26214400,    // 25MB
      "maxFileBytes": 10485760,     // 10MB
      "maxFileIds": 5,
      "minSummaryLength": 200
    }
  }
}
```

### 客户端初始化

```typescript
import { getConfig } from '../config.js'
import OpenAI from 'openai'

function createOpenAIClient(): OpenAI {
  const config = getConfig()
  if (!config.openai.apiKey) {
    throw new ValidationError('OPENAI_API_KEY is not configured')
  }
  return new OpenAI({
    apiKey: config.openai.apiKey,
    baseURL: config.openai.baseURL
  })
}
```

### API 使用示例

#### 1. 文件上传 (course-material.plugin.ts)

```typescript
import { toFile } from 'openai/uploads'

const file = await toFile(buffer, filename, { type: mimeType })
const uploaded = await client.files.create({
  file,
  purpose: 'assistants'
})
const fileId = uploaded.id
```

#### 2. 音频转录 (lecture-transcribe.plugin.ts)

```typescript
const file = await toFile(buffer, filename, { type: mimeType })
const response = await client.audio.transcriptions.create({
  file,
  model: config.openai.models.transcribe,
  prompt: buildPrompt(keywords),
  language: language
})
const text = response.text
```

#### 3. 结构化输出 (stage-summary.plugin.ts)

```typescript
const response: any = await client.responses.create({
  model: config.openai.models.stageSummary,
  input: [
    { role: 'user', content: [{ type: 'input_text', text: prompt }] }
  ],
  text: { format: OUTPUT_FORMAT },  // JSON Schema
  store: false
})
const parsed = response.output_parsed
```

#### 4. 会话管理 (conversation-dialogue.plugin.ts)

```typescript
// 开始新对话
const response = await client.responses.create({
  model: config.openai.models.dialogue,
  conversation: conversationId,
  input: [
    { role: 'system', content: [...] },
    { role: 'user', content: [...] }
  ]
})

// 继续对话
const response = await client.responses.create({
  model: config.openai.models.dialogue,
  conversation: conversationId,
  input: [
    { role: 'user', content: [{ type: 'input_text', text: question }] }
  ]
})
```

#### 5. 多模态输入 (course-summary.plugin.ts)

```typescript
const userContent: any[] = [
  { type: 'input_text', text: instruction }
]

// 附加文件
for (const fileId of file_ids) {
  userContent.push({ type: 'input_file', file_id: fileId })
}

const response = await client.responses.create({
  model: config.openai.models.courseSummary,
  input: [
    { role: 'system', content: [...] },
    { role: 'developer', content: [...] },
    { role: 'user', content: userContent }
  ],
  text: { format: OUTPUT_SCHEMA },
  store: false
})
```

### JSON Schema 输出格式

插件使用 `strict: true` 的 JSON Schema 确保输出结构严格一致：

```typescript
const OUTPUT_FORMAT = {
  type: 'json_schema',
  name: 'StageTranscriptionSummary',
  description: '阶段性转录总结输出格式',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string' },
      highlights: { type: 'array', items: { type: 'string' } },
      knowledge_keywords: { type: 'array', items: { type: 'string' } }
    },
    required: ['summary', 'highlights', 'knowledge_keywords']
  }
} as const
```

---

## 开发指南

### 创建新插件的步骤

#### 1. 创建插件文件

在 `src/plugins/` 目录下创建 `my-feature.plugin.ts`：

```typescript
import { registerPlugin } from './registry.js'
import { ValidationError } from '../errors/validation.error.js'
import { SC } from '../constants/status-codes.js'
import { getConfig } from '../config.js'
import type { PluginContext, PluginResponse } from '../types/index.js'
import { z } from 'zod'

// 定义输入 schema
const inputSchema = z.object({
  param1: z.string().min(1, 'param1 is required'),
  param2: z.number().positive().optional()
})

// 注册插件
registerPlugin('my.feature', async ({ intent, userId, requestId }: PluginContext): Promise<PluginResponse> => {
  try {
    // 1. 验证用户
    if (!userId) {
      throw new ValidationError('missing user id')
    }

    // 2. 验证操作
    if (intent?.operation !== 'myOperation') {
      return { status_code: 400, message: 'unsupported operation', data: {} }
    }

    // 3. 验证输入
    const parsed = inputSchema.safeParse(intent.inputs ?? {})
    if (!parsed.success) {
      const message = parsed.error.issues
        .map(issue => issue.message)
        .join('; ')
      return { status_code: 400, message, data: {} }
    }

    // 4. 获取配置
    const config = getConfig()

    // 5. 业务逻辑
    const result = await doSomething(parsed.data, config)

    // 6. 返回成功响应
    return {
      status_code: 200,
      message: 'ok',
      data: result
    }

  } catch (error) {
    // 错误处理
    if (error instanceof ValidationError) {
      return { status_code: 400, message: error.message, data: {} }
    }
    return {
      status_code: 500,
      message: 'my feature failed',
      data: { error: error instanceof Error ? error.message : String(error) }
    }
  }
})

async function doSomething(inputs: z.infer<typeof inputSchema>, config: any) {
  // 实现业务逻辑
  return { result: 'success' }
}
```

#### 2. 在 index.ts 中导入

编辑 `src/plugins/index.ts`，添加：

```typescript
import './my-feature.plugin.js'
```

#### 3. 配置并发限制

在 `config.json` 中添加插件并发配置：

```json
{
  "services": {
    "mainline": {
      "concurrency": {
        "plugins": {
          "my.feature": 32
        }
      }
    }
  }
}
```

#### 4. 添加类型定义 (如需要)

如果插件需要特殊类型，在 `src/types/index.ts` 中添加。

#### 5. 编译和测试

```bash
pnpm build
pnpm start
```

### 最佳实践

1. **使用 Zod 进行输入验证**
   - 提供清晰的错误消息
   - 确保类型安全

2. **统一错误处理**
   - 使用 `ValidationError` 处理 400 错误
   - 捕获所有异常，返回 500 错误

3. **从配置读取所有环境相关参数**
   - 避免 `process.env`
   - 便于测试和部署

4. **添加详细日志**
   - 请求开始、成功、失败都要记录
   - 包含 `requestId` 和 `userId` 以便追踪

5. **类型安全**
   - 使用 TypeScript 严格模式
   - 导入并使用 `PluginContext` 和 `PluginResponse`

6. **异步操作**
   - 所有插件必须是 `async` 函数
   - 使用 `await` 处理 Promise

7. **资源清理**
   - 文件操作后清理临时资源
   - 对话失败时删除已创建的 conversation

### 调试技巧

1. **查看请求日志**
   ```
   [plugin-name] request received { requestId, userId, ... }
   ```

2. **启用详细日志**
   在 `config.json` 中设置：
   ```json
   { "logging": { "level": "debug" } }
   ```

3. **测试单个插件**
   使用 curl 或 Postman 直接调用 orchestrator：
   ```bash
   curl -X POST http://localhost:8787/internal/orchestrate \
     -H "Content-Type: application/json" \
     -H "x-user-id: test-user" \
     -H "x-request-id: test-req" \
     -H "x-signature: ..." \
     -d '{
       "pluginName": "my.feature",
       "intent": {
         "operation": "myOperation",
         "inputs": { "param1": "value1" }
       }
     }'
   ```

4. **检查插件注册**
   在 `orchestrator.service.ts` 中添加日志查看已注册插件：
   ```typescript
   console.log('Registered plugins:', Array.from(registry.keys()))
   ```

---

## 插件依赖关系

```
┌─────────────────────────────────────────────────────────────┐
│                     External Dependencies                    │
├─────────────────────────────────────────────────────────────┤
│  OpenAI API                                                  │
│    ├── course-material.plugin.ts (File Analysis)            │
│    ├── lecture-transcribe.plugin.ts (Whisper)               │
│    ├── stage-summary.plugin.ts (Structured Output)          │
│    ├── conversation-dialogue.plugin.ts (Chat)               │
│    └── course-summary.plugin.ts (Complex Analysis)          │
│                                                              │
│  Data Service (http://localhost:8788)                       │
│    ├── data-proxy.plugin.ts (Generic CRUD)                  │
│    ├── lecture-data.plugin.ts (Lecture CRUD)                │
│    └── course-summary.plugin.ts (Auto-save report)          │
│                                                              │
│  Auth Service (http://localhost:8785)                       │
│    ├── auth-service.plugin.ts (Login/Register)              │
│    └── [No direct plugin calls to Auth Service]             │
└─────────────────────────────────────────────────────────────┘
```

---

## 性能优化

### 并发控制

每个插件都有独立的并发限制配置 (`config.json`):

```json
{
  "concurrency": {
    "global": 1024,
    "plugins": {
      "default": 64,
      "audio.transcribe": 16,      // 转录较慢，限制较低
      "material.analyze": 8,        // 文件分析耗时，限制更低
      "lecture.list": 128,          // 查询操作快，限制较高
      "audio.stage-summary": 32
    }
  }
}
```

### 缓存策略

- **Idempotency**: Orchestrator 层面实现幂等性 (60s TTL)
- **OpenAI File IDs**: 课程资料上传后返回 `fileID`，可复用

### 日志级别

生产环境建议使用 `info` 级别，开发环境使用 `debug`。

---

## 安全性

### HMAC 签名验证

所有请求经过 Auth Gateway 的 HMAC 签名验证后才会到达插件。

### Data Service 调用

插件调用 Data Service 时自动添加 HMAC 签名：

```typescript
// data-service.client.ts
const timestamp = Date.now().toString()
const hmacPayload = `${ctx.userId}:${timestamp}`
const signature = createHmac('sha256', config.dataService.hmacSecret)
  .update(hmacPayload)
  .digest('hex')

headers['x-user-id'] = ctx.userId
headers['x-timestamp'] = timestamp
headers['x-signature'] = signature
```

### OpenAI API Key

- 存储在 `config.json` 或环境变量 `OPENAI_API_KEY`
- **不要**硬编码在代码中
- **不要**记录到日志

---

## 故障排查

### 常见问题

#### 1. 插件未找到

**错误**: `Plugin 'xxx' not found`

**原因**:
- 插件文件未在 `index.ts` 中导入
- `registerPlugin()` 拼写错误

**解决**:
```typescript
// src/plugins/index.ts
import './my-new-plugin.js'
```

---

#### 2. OpenAI API Key 未配置

**错误**: `OPENAI_API_KEY is not configured`

**解决**:
```json
// config.json
{
  "openai": {
    "apiKey": "sk-your-actual-key-here"
  }
}
```

或设置环境变量:
```bash
export OPENAI_API_KEY="sk-your-actual-key-here"
```

---

#### 3. 文件过大

**错误**: `file too large (max 10 MB)`

**原因**: 文件超过配置的限制

**解决**:
1. 调整 `config.json`:
   ```json
   {
     "openai": {
       "limits": {
         "maxFileBytes": 20971520  // 20MB
       }
     }
   }
   ```
2. 或建议用户压缩文件

---

#### 4. Data Service 连接失败

**错误**: `failed to call data-service: ECONNREFUSED`

**原因**: Data Service 未启动或 URL 配置错误

**解决**:
1. 启动 Data Service: `npm start` (在 `data-service` 目录)
2. 检查配置:
   ```json
   {
     "services": {
       "dataService": {
         "url": "http://localhost:8788"
       }
     }
   }
   ```

---

#### 5. HMAC 签名验证失败

**错误**: `signature verification failed`

**原因**:
- 时间戳超出窗口 (默认 300 秒)
- HMAC secret 不一致

**解决**:
1. 确保所有服务使用相同的 `security.hmac.secret`
2. 同步服务器时间 (使用 NTP)

---

## 总结

ClassGuru Mainline 插件系统提供了一个灵活、可扩展的架构来处理各种业务需求。通过统一的接口、集中的配置管理和严格的类型检查，确保了代码的可维护性和可靠性。

### 关键设计原则

1. **模块化**: 每个插件独立实现，互不干扰
2. **标准化**: 统一的类型定义和错误处理
3. **配置化**: 所有环境相关参数集中管理
4. **类型安全**: TypeScript + Zod + AJV 多层验证
5. **可观测性**: 详细的日志记录和请求追踪

### 扩展性

系统设计支持轻松添加新插件：
1. 创建新的 `.plugin.ts` 文件
2. 实现 `PluginHandler` 接口
3. 在 `index.ts` 中导入
4. 更新 `config.json` 并发配置
5. 编译部署

---

**相关文档**:
- [Mainline 服务总体文档](../../README.md)
- [Config.json 配置说明](../../../config.json)
- [类型定义](../types/index.ts)
- [Data Service Client](../services/data-service.client.ts)
