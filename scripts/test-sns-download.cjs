// Portable synthetic fixtures only: no account, real CDN, private files, or network.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { EventEmitter } = require('node:events')
const { PassThrough } = require('node:stream')
const zlib = require('node:zlib')
const { test } = require('node:test')
const { transformSync } = require('esbuild')

const compiled = transformSync(fs.readFileSync(path.join(__dirname, '../electron/services/snsService.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node24'
}).code
const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(200)])
const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)])
const fixtureUrl = name => `https://media.example.invalid/${name}`

function runtime(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-sns-download-test-'))
  const state = { response: {}, timeline: [], requestCount: 0, destroyedRequests: 0, idleTimeoutMs: null }
  const cleanup = new Set()
  const https = {
    request(_options, callback) {
      state.requestCount++
      const plan = state.response
      const request = new EventEmitter()
      let timeout; let interval; let response; let closed = false
      const stop = () => { clearTimeout(timeout); clearInterval(interval); cleanup.delete(stop) }
      cleanup.add(stop)
      request.destroy = () => {
        if (!closed) { closed = true; state.destroyedRequests++ }
        stop(); response?.destroy()
      }
      request.setTimeout = milliseconds => { state.idleTimeoutMs = milliseconds }
      request.end = () => {
        timeout = setTimeout(() => {
          response = new PassThrough()
          response.statusCode = plan.status || 200
          response.headers = plan.headers || {}
          response.on('close', stop)
          callback(response)
          if (response.destroyed) return
          if (plan.trickle) interval = setInterval(() => response.write(Buffer.from('x')), 5)
          else response.end(plan.body || Buffer.alloc(0))
        }, 0)
      }
      return request
    }
  }
  class Config {
    get(name) { return name === 'cachePath' ? root : undefined }
    getCacheBasePath() { return root }
  }
  const dependencies = {
    https,
    electron: { app: { getPath: () => root } },
    './config': { ConfigService: Config },
    './contactCacheService': { ContactCacheService: { getInstance: () => ({ get: () => undefined }) } },
    './wcdbService': { wcdbService: { getSnsTimeline: async () => ({ success: true, timeline: state.timeline }) } },
    './wasmService': { WasmService: { getInstance: () => ({ getKeystream: async (_key, length) => Buffer.alloc(length) }) } },
    './isaac64': { Isaac64: class { generateKeystreamBE(length) { return Buffer.alloc(length) } } },
    './export/utils/markdown': {}
  }
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : require(name),
    Buffer, URL, setTimeout, clearTimeout, console })
  const { snsService, fetchSnsMediaBounded } = module.exports
  snsService.getContactCacheScope = () => ''
  t.after(() => { for (const stop of cleanup) stop(); fs.rmSync(root, { recursive: true, force: true }) })
  return { state, snsService, fetchSnsMediaBounded }
}

test('limits decompressed bytes even when Content-Length is small', async t => {
  const { state, fetchSnsMediaBounded } = runtime(t)
  const compressed = zlib.gzipSync(Buffer.alloc(5000))
  state.response = { headers: { 'content-encoding': 'gzip', 'content-length': String(compressed.length) }, body: compressed }
  await assert.rejects(fetchSnsMediaBounded(fixtureUrl('compressed'), { maxBytes: 100, timeoutMs: 1000 }), /SNS_MEDIA_TOO_LARGE/)
  assert.equal(state.destroyedRequests, 1)
})

test('limits video bytes without trusting a missing Content-Length', async t => {
  const { state, snsService } = runtime(t)
  state.response = { body: Buffer.alloc(1000) }
  const result = await snsService.downloadImage(fixtureUrl('large.mp4'), undefined, { maxBytes: 100, timeoutMs: 1000 })
  assert.equal(result.success, false)
  assert.match(result.error, /SNS_MEDIA_TOO_LARGE/)
})

test('absolute timeout closes a response that keeps trickling bytes', async t => {
  const { state, fetchSnsMediaBounded } = runtime(t)
  state.response = { trickle: true }
  await assert.rejects(fetchSnsMediaBounded(fixtureUrl('trickle'), { maxBytes: 10000, timeoutMs: 40 }), /SNS_MEDIA_TIMEOUT/)
  assert.equal(state.destroyedRequests, 1)
})

test('invalid video does not become a successful cache entry', async t => {
  const { state, snsService } = runtime(t)
  state.response = { body: Buffer.from('synthetic invalid video') }
  const url = fixtureUrl('invalid.mp4')
  const result = await snsService.downloadImage(url)
  assert.equal(result.success, false)
  assert.match(result.error, /SNS_MEDIA_INVALID_VIDEO/)
  assert.equal(fs.existsSync(snsService.getCacheFilePath(url)), false)
})

test('the cache cannot bypass an explicit size limit', async t => {
  const { state, snsService } = runtime(t)
  const url = fixtureUrl('cached.png')
  fs.writeFileSync(snsService.getCacheFilePath(url), Buffer.alloc(1000))
  const result = await snsService.downloadImage(url, undefined, { maxBytes: 100 })
  assert.equal(result.success, false)
  assert.match(result.error, /SNS_MEDIA_TOO_LARGE/)
  assert.equal(state.requestCount, 0)
})

test('corrupt cached video is replaced only after format validation', async t => {
  const { state, snsService } = runtime(t)
  const url = fixtureUrl('retry.mp4')
  fs.writeFileSync(snsService.getCacheFilePath(url), Buffer.from('invalid'))
  state.response = { body: mp4 }
  const result = await snsService.downloadImage(url)
  assert.equal(result.success, true)
  assert.equal(result.contentType, 'video/mp4')
  assert.deepEqual(fs.readFileSync(result.cachePath), mp4)
})

test('rejects redirects without requesting their destination', async t => {
  const { state, fetchSnsMediaBounded } = runtime(t)
  state.response = { status: 302, headers: { location: 'https://127.0.0.1/private' } }
  await assert.rejects(fetchSnsMediaBounded(fixtureUrl('redirect')), /HTTP 302/)
  assert.equal(state.requestCount, 1)
})

test('a valid image is atomically cached with private POSIX permissions', async t => {
  const { state, snsService } = runtime(t)
  state.response = { body: png }
  const result = await snsService.downloadImage(fixtureUrl('normal.png'))
  assert.equal(result.success, true)
  assert.equal(result.contentType, 'image/png')
  assert.deepEqual(fs.readFileSync(result.cachePath), png)
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.cachePath).mode & 0o777, 0o600)
  assert.equal(fs.readdirSync(path.dirname(result.cachePath)).some(name => name.endsWith('.tmp')), false)
})

test('explicit thumbnail kind overrides a video hostname', async t => {
  const { state, snsService } = runtime(t)
  state.response = { body: png }
  const result = await snsService.downloadImage('https://video.example.invalid/thumbnail', undefined, { kind: 'image' })
  assert.equal(result.success, true)
  assert.equal(result.contentType, 'image/png')
  assert.ok(result.cachePath.endsWith('.jpg'))
})

function videoPost(tag) {
  return { id: 'synthetic-video', username: 'synthetic-user', nickname: 'Synthetic', type: 1,
    media: [{ url: fixtureUrl('opaque'), thumb: fixtureUrl('thumbnail'), key: '0' }], comments: [], likes: [],
    rawXml: `<TimelineObject><ContentObject><${tag}>15</${tag}><mediaList><media><type>6</type><enc key="1234567890"/></media></mediaList></ContentObject></TimelineObject>` }
}

test('XML content type repairs a fallback video type and exact nonzero key', async t => {
  const { state, snsService } = runtime(t)
  for (const tag of ['type', 'contentStyle']) {
    state.timeline = [videoPost(tag)]
    const result = await snsService.getTimeline()
    assert.equal(result.timeline[0].type, 15)
    assert.equal(result.timeline[0].media[0].key, '1234567890')
  }
})

test('nested media types or video hostnames do not redefine an image post', async t => {
  const { state, snsService } = runtime(t)
  state.timeline = [{ ...videoPost('type'), media: [{ url: 'https://video.example.invalid/thumbnail', thumb: '', key: '234' }],
    rawXml: '<ContentObject><type>1</type><mediaList><media><type>15</type><enc key="1234567890"/></media></mediaList></ContentObject>' }]
  const result = await snsService.getTimeline()
  assert.equal(result.timeline[0].type, 1)
  assert.equal(result.timeline[0].media[0].key, '234')
})

test('automatic image detection also reads the complete cached thumbnail', async t => {
  const { state, snsService } = runtime(t)
  const url = 'https://video.example.invalid/automatic-thumbnail'
  state.response = { body: png }
  const first = await snsService.downloadImage(url)
  const second = await snsService.downloadImage(url)
  assert.equal(first.success, true)
  assert.equal(second.success, true)
  assert.equal(second.contentType, 'image/png')
  assert.deepEqual(second.data, png)
  assert.equal(state.requestCount, 1)
})

test('explicit video kind continues to reject image data', async t => {
  const { state, snsService } = runtime(t)
  state.response = { body: png }
  const result = await snsService.downloadImage(fixtureUrl('forced.mp4'), undefined, { kind: 'video' })
  assert.equal(result.success, false)
  assert.match(result.error, /SNS_MEDIA_INVALID_VIDEO/)
})


test('default callers retain their size policy and original idle timeout', async t => {
  const { state, snsService } = runtime(t)
  state.response = { headers: { 'content-length': String(256 * 1024 * 1024) }, body: png }
  const result = await snsService.downloadImage(fixtureUrl('default-policy.png'))
  assert.equal(result.success, true, 'the optional retention ceiling must not reject an existing caller')
  assert.equal(state.idleTimeoutMs, 15000)
})

test('retention opts into a hard ceiling before reading a large declared response', async t => {
  const { state, snsService } = runtime(t)
  state.response = { headers: { 'content-length': String(256 * 1024 * 1024) }, body: png }
  const result = await snsService.downloadImage(fixtureUrl('retention-policy.png'), undefined, { maxBytes: 128 * 1024 * 1024, timeoutMs: 30000 })
  assert.equal(result.success, false)
  assert.match(result.error, /SNS_MEDIA_TOO_LARGE/)
})
