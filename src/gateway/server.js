/**
 * cs-myfree — 本地 OpenAI 兼容网关（零依赖，仅用 node:http）
 *
 * 设计依据：v3 §10。支持四套方言：
 *  · `POST /v1/chat/completions`  OpenAI
 *  · `POST /v1/messages`          **Anthropic 原生**（不是硬转）
 *  · `POST /v1beta/models/*`      Gemini
 *  · `GET  /v1/models`            模型清单
 *  · `GET  /health`               健康检查（LAN 门不豁免）
 *
 * 安全（v3 §10 + ourfree 实测）：
 *  · 默认只绑回环；拒绝通配地址
 *  · 本地门与 LAN 门**两把不同 key**
 *  · LAN 中继**每请求都鉴权**
 *  · `x-csmyfree-relay-hop` 头防自环
 *
 * @module cs-myfree/gateway/server
 */

import { createServer } from 'node:http'
import { createAuthorizer, validateListenHost, generateKey } from './auth.js'
import { toOpenAi, toAnthropic, toGemini, toOpenAiResponse, toAnthropicResponse, fromAnthropic, fromGemini } from './formats.js'

export const DEFAULT_PORT = 8326
export const MAX_BODY_BYTES = 8 * 1024 * 1024   // 实测宿主是 8MB，不是 1MB

/**
 * 创建网关服务（不自动 listen，便于测试）。
 * @param {object} o
 * @param {(req:object)=>AsyncIterable} o.complete  真正的模型调用（由上层注入）
 * @param {string} o.localKey
 * @param {string} o.lanKey
 * @param {Function} o.logger
 */
export function createGateway(o = {}) {
  const {
    complete,
    localKey = generateKey('csmf-local'),
    lanKey = null,
    logger = () => {},
    maxBodyBytes = MAX_BODY_BYTES,
  } = o

  if (typeof complete !== 'function') throw new TypeError('createGateway 需要 complete 函数')
  const authz = createAuthorizer({ localKey, lanKey })

  const server = createServer(async (req, res) => {
    const t0 = Date.now()
    try {
      // 防自环：LAN 中继带了该头就不再往外转
      if (req.headers['x-csmyfree-relay-hop']) {
        return send(res, 508, { error: { message: 'relay loop detected' } })
      }

      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname

      // LAN 门：来源不是回环 ⇒ 必须用 lanKey
      const remote = req.socket.remoteAddress ?? ''
      const isLoopback = /^(127\.|::1$|::ffff:127\.)/.test(remote)
      if (!isLoopback) {
        const a = authz.checkLan(req.headers)
        if (!a.ok) return send(res, 401, { error: { message: `unauthorized (${a.reason})` } })
      }

      if (req.method === 'GET' && path === '/health') {
        return send(res, 200, { ok: true, at: Date.now() })
      }
      if (req.method === 'GET' && path === '/v1/models') {
        return send(res, 200, { object: 'list', data: [{ id: 'cs-myfree', object: 'model', owned_by: 'cs-myfree' }] })
      }

      if (req.method !== 'POST') return send(res, 405, { error: { message: 'method not allowed' } })

      const raw = await readBody(req, maxBodyBytes)
      let body
      try { body = JSON.parse(raw) } catch { return send(res, 400, { error: { message: 'invalid json' } }) }

      // ── OpenAI ──
      if (path === '/v1/chat/completions') {
        const messages = toOpenAi(body.messages ?? [], { system: body.system })
        const chunks = []
        let reasoning = ''
        for await (const c of complete({ model: body.model, messages, signal: null })) {
          if (c.type === 'text-delta') chunks.push(c.text)
          if (c.type === 'reasoning-delta') reasoning += c.text
        }
        return send(res, 200, toOpenAiResponse({ model: body.model, text: chunks.join(''), reasoning }))
      }

      // ── Anthropic 原生 ──
      if (path === '/v1/messages') {
        const anth = toAnthropic(body.messages ?? [], { system: body.system, maxTokens: body.max_tokens, temperature: body.temperature })
        const chunks = []
        for await (const c of complete({ model: body.model, messages: toOpenAi(anth.messages), signal: null })) {
          if (c.type === 'text-delta') chunks.push(c.text)
        }
        return send(res, 200, toAnthropicResponse({ model: body.model, text: chunks.join('') }))
      }

      // ── Gemini ──
      const gm = /^\/v1beta\/models\/([^:]+):generateContent$/.exec(path)
      if (gm) {
        const g = toGemini(body.contents ? geminiContentsToInternal(body.contents) : [], { system: body.systemInstruction?.parts?.[0]?.text })
        const chunks = []
        for await (const c of complete({ model: gm[1], messages: g, signal: null })) {
          if (c.type === 'text-delta') chunks.push(c.text)
        }
        return send(res, 200, {
          candidates: [{ content: { parts: [{ text: chunks.join('') }], role: 'model' }, finishReason: 'STOP' }],
        })
      }

      return send(res, 404, { error: { message: `no route ${path}` } })
    } catch (err) {
      logger('gateway-error', err)
      return send(res, 500, { error: { message: String(err?.message ?? err).slice(0, 300) } })
    } finally {
      logger('gateway-req', { path: req.url, ms: Date.now() - t0 })
    }
  })

  return {
    server,
    localKey,
    lanKey,
    /** 启动（拒绝通配地址） */
    listen({ host = '127.0.0.1', port = DEFAULT_PORT } = {}) {
      const v = validateListenHost(host)
      if (!v.ok) return Promise.reject(new Error(v.reason))
      return new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(port, host, () => resolve({ host, port: server.address().port }))
      })
    },
    close() {
      return new Promise((resolve) => server.close(resolve))
    },
  }
}

function geminiContentsToInternal(contents = []) {
  return contents.map((c) => ({
    role: c.role === 'model' ? 'assistant' : 'user',
    content: (c.parts ?? []).map((p) => {
      if (p.text) return { type: 'text', text: p.text }
      if (p.inline_data) return { type: 'image', mime: p.inline_data.mime_type, data: p.inline_data.data }
      return null
    }).filter(Boolean),
  }))
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (c) => {
      size += c.length
      if (size > limit) { reject(new Error(`body too large (>${limit})`)); req.destroy(); return }
      parts.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}
