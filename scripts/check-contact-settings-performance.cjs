// Run the actual source callbacks with deterministic synthetic inputs.
// Operation counts avoid machine-dependent timing assertions.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const esbuild = require('esbuild')
const root = path.resolve(__dirname, '..')
const source = file => fs.readFileSync(path.join(root, file), 'utf8').replace(/\r\n/g, '\n')

function settingsCallback(sessions, contacts = []) {
  const page = source('src/pages/SettingsPage.tsx')
  const marker = '  const { sessionFilterOptionMap, sessionFilterOptions } = useMemo(() => {'
  const begin = page.indexOf(marker)
  const end = page.indexOf('  }, [chatSessions, messagePushContactOptions])', begin)
  assert(begin >= 0 && end > begin, 'settings memo callback must be found')
  const body = page.slice(begin + marker.length, end)
  const code = esbuild.transformSync(`(() => {${body}})()`, { loader: 'ts' }).code
  return vm.runInNewContext(code, {
    chatSessions: sessions, messagePushContactOptions: contacts,
    getSessionDisplayName: session => session.username,
    getSessionFilterType: () => 'private',
    displayNameOrFallback: (username, ...names) => names.find(Boolean) || username
  })
}
test('settings preserves ordering without comparator list scans', () => {
  let visits = 0, seed = 17
  const sessions = Array.from({ length: 3557 }, (_, i) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return { username: `synthetic-${i}`, sortTimestamp: seed % 100000, lastTimestamp: i }
  })
  sessions.find = function (predicate) {
    return Array.prototype.find.call(this, row => { visits++; return predicate(row) })
  }
  const contacts = [{ username: 'contact-only', type: 'friend' }]
  const expected = [...sessions, { username: 'contact-only' }]
    .sort((a, b) => Number(b.sortTimestamp || b.lastTimestamp || 0) - Number(a.sortTimestamp || a.lastTimestamp || 0))
    .map(row => row.username)
  const result = settingsCallback(sessions, contacts)
  assert.deepEqual(Array.from(result.sessionFilterOptions, row => row.username), expected)
  assert(visits <= sessions.length * 4, `unexpected ${visits} list visits`)
})
test('settings retains first-match semantics and timestamp fallback', () => {
  const sessions = [
    { username: 'first', sortTimestamp: 0, lastTimestamp: 7 },
    { username: 'second', sortTimestamp: 6, lastTimestamp: 10 },
    { username: 'first', sortTimestamp: 100, lastTimestamp: 100 }
  ]
  const result = settingsCallback(sessions, [{ username: 'contact-only', type: 'friend' }])
  assert.deepEqual(Array.from(result.sessionFilterOptions, row => row.username), ['first', 'second', 'contact-only'])
  assert.equal(settingsCallback([]).sessionFilterOptions.length, 0)
})
test('contact transformation reads the system-account prefix once per batch', async () => {
  const service = source('electron/services/chatService.ts')
  const begin = service.indexOf('      const contacts: (ContactInfo & { lastContactTime: number })[] = []')
  const end = service.indexOf("      captureStage('transformContacts', transformStartedAt)", begin)
  assert(begin >= 0 && end > begin, 'contact transformation must be found')
  const body = service.slice(begin, end)
  const code = esbuild.transformSync(`(async function () {${body}\nreturn contacts})`, { loader: 'ts' }).code
  let configReads = 0
  const context = {
    rows: Array.from({ length: 3000 }, (_, i) => ({ username: `synthetic-${i}`, local_type: 1, flag: 3 })),
    isLiteMode: true, accountScope: 'synthetic', epoch: 1,
    lastContactTimeMap: new Map(), BUILTIN_OFFICIAL_HELPER_USERNAMES: new Set(), FRIEND_EXCLUDE_USERNAMES: new Set(),
    captureStage() {}, Date
  }
  const instance = {
    configService: { get(name) { assert.equal(name, 'systemAccountId'); configReads++; return ' SYS ' } },
    getOfficialAccountTypeMap: async () => new Map(),
    isAccountCacheContextCurrent: () => true,
    getRowInt: (row, fields, fallback) => Number(fields.map(field => row[field]).find(value => value != null) ?? fallback),
    getRowField: (row, fields) => fields.map(field => row[field]).find(value => value != null),
    isEnterpriseOpenimUsername: () => false
  }
  const transform = vm.runInNewContext(code, context)
  const contacts = await transform.call(instance)
  assert.equal(contacts.length, 3000)
  assert.equal(configReads, 1)
  assert(contacts.every(row => row.type === 'friend'))
})
