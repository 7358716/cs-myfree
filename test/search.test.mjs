import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSearchCache, createRateLimiter, webFetch } from '../src/web/search.js'

test('cache hit returns cached', async () => {
  const cache = createSearchCache({ ttlMs: 10000 })
  let calls = 0
  const fetchImpl = async () => { calls++; return { ok: true, status: 200, text: async () => 'hello' } }
  const r1 = await webFetch({ url: 'http://x/a', fetchImpl, cache })
  assert.equal(r1.cached, false)
  assert.equal(r1.body, 'hello')
  const r2 = await webFetch({ url: 'http://x/a', fetchImpl, cache })
  assert.equal(r2.cached, true)
  assert.equal(calls, 1)
})

test('rate limiter blocks over limit', () => {
  const lim = createRateLimiter({ perMin: 2 })
  assert.equal(lim.allow('k'), true)
  assert.equal(lim.allow('k'), true)
  assert.equal(lim.allow('k'), false)
  lim.reset('k')
  assert.equal(lim.allow('k'), true)
})

test('webFetch handles fetch error', async () => {
  const r = await webFetch({ url: 'http://x/b', fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(r.ok, false)
  assert.match(r.error, /boom/)
})

test('webFetch missing url', async () => {
  const r = await webFetch({})
  assert.equal(r.ok, false)
  assert.equal(r.error, 'missing url')
})
