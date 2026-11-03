// All data and files are synthetic. No WeChat account or network is accessed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { test, after } = require('node:test')
const { transformSync } = require('esbuild')
function load(filename, dependencies = {}, globals = {}) {
  const compiled = transformSync(fs.readFileSync(path.join(__dirname, '../electron/services', filename), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node24' }).code
  const module = { exports: {} }
  vm.runInNewContext(compiled, { module, exports: module.exports, require: name => dependencies[name] || require(name),
    Buffer, URL, console, ...globals })
  return module.exports
}
const storeModule = load('snsRetentionStore.ts')
const { SnsRetentionStore, SNS_RETENTION_MAX_BYTES } = storeModule
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-sns-retention-test-'))
const stores = []; const services = []
after(() => { for (const service of services) service.stop(); for (const store of stores) store.close(); fs.rmSync(root, { recursive: true, force: true }) })
function store(identity) { const value = new SnsRetentionStore(root, identity); stores.push(value); return value }
const post = (overrides = {}) => ({ id: '9223372036854775806', username: 'synthetic-friend', nickname: '合成昵称', createTime: 1700000000,
  contentDesc: '合成朋友圈原文', media: [], likes: ['合成点赞'], comments: [{ id: '18446744073709551614', nickname: '合成评论者', content: '合成评论', refCommentId: '' }], ...overrides })
const imagePost = (overrides = {}) => post({ media: [{ url: 'https://mmsns.qpic.cn/synthetic/0?token=old', thumb: 'https://mmsns.qpic.cn/synthetic/150', key: '18446744073709551614' }], ...overrides })
const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')

test('blank or vanished source posts never delete the archived original or its snapshots', () => {
  let db = store('disappeared')
  db.capturePosts([post()], 1000)
  db.capturePosts([post()], 1100)
  assert.equal(db.stats().totalSnapshots, 1)
  db.capturePosts([post({ contentDesc: '', likes: [], comments: [], createTime: 0 })], 2000)
  db.capturePosts([])
  db.close(); db = store('disappeared')
  const item = db.list().items[0]
  assert.equal(item.contentDesc, '合成朋友圈原文')
  assert.equal(item.likes[0], '合成点赞')
  assert.equal(item.comments[0].content, '合成评论')
  assert.equal(item.createTime, 1700000000)
  assert.equal(item.snapshotCount, 2)
  assert.equal(item.capturedAt, 1000)
})
test('64-bit post and comment IDs remain strings and accounts are isolated', () => {
  const one = store('account-a'); const two = store('account-b')
  one.capturePosts([post(), post({ id: '9223372036854775807' })])
  assert.equal(one.list().total, 2)
  assert.equal(one.list().items.find(item => item.id === '9223372036854775806').comments[0].id, '18446744073709551614')
  assert.equal(two.list().total, 0)
  one.capturePosts([post({ id: Number('9223372036854775806') })])
  assert.equal(one.list().total, 2, 'rounded numeric IDs must not invent an archive identity')
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(one.directory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(one.archivePath).mode & 0o777, 0o600)
  }
})
test('media copies survive source-cache deletion and restarting the archive', async () => {
  let db = store('media-copy'); db.capturePosts([imagePost()])
  const job = db.nextMedia(); assert.equal(job.key, '18446744073709551614')
  const source = path.join(root, 'synthetic-cache.png'); fs.writeFileSync(source, png)
  await db.saveMedia(job.id, { path: source }, 'original')
  const saved = db.list().items[0].media[0]
  assert.ok(saved.localPath.startsWith(db.directory + path.sep))
  if (process.platform !== 'win32') assert.notEqual(fs.statSync(source).ino, fs.statSync(saved.localPath).ino)
  fs.unlinkSync(source)
  db.close(); db = store('media-copy')
  assert.deepEqual(fs.readFileSync(db.list().items[0].media[0].localPath), png)
  if (process.platform !== 'win32') assert.equal(fs.statSync(saved.localPath).mode & 0o777, 0o600)
})
test('failed media backs off and new URL tokens retry without downgrading a saved original', async () => {
  const db = store('retry'); const now = Date.now()
  db.capturePosts([imagePost()]); const job = db.nextMedia(now)
  db.deferMedia(job.id, 'synthetic unavailable', false, now)
  assert.equal(db.nextMedia(now + 299999), null)
  assert.equal(db.nextMedia(now + 300001).id, job.id)
  db.capturePosts([imagePost({ media: [{ ...imagePost().media[0], url: 'https://mmsns.qpic.cn/synthetic/0?token=new' }] })])
  const refreshed = db.nextMedia(now); assert.equal(refreshed.id, job.id); assert.equal(refreshed.attempts, 0)
  await db.saveMedia(job.id, { data: png }, 'original')
  const originalPath = db.list().items[0].media[0].localPath
  db.capturePosts([imagePost({ media: [{ ...imagePost().media[0], url: 'https://mmsns.qpic.cn/synthetic/0?token=newer' }] })])
  await db.saveMedia(job.id, { data: png }, 'thumbnail')
  assert.equal(db.nextMedia(now + 999999), null)
  assert.equal(db.list().items[0].media[0].quality, 'original')
  assert.equal(db.list().items[0].media[0].localPath, originalPath)
})
test('thumbnail fallback is explicit and preserved when an original upgrade succeeds', async () => {
  const db = store('thumbnail'); db.capturePosts([imagePost()]); const job = db.nextMedia()
  db.deferMedia(job.id, 'original missing')
  await db.saveMedia(job.id, { data: png }, 'thumbnail')
  let media = db.list().items[0].media[0]
  assert.equal(media.quality, 'thumbnail'); assert.equal(db.stats().failedMedia, 1)
  assert.equal(db.stats().savedMedia, 0, 'a thumbnail is not counted as a saved original')
  const thumb = media.localPath
  await db.saveMedia(job.id, { data: png }, 'original')
  media = db.list().items[0].media[0]
  assert.equal(media.quality, 'original'); assert.equal(media.thumbnailPath, thumb)
  assert.equal(db.stats().savedMedia, 1); assert.equal(db.stats().failedMedia, 0)
  assert.ok(fs.existsSync(thumb)); assert.notEqual(media.localPath, thumb)
})
test('two workers claim different newest media and reject invalid or oversized content', async () => {
  const db = store('claims')
  db.capturePosts([imagePost(), imagePost({ id: 'newer', createTime: 1700000001 })])
  const first = db.nextMedia(); const second = db.nextMedia()
  assert.equal(first.postId, 'newer'); assert.notEqual(first.id, second.id); assert.equal(db.nextMedia(), null)
  await assert.rejects(db.saveMedia(first.id, { data: Buffer.from('<svg>not raster</svg>') }, 'original'), /格式/)
  const large = path.join(root, 'oversized-sparse.png'); fs.writeFileSync(large, png); fs.truncateSync(large, SNS_RETENTION_MAX_BYTES + 1)
  await assert.rejects(db.saveMedia(first.id, { path: large }, 'original'), /128MiB/)
  fs.unlinkSync(large)
})
test('visible older posts outrank background media without resetting failed-item backoff', () => {
  const db = store('visible-priority'); const now = Date.now()
  db.capturePosts([imagePost({ id: 'older', createTime: 1000 }), imagePost({ id: 'newer', createTime: 2000 })])
  db.prioritizePostIds(['older'], now)
  const selected = db.nextMedia(now)
  assert.equal(selected.postId, 'older')
  db.deferMedia(selected.id, 'synthetic failure', false, now)
  db.prioritizePostIds(['older'], now + 1000)
  const background = db.nextMedia(now + 1000)
  assert.equal(background.postId, 'newer')
  assert.equal(db.nextMedia(now + 2000), null)
  assert.equal(db.nextMedia(now + 300001).postId, 'newer', 'expired page priority does not permanently starve newer background work')
})
test('existing archives migrate the priority column without losing posts or pending media', () => {
  let db = store('priority-migration'); db.capturePosts([imagePost()]); const file = db.archivePath; db.close()
  const { DatabaseSync } = require('node:sqlite')
  const old = new DatabaseSync(file); old.exec('ALTER TABLE media DROP COLUMN priorityUntil'); old.close()
  db = store('priority-migration')
  assert.equal(db.stats().totalPosts, 1); assert.equal(db.stats().pendingMedia, 1)
  db.prioritizePostIds([imagePost().id]); assert.equal(db.nextMedia().postId, imagePost().id)
})

function makeService(sns = {}) {
  const fixture = fs.mkdtempSync(path.join(root, 'service-'))
  const configuration = { snsRetentionEnabled: true, myAccountId: 'synthetic', dbPath: path.join(fixture, 'database'), cachePath: path.join(fixture, 'cache') }
  const api = { getTimeline: async () => ({ success: true, timeline: [] }), downloadImage: async () => ({ success: false }), ...sns }
  const module = load('snsRetentionService.ts', {
    electron: { app: { getPath: name => name === 'documents' ? path.join(fixture, 'documents') : fixture } },
    './config': { ConfigService: class { get(key) { return configuration[key] } set(key, value) { configuration[key] = value } getAccountDir(_path, account) { return path.join(fixture, 'database', account) } } },
    './snsService': { snsService: api }, './snsRetentionStore': storeModule
  }, { setTimeout: () => ({ unref() {} }), clearTimeout() {} })
  services.push(module.snsRetentionService)
  return { ...module, configuration, fixture }
}
test('source validation blocks SSRF destinations, credentials, and escaping cache symlinks', async () => {
  const { isTrustedSnsMediaUrl, trustedSnsLocalPath, fixture } = makeService()
  for (const url of ['https://mmsns.qpic.cn/a', 'https://shzjwxsns.video.qq.com/a', 'https://wxapp.tc.qq.com/a', 'https://vweixinthumb.tc.qq.com/a']) assert.equal(isTrustedSnsMediaUrl(url), true)
  for (const url of ['http://mmsns.qpic.cn/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://user:pass@mmsns.qpic.cn/a', 'https://mmsns.qpic.cn:444/a', 'https://qpic.cn.evil.test/a', 'https://c6.y.qq.com/a', 'file:///etc/passwd']) assert.equal(isTrustedSnsMediaUrl(url), false)
  const cache = path.join(fixture, 'cache'); fs.mkdirSync(cache)
  const local = path.join(cache, 'allowed.png'); fs.writeFileSync(local, png)
  const outside = path.join(fixture, 'outside.png'); fs.writeFileSync(outside, png)
  const outsideDir = path.join(fixture, 'outside'); fs.mkdirSync(outsideDir)
  fs.writeFileSync(path.join(outsideDir, 'secret.png'), png)
  const symlink = path.join(cache, 'escape'); fs.symlinkSync(outsideDir, symlink, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(await trustedSnsLocalPath(local, [cache]), fs.realpathSync(local))
  assert.equal(await trustedSnsLocalPath(require('node:url').pathToFileURL(local).href, [cache]), fs.realpathSync(local))
  assert.equal(await trustedSnsLocalPath(path.join(symlink, 'secret.png'), [cache]), null)
  assert.equal(await trustedSnsLocalPath(outside, [cache]), null)
})
test('paced baseline retains all local pages without waiting for media or purging vanished posts', async () => {
  let timeline = Array.from({ length: 205 }, (_, index) => post({ id: String(1000 + index), createTime: 1700001000 - index }))
  const { snsRetentionService: service } = makeService({ getTimeline: async (limit, offset) => ({ success: true, timeline: timeline.slice(offset, offset + limit) }) })
  service.start(); await service.runScan(); await service.runScan(); await service.runScan()
  assert.equal(service.status().totalPosts, 205); assert.equal(service.status().baselineComplete, true)
  timeline = []
  await service.scanNow()
  assert.equal(service.status().totalPosts, 205)
  service.stop()
})
test('archive write failures never throw into the ordinary timeline UI', () => {
  const { snsRetentionService: service } = makeService()
  assert.doesNotThrow(() => service.captureVisible([post({ rawXml: 1n })]))
  assert.match(service.status().error, /留存写入失败/)
  service.stop()
})
test('an account switch during a timeline query cannot archive the old account into the new one', async () => {
  let finish
  const { snsRetentionService: service, configuration } = makeService({ getTimeline: () => new Promise(resolve => { finish = resolve }) })
  service.start(); const running = service.runScan()
  configuration.myAccountId = 'second-account'; service.handleConfigChanged('myAccountId')
  finish({ success: true, timeline: [post()] }); await running
  assert.equal(service.status().totalPosts, 0)
  service.stop()
})
test('running means an active scan and returns to idle so manual scan stays available', async () => {
  let finish
  let defer = true
  const { snsRetentionService: service } = makeService({ getTimeline: () => defer
    ? new Promise(resolve => { finish = resolve }) : Promise.resolve({ success: true, timeline: [] }) })
  service.start(); assert.equal(service.status().running, false)
  const operation = service.runScan(); assert.equal(service.status().running, true)
  defer = false; finish({ success: true, timeline: [] }); await operation
  assert.equal(service.status().running, false)
  assert.equal(service.status().enabled, true)
  await service.scanNow(); assert.equal(service.status().running, false)
  service.stop()
})
test('SNS events and periodic sweeps discover older rows without resetting in-progress pagination', async () => {
  let timeline = [post()]
  const { snsRetentionService: service } = makeService({ getTimeline: async (limit, offset) => ({ success: true, timeline: timeline.slice(offset, offset + limit) }) })
  service.start(); await service.runScan(); assert.equal(service.status().baselineComplete, true)
  timeline = Array.from({ length: 205 }, (_, index) => post({ id: String(3000 + index), createTime: 1700001000 - index }))
  service.handleDbMonitorChange('sns_change', '{}')
  assert.equal(service.status().baselineOffset, 0)
  await service.runScan(); assert.equal(service.status().baselineOffset, 90)
  service.handleDbMonitorChange('sns_change', '{}')
  assert.equal(service.status().baselineOffset, 90)
  await service.runScan(); await service.runScan()
  assert.equal(service.status().baselineComplete, true)
  timeline.push(post({ id: 'newly-cached-old-post', createTime: 1000 }))
  service.lastFullScan = Date.now() - 31 * 60_000
  await service.runScan(); assert.equal(service.status().baselineComplete, false)
  await service.runScan(); await service.runScan()
  assert.ok(service.list({ query: '合成朋友圈原文', limit: 100 }).total >= 207)
  assert.equal(service.store.list({ username: 'synthetic-friend', limit: 100, offset: 200 }).items.some(item => item.id === 'newly-cached-old-post'), true)
  service.stop()
})


test('image media on video-named CDNs keeps its image kind', async () => {
  const db = store('image-kind')
  db.capturePosts([imagePost({ type: 1, media: [{ url: 'https://synthetic.video.qq.com/thumbnail', thumb: '' }] })])
  const job = db.nextMedia()
  assert.equal(job.kind, 'image')
  await db.saveMedia(job.id, { data: png }, 'original')
  assert.equal(db.stats().savedMedia, 1)
})

test('HEIC and BMP output accepted by the downloader is also retainable', async () => {
  const db = store('image-formats')
  db.capturePosts([imagePost({ id: 'synthetic-heic' }), imagePost({ id: 'synthetic-bmp' })])
  const samples = [Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(12)]), Buffer.from('424d00000000', 'hex')]
  for (const bytes of samples) await db.saveMedia(db.nextMedia().id, { data: bytes }, 'original')
  assert.equal(db.stats().savedMedia, 2)
})

test('retention is inert when disabled', async () => {
  let reads = 0; let downloads = 0
  const { snsRetentionService: service, configuration } = makeService({
    getTimeline: async () => { reads++; return { success: true, timeline: [imagePost()] } },
    downloadImage: async () => { downloads++; return { success: false } }
  })
  configuration.snsRetentionEnabled = false
  service.start(); service.captureVisible([imagePost()]); await service.scanNow()
  assert.equal(reads, 0); assert.equal(downloads, 0)
  assert.equal(service.status().totalPosts, 0)
})
