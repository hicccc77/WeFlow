// Synthetic fixtures only: no WeChat database, account, or network is accessed.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const vm = require('node:vm')
const { test, after } = require('node:test')
const { transformSync } = require('esbuild')
const compiled = transformSync(fs.readFileSync(path.join(__dirname, '../electron/services/messageRetentionStore.ts'), 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'node24'
}).code
function loadStore(overrides = {}) {
  const moduleObject = { exports: {} }
  vm.runInNewContext(compiled, { module: moduleObject, exports: moduleObject.exports, require: name => overrides[name] || require(name), Buffer })
  return moduleObject.exports
}
const moduleObject = { exports: loadStore() }
const { MessageRetentionStore, retentionServerId } = moduleObject.exports
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'weflow-retention-test-'))
const stores = []; const services = []
const store = (account) => { const value = new MessageRetentionStore(root, account); stores.push(value); return value }
after(() => { for (const service of services) service.stop(); for (const s of stores) s.close(); fs.rmSync(root, { recursive: true, force: true }) })
const original = (overrides = {}) => ({ messageKey: 'synthetic', localId: 41, serverId: 0, serverIdRaw: '9223372036854775806',
  localType: 1, createTime: 1700000000, isSend: 0, senderUsername: 'synthetic-sender', senderDisplayName: '合成发送者',
  parsedContent: '合成原文：应在撤回后保留', rawContent: '合成原始内容', _db_name: 'message_0.db', _table_name: 'Msg_synthetic', ...overrides })
const recall = (tag = 'newmsgid', value = '9223372036854775806', overrides = {}) => original({ localId: 99, serverIdRaw: '9223372036854775807',
  localType: 10002, parsedContent: '合成发送者撤回了一条消息', rawContent: `<sysmsg type="revokemsg"><revokemsg><${tag}>${value}</${tag}></revokemsg></sysmsg>`, ...overrides })

test('capture, revoke, restart retains original and exact 64-bit server ID', () => {
  let db = store('account-restart')
  db.capture('chat', '合成会话', original(), 1000)
  db.capture('chat', '合成会话', recall(), 2000)
  db.close()
  db = store('account-restart')
  const { items, total } = db.list({ onlyRevoked: true })
  assert.equal(total, 1)
  assert.equal(items[0].content, original().parsedContent)
  assert.equal(items[0].rawContent, original().rawContent)
  assert.equal(items[0].serverId, '9223372036854775806')
  assert.equal(items[0].originalMissing, false)
  assert.equal(items[0].recalledAt, 2000)
})
test('duplicate polls do not overwrite original text or first recall timestamp', () => {
  const db = store('account-duplicate')
  db.captureMany('chat', '合成会话', [original()], 1000)
  db.capture('chat', '合成会话', recall(), 2000)
  db.captureMany('chat', '合成会话', Array.from({ length: 200 }, () => original({ parsedContent: '不得覆盖', rawContent: '不得覆盖' })), 3000)
  db.capture('chat', '合成会话', recall(), 4000)
  const result = db.list()
  assert.equal(result.total, 1)
  assert.equal(result.items[0].content, original().parsedContent)
  assert.equal(result.items[0].recalledAt, 2000)
})
test('same-local-ID replacement preserves the previously captured original', () => {
  const db = store('account-local')
  db.capture('chat', '会话', original(), 1000)
  db.capture('chat', '会话', recall('msgid', '0', { localId: 41, serverIdRaw: '', rawContent: '', localType: 10000 }), 2000)
  assert.equal(db.list({ onlyRevoked: true }).items[0].rawContent, original().rawContent)
})
test('uncaptured revocation is explicitly marked and not presented as recovered text', () => {
  const db = store('account-missing')
  db.capture('chat', '会话', recall(), 2000)
  db.capture('chat', '会话', recall(), 3000)
  const result = db.list({ onlyRevoked: true })
  assert.equal(result.total, 1)
  assert.equal(result.items[0].originalMissing, true)
  assert.equal(result.items[0].rawContent, '')
  assert.match(result.items[0].content, /原文未捕获/)
})
test('oldmsgid and long msgid match server strings; short msgid can identify a local row', () => {
  for (const [index, tag, value] of [[1, 'oldmsgid', '9223372036854775806'], [2, 'msgid', '9223372036854775806'], [3, 'msgid', '41']]) {
    const db = store('account-recall-variant-' + index)
    db.capture('chat', '会话', original(), 1000)
    db.capture('chat', '会话', recall(tag, value), 2000)
    assert.equal(db.list().total, 1)
    assert.equal(db.list({ onlyRevoked: true }).items[0].originalMissing, false)
  }
  assert.equal(retentionServerId(original({ serverIdRaw: undefined, serverId: Number('9223372036854775806') })), '')
  assert.equal(retentionServerId(original({ serverIdRaw: undefined, serverId: 1234 })), '1234')
})
test('accounts and conversations are isolated even when message IDs match', () => {
  const one = store('account-one'); const two = store('account-two')
  one.capture('chat-a', '甲', original())
  one.capture('chat-b', '乙', original())
  one.capture('chat-a', '甲', recall())
  assert.equal(one.list().total, 2)
  assert.equal(one.list({ onlyRevoked: true }).total, 1)
  assert.equal(two.list().total, 0)
  assert.notEqual(one.archivePath, two.archivePath)
  // Windows inherits the user's profile ACL; chmod does not expose POSIX modes.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(one.directory).mode & 0o777, 0o700)
    assert.equal(fs.statSync(one.archivePath).mode & 0o777, 0o600)
  }
})
test('media is an independent private copy that survives deletion of the source cache', async () => {
  const db = store('account-media')
  const item = db.capture('chat', '会话', original({ localType: 3 }))
  const source = path.join(root, 'synthetic-cache.png')
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex')
  fs.writeFileSync(source, bytes)
  const destination = await db.preserveMedia(item.id, source)
  assert.ok(destination.startsWith(db.directory + path.sep))
  if (process.platform !== 'win32') assert.notEqual(fs.statSync(source).ino, fs.statSync(destination).ino)
  fs.unlinkSync(source)
  assert.deepEqual(fs.readFileSync(destination), bytes)
  if (process.platform !== 'win32') assert.equal(fs.statSync(destination).mode & 0o777, 0o600)
  db.close()
  const reopened = store('account-media')
  assert.equal(reopened.list().items[0].mediaPath, destination)
  assert.equal(reopened.list().items[0].mediaState, 'saved')
})
test('an unmatched strong server ID cannot fall back to a colliding local ID in any shard', () => {
  const db = store('account-conflicting-target')
  db.capture('chat', '会话', original({ serverIdRaw: '100', _db_name: 'message_0.db' }))
  db.capture('chat', '会话', original({ serverIdRaw: '200', _db_name: 'message_1.db' }))
  db.capture('chat', '会话', recall('newmsgid', '300', { _db_name: 'message_1.db',
    rawContent: '<sysmsg type="revokemsg"><revokemsg><newmsgid>300</newmsgid><msgid>41</msgid></revokemsg></sysmsg>' }))
  const rows = db.list().items
  assert.equal(rows.length, 3)
  assert.equal(rows.find(row => row.serverId === '100').recalledAt, null)
  assert.equal(rows.find(row => row.serverId === '200').recalledAt, null)
  assert.equal(rows.find(row => row.serverId === '300').originalMissing, true)
})
test('short local msgid matching is confined to its shard and rejects ambiguity', () => {
  const db = store('account-local-scope')
  db.capture('chat', '会话', original({ serverIdRaw: '100', _db_name: 'message_0.db' }))
  db.capture('chat', '会话', original({ serverIdRaw: '200', _db_name: 'message_1.db' }))
  db.capture('chat', '会话', recall('msgid', '41', { _db_name: 'message_1.db' }))
  assert.equal(db.list().items.find(row => row.serverId === '100').recalledAt, null)
  assert.equal(db.list({ onlyRevoked: true }).items[0].serverId, '200')
  const ambiguous = store('account-local-ambiguous')
  ambiguous.capture('chat', '会话', original({ serverIdRaw: '100' }))
  ambiguous.capture('chat', '会话', original({ serverIdRaw: '200' }))
  ambiguous.capture('chat', '会话', recall('msgid', '41'))
  assert.equal(ambiguous.list({ onlyRevoked: true }).items[0].originalMissing, true)
  assert.equal(ambiguous.list().items.filter(row => row.recalledAt === null).length, 2)
})
test('different exact server IDs at the same local position remain distinct originals', () => {
  const db = store('account-server-conflict')
  const first = db.capture('chat', '会话', original({ serverIdRaw: '100', parsedContent: '第一条' }))
  const second = db.capture('chat', '会话', original({ serverIdRaw: '200', parsedContent: '第二条' }))
  assert.notEqual(first.id, second.id)
  assert.equal(db.list().total, 2)
  assert.equal(db.get(first.id).content, '第一条')
  assert.equal(db.get(second.id).content, '第二条')
})
test('ordinary text containing revocation XML cannot mark another message revoked', () => {
  const db = store('account-pasted-xml')
  db.capture('chat', '会话', original())
  db.capture('chat', '会话', recall('newmsgid', original().serverIdRaw, { localType: 1 }))
  assert.equal(db.list().total, 2)
  assert.equal(db.list({ onlyRevoked: true }).total, 0)
})
test('a later exact server ID enriches a locally captured message without replacing its original', () => {
  const db = store('account-late-server-id')
  const first = db.capture('chat', '会话', original({ serverIdRaw: '', serverId: 0 }))
  db.capture('chat', '会话', original({ parsedContent: '不得覆盖已保存原文' }))
  db.capture('chat', '会话', recall())
  const result = db.list({ onlyRevoked: true })
  assert.equal(result.total, 1)
  assert.equal(result.items[0].id, first.id)
  assert.equal(result.items[0].serverId, original().serverIdRaw)
  assert.equal(result.items[0].content, original().parsedContent)
  assert.equal(result.items[0].originalMissing, false)
})
test('native path handling accepts Windows drive paths and file URLs as well as POSIX paths', () => {
  const url = require('node:url')
  const windows = loadStore({ 'node:path': { ...path, isAbsolute: path.win32.isAbsolute },
    'node:url': { ...url, fileURLToPath: value => url.fileURLToPath(value, { windows: true }) } })
  assert.equal(windows.retentionLocalMediaPath('C:\\Users\\Synthetic\\cache\\image.png'), 'C:\\Users\\Synthetic\\cache\\image.png')
  assert.equal(windows.retentionLocalMediaPath('file:///C:/Users/Synthetic/cache/image%20one.png'), 'C:\\Users\\Synthetic\\cache\\image one.png')
  for (const source of ['C:relative.png', '..\\relative.png', 'https://example.invalid/image.png']) assert.throws(() => windows.retentionLocalMediaPath(source))
  const posix = loadStore({ 'node:path': { ...path, isAbsolute: path.posix.isAbsolute },
    'node:url': { ...url, fileURLToPath: value => url.fileURLToPath(value, { windows: false }) } })
  assert.equal(posix.retentionLocalMediaPath('/tmp/image.png'), '/tmp/image.png')
  assert.equal(posix.retentionLocalMediaPath('file:///tmp/image%20one.png'), '/tmp/image one.png')
  assert.throws(() => posix.retentionLocalMediaPath('../relative.png'))
})
test('closing an archive during media copying does not publish or retain a temporary file', async () => {
  let entered; let release
  const copying = new Promise(resolve => { entered = resolve })
  const resume = new Promise(resolve => { release = resolve })
  const Store = loadStore({ 'node:fs': { ...fs, promises: { ...fs.promises, copyFile: async (...args) => {
    entered(); await resume; return fs.promises.copyFile(...args)
  } } } }).MessageRetentionStore
  const db = new Store(root, 'account-close-copy'); stores.push(db)
  const item = db.capture('chat', '会话', original({ localType: 3 }))
  const source = path.join(root, 'close-copy.png'); fs.writeFileSync(source, Buffer.from('89504e470d0a1a0a', 'hex'))
  const pending = db.preserveMedia(item.id, source)
  await copying; db.close(); release()
  assert.equal(await pending, undefined)
  assert.deepEqual(fs.readdirSync(path.join(db.directory, 'media')), [])
})
test('a close racing the final rename removes only its unpublished media copy', async () => {
  let db
  const Store = loadStore({ 'node:fs': { ...fs, promises: { ...fs.promises, rename: async (...args) => {
    await fs.promises.rename(...args); db.close()
  } } } }).MessageRetentionStore
  db = new Store(root, 'account-close-rename'); stores.push(db)
  const item = db.capture('chat', '会话', original({ localType: 3 }))
  const source = path.join(root, 'close-rename.png'); fs.writeFileSync(source, Buffer.from('89504e470d0a1a0a', 'hex'))
  assert.equal(await db.preserveMedia(item.id, source), undefined)
  assert.deepEqual(fs.readdirSync(path.join(db.directory, 'media')), [])
  assert.ok(fs.existsSync(source))
})
test('media growth during copying cannot bypass the size limit or publish a partial archive', async () => {
  const Store = loadStore({ 'node:fs': { ...fs, promises: { ...fs.promises, copyFile: async (source, destination) => {
    await fs.promises.copyFile(source, destination); await fs.promises.truncate(destination, 64 * 1024 * 1024 + 1)
  } } } }).MessageRetentionStore
  const db = new Store(root, 'account-growing-media'); stores.push(db)
  const item = db.capture('chat', '会话', original({ localType: 3 }))
  const source = path.join(root, 'growing.png'); fs.writeFileSync(source, Buffer.from('89504e470d0a1a0a', 'hex'))
  await assert.rejects(db.preserveMedia(item.id, source), /64MB/)
  assert.deepEqual(fs.readdirSync(path.join(db.directory, 'media')), [])
  assert.equal(db.get(item.id).mediaPath, undefined)
})

function makeService(chat = {}, options = {}) {
  const moduleObject = { exports: {} }
  let clock = 2000000000000
  const timers = new Set()
  class FakeDate extends Date { static now() { return clock } }
  const config = { messageRetentionEnabled: true, myAccountId: 'synthetic-account', dbPath: '/synthetic', ...options.config }
  const dependencies = {
    electron: { app: { getPath: () => path.join(root, 'service-fixture-' + stores.length + '-' + Math.random()) } },
    './config': { ConfigService: class {
      get(key) { return config[key] } set(key, value) { config[key] = value }
      getAccountDir(_path, account) { return '/synthetic/' + account }
    } },
    './chatService': { chatService: chat },
    './imageDecryptService': { imageDecryptService: options.imageDecrypt || { decryptImage: async () => ({ success: false }) } },
    './messageRetentionStore': moduleObjectStore()
  }
  // Keep each fake app's data directory stable throughout that instance.
  const directory = dependencies.electron.app.getPath()
  dependencies.electron.app.getPath = () => directory
  const source = transformSync(fs.readFileSync(path.join(__dirname, '../electron/services/messageRetentionService.ts'), 'utf8'), {
    loader: 'ts', format: 'cjs', target: 'node24'
  }).code
  vm.runInNewContext(source, { module: moduleObject, exports: moduleObject.exports, Buffer, console, Date: FakeDate,
    require: name => dependencies[name] || require(name),
    setTimeout: (callback, delay) => {
      const timer = { callback, at: clock + delay, unref() {} }
      if (delay === 5) queueMicrotask(callback); else timers.add(timer)
      return timer
    }, clearTimeout: timer => timers.delete(timer)
  })
  services.push(moduleObject.exports.messageRetentionService)
  return { service: moduleObject.exports.messageRetentionService, config, directory, timers, setClock: value => { clock = value }, clock: () => clock }
}
function moduleObjectStore() { return moduleObject.exports }

test('continuous database events retain the earliest scan deadline', () => {
  const fixture = makeService()
  const { service, timers } = fixture
  let scans = 0
  service.scan = async () => { scans++ }
  service.start()
  const initial = [...timers][0]; timers.delete(initial); initial.callback()
  const begin = fixture.clock()
  service.schedule(1500)
  service.handleDbMonitorChange('message_change', '{}')
  for (const offset of [50, 100, 149]) {
    fixture.setClock(begin + offset)
    service.handleDbMonitorChange('message_change', '{}')
    assert.equal(timers.size, 1)
    assert.equal([...timers][0].at, begin + 150)
  }
  fixture.setClock(begin + 150)
  const due = [...timers][0]; timers.delete(due); due.callback()
  assert.equal(scans, 2)
  service.stop()
})
test('failed conversation reads rotate out and do not starve later conversations', async () => {
  const attempts = []
  const sessions = Array.from({ length: 16 }, (_, index) => ({ username: 'chat-' + index, lastTimestamp: 1, lastMsgType: 1, summary: '' }))
  const fixture = makeService({
    getSessions: async () => ({ success: true, sessions }),
    getLatestMessages: async id => {
      attempts.push(id)
      return Number(id.split('-')[1]) < 8 ? { success: false, error: 'synthetic unavailable' }
        : { success: true, messages: [original()] }
    }
  })
  const { service } = fixture
  service.start()
  await service.scan()
  fixture.setClock(fixture.clock() + 1500)
  await service.scan()
  assert.ok(attempts.includes('chat-15'))
  assert.equal(service.status().totalMessages, 8)
  service.stop()
})
test('capture is opt-in and malformed non-boolean settings fail closed', () => {
  for (const enabled of [false, 'false', 'true', 1, null]) {
    const { service, directory, timers } = makeService({}, { config: { messageRetentionEnabled: enabled } })
    service.start()
    assert.equal(service.status().enabled, false)
    assert.equal(timers.size, 0)
    assert.equal(fs.existsSync(path.join(directory, 'Retention')), false)
    service.stop()
  }
})
test('an account switch discards an in-flight query from the previous account', async () => {
  let started; let finish
  const waiting = new Promise(resolve => { started = resolve })
  const { service, config } = makeService({
    getSessions: async () => ({ success: true, sessions: [{ username: 'chat', lastTimestamp: 1, lastMsgType: 1, summary: '' }] }),
    getLatestMessages: () => { started(); return new Promise(resolve => { finish = resolve }) }
  })
  service.start(); const scan = service.scan(); await waiting
  config.myAccountId = 'second-synthetic-account'; service.handleConfigChanged('myAccountId')
  finish({ success: true, messages: [original()] }); await scan
  assert.equal(service.status().totalMessages, 0)
  assert.equal(service.list().total, 0)
  service.stop()
})
