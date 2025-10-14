import { registerPlugin } from './registry.js'
import { request } from 'undici'
import { ValidationError } from '../errors/validation.error.js'
import { SC } from '../constants/status-codes.js'
import { getConfig } from '../config.js'
import type { PluginContext, PluginResponse } from '../types/index.js'

const JSON_HEADERS = { 'content-type': 'application/json' }

interface Credentials { username: string; password: string }

registerPlugin('auth_password', createAuthHandler('/auth/login', 'auth failed'))
registerPlugin('auth_register', createAuthHandler('/auth/register', 'register failed'))

function createAuthHandler(path: string, failureMessage: string){
  return async ({ intent }: PluginContext): Promise<PluginResponse> => {
    try {
      const credentials = ensureCredentials(intent?.inputs)
      const response = await requestJson(path, credentials)
      return { status_code: SC.OK, message: 'ok', data: response }
    } catch (error) {
      if(error instanceof ValidationError){
        return { status_code: SC.BAD_REQUEST, message: error.message, data: {} }
      }
      const message = error instanceof Error ? error.message : String(error)
      return { status_code: SC.INTERNAL, message: `${failureMessage}: ${message}`, data: {} }
    }
  }
}

function ensureCredentials(inputs: any): Credentials {
  const username = typeof inputs?.username === 'string' ? inputs.username.trim() : ''
  const password = typeof inputs?.password === 'string' ? inputs.password : ''
  if(!username || !password){
    throw new ValidationError('missing credentials')
  }
  return { username, password }
}

async function requestJson(path: string, body: Credentials){
  const config = getConfig()
  const url = new URL(path, config.authService.url)
  let response
  try {
    response = await request(url, {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify(body)
    })
  } catch (error) {
    throw new Error('auth service unreachable')
  }
  const text = await response.body.text()
  if(response.statusCode >= 400){
    throw new Error(text || `HTTP ${response.statusCode}`)
  }
  return text ? JSON.parse(text) : {}
}
