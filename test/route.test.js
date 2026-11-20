import test from 'node:test'
import assert from 'node:assert/strict'

import { STATUS_ROUTE, apply } from '../index.js'

/** Minimal Cordis context + ServerResponse doubles for the route wiring. */
function installPlugin(t, config = { packageName: '@example/definitely-not-installed' }) {
  let route
  const ctx = {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') t.after(dispose)
      return dispose
    },
    get() {
      return undefined
    },
    webServer: {
      register(candidate) {
        route = candidate
        return () => {}
      },
    },
  }
  apply(ctx, config)
  assert.ok(route, 'apply registered a web route')
  return route
}

function invoke(route, request) {
  return new Promise((resolve, reject) => {
    let statusCode = 200
    const headers = {}
    let body = ''
    const response = {
      set statusCode(value) {
        statusCode = value
      },
      get statusCode() {
        return statusCode
      },
      setHeader(name, value) {
        headers[name] = value
      },
      end(chunk) {
        if (typeof chunk === 'string') body += chunk
        resolve({ statusCode, headers, body })
      },
    }
    Promise.resolve(route.handler(request, response)).catch(reject)
  })
}

test('apply registers the exact status route', (t) => {
  const route = installPlugin(t)
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, STATUS_ROUTE)
})

test('GET returns a JSON payload carrying the installation error', async (t) => {
  const route = installPlugin(t)
  const response = await invoke(route, { method: 'GET', url: STATUS_ROUTE })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
  const payload = JSON.parse(response.body)
  assert.equal(payload.schema, 1)
  assert.match(payload.error, /Could not find @example\/definitely-not-installed/)
  assert.equal(payload.updateAvailable, false)
})

test('POST is rejected with 405 and an Allow header', async (t) => {
  const route = installPlugin(t)
  const response = await invoke(route, { method: 'POST', url: STATUS_ROUTE })
  assert.equal(response.statusCode, 405)
  assert.equal(response.headers.allow, 'GET, HEAD')
})

test('an unauthenticated request is rejected before the body runs', async (t) => {
  let route
  const ctx = {
    effect(callback) {
      const dispose = callback()
      if (typeof dispose === 'function') t.after(dispose)
      return dispose
    },
    get(name) {
      if (name === 'connection') return { requestRejection: () => 401 }
      return undefined
    },
    webServer: {
      register(candidate) {
        route = candidate
        return () => {}
      },
    },
  }
  apply(ctx, { packageName: '@example/definitely-not-installed' })
  const response = await invoke(route, { method: 'GET', url: STATUS_ROUTE })
  assert.equal(response.statusCode, 401)
  assert.equal(response.body, '')
})
