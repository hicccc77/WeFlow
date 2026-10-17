// Exercise the real store at its incremental-refresh and pagination seams.
// All messages are synthetic; no Electron runtime or personal data is used.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const compiled = esbuild.buildSync({
  entryPoints: [path.join(root, 'src/stores/chatStore.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent'
}).outputFiles[0].text
const box = { module: { exports: {} }, require, process, console }
box.exports = box.module.exports
vm.runInNewContext(compiled, box)
const store = box.module.exports.useChatStore

const message = (localId, rawId, database = 'message_0.db') => ({
  messageKey: `${database}:${localId}`, localId,
  serverId: Number(rawId), serverIdRaw: String(rawId),
  createTime: 1700000000, sortSeq: localId,
  senderUsername: 'synthetic-friend', isSend: 0,
  localType: 1, _db_path: database, parsedContent: 'synthetic'
})
test.beforeEach(() => store.getState().reset())

test('refresh preserves adjacent raw IDs that round to the same Number', () => {
  const first = message(7, '9007199254741007')
  const second = message(8, '9007199254741008')
  assert.equal(first.serverId, second.serverId)
  store.getState().setMessages([first])
  store.getState().appendMessages([second])
  assert.equal(store.getState().messages.length, 2)
  assert.equal(store.getState().messages[1].serverIdRaw, second.serverIdRaw)
})
test('repeated refresh still removes the same message', () => {
  const row = message(7, '9007199254741007')
  store.getState().setMessages([row])
  store.getState().appendMessages([row])
  assert.equal(store.getState().messages.length, 1)
})
test('local IDs and server aliases remain scoped to the source shard', () => {
  store.getState().setMessages([message(7, '9007199254741007')])
  store.getState().appendMessages([message(7, '9007199254741007', 'message_1.db')], true)
  assert.equal(store.getState().messages.length, 2)
})
test('leading zero strings keep their numeric alias', () => {
  store.getState().setMessages([message(7, 123)])
  store.getState().appendMessages([message(8, '000123')])
  assert.equal(store.getState().messages.length, 1)
})
test('zero server IDs do not alias distinct local messages', () => {
  store.getState().setMessages([message(7, '0')])
  store.getState().appendMessages([message(8, '0')])
  assert.equal(store.getState().messages.length, 2)
})
test('providers without a raw ID retain safe numeric alias behavior', () => {
  const first = message(7, 123), second = message(8, 123)
  delete first.serverIdRaw
  delete second.serverIdRaw
  store.getState().setMessages([first])
  store.getState().appendMessages([second])
  assert.equal(store.getState().messages.length, 1)
})
