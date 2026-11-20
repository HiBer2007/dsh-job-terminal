// Unit tests for the background-jobs sidebar browser half.
//
// The Client bundle is plain JavaScript that registers itself with
// `window.__ModuleLoader__`, so the test installs a fake loader, imports the
// real file, and exercises the pure internals plus the apply-time wiring. It
// never renders React: the loader's `require('react')` gets a small stub.
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')

/** @type {{ id?: string, factory?: (require: (spec: string) => unknown) => any }} */
let definition
globalThis.window = {
  __ModuleLoader__: {
    load(candidate) {
      definition = candidate
    },
  },
}

await import(pathToFileURL(path.join(root, 'client.js')).href + `?test=${Date.now()}`)
assert.ok(definition !== undefined, 'client.js must register a module definition')
assert.equal(definition.id, '@local/dsh-job-terminal')
assert.equal(typeof definition.factory, 'function')

const reactStub = {
  Component: class Component {
    constructor(props) {
      this.props = props ?? {}
      this.state = {}
    }
  },
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children }
  },
  useSyncExternalStore: () => undefined,
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useLayoutEffect: () => {},
  useMemo: (factory) => factory(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (callback) => callback,
}

const api = definition.factory((spec) => {
  assert.equal(spec, 'react', 'the bundle may only require react')
  return reactStub
})
const internals = api.__internals
const {
  parseTerminal,
  paletteColor,
  formatBytes,
  formatDuration,
  byteLengthOf,
  orderJobs,
  sessionChoices,
  isLive,
  statusName,
  dotState,
  terminalFontFamily,
  copy,
  DEFAULT_SGR,
} = internals

/** Join parsed lines back to plain strings. */
function lineTexts(parsed) {
  return parsed.lines.map((runs) => runs.map((run) => run.text).join(''))
}

/** The zh duration templates used by formatDuration tests. */
function zhTime(key, params) {
  const templates = {
    'duration.seconds': '{seconds}秒',
    'duration.minutes': '{minutes}分{seconds}秒',
    'duration.hours': '{hours}时{minutes}分',
  }
  return templates[key].replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
}

// ── manifest shape ─────────────────────────────────────────────────────────
assert.ok(api.inject.includes('jobs'), 'the plugin injects the Client jobs service')
assert.ok(api.inject.includes('slots'))
assert.ok(api.inject.includes('locale'))
assert.ok(api.inject.includes('uiSession'))
assert.ok(api.inject.includes('sessions'))
assert.ok(api.inject.includes('theme'))
assert.ok(api.inject.includes('layout'))
assert.equal(typeof api.apply, 'function')

// ── copy dictionaries ──────────────────────────────────────────────────────
const zhKeys = Object.keys(copy.zh).sort()
const enKeys = Object.keys(copy.en).sort()
assert.deepEqual(enKeys, zhKeys, 'zh and en dictionaries must carry identical keys')
assert.ok(zhKeys.length > 40)
for (const key of zhKeys) {
  assert.ok(typeof copy.zh[key] === 'string' && copy.zh[key].length > 0, `zh.${key} is a non-empty string`)
  assert.ok(typeof copy.en[key] === 'string' && copy.en[key].length > 0, `en.${key} is a non-empty string`)
}

const zhMeta = JSON.parse(await readFile(path.join(root, 'locale', 'zh.json'), 'utf8'))
const enMeta = JSON.parse(await readFile(path.join(root, 'locale', 'en.json'), 'utf8'))
assert.equal(typeof zhMeta.meta.title, 'string')
assert.equal(typeof zhMeta.meta.description, 'string')
assert.equal(typeof enMeta.meta.title, 'string')
assert.equal(typeof enMeta.meta.description, 'string')

// ── terminal parsing ───────────────────────────────────────────────────────
{
  const parsed = parseTerminal('one\ntwo\r\nthree')
  assert.deepEqual(lineTexts(parsed), ['one', 'two', 'three'])
  assert.equal(parsed.plain, 'one\ntwo\nthree')
  assert.equal(parsed.truncated, false)
}

{
  const parsed = parseTerminal('a\n')
  assert.deepEqual(lineTexts(parsed), ['a', ''])
}

{
  const parsed = parseTerminal('\u001b[31mred\u001b[0m plain')
  assert.deepEqual(lineTexts(parsed), ['red plain'])
  assert.equal(parsed.lines[0].length, 2)
  assert.equal(parsed.lines[0][0].style.color, '#cc0000')
  assert.equal(parsed.lines[0][1].style.color, undefined)
}

{
  const parsed = parseTerminal('\u001b[1;4;3mstyled\u001b[0m')
  const style = parsed.lines[0][0].style
  assert.equal(style.fontWeight, 600)
  assert.match(style.textDecoration, /underline/)
  assert.equal(style.fontStyle, 'italic')
}

{
  const parsed = parseTerminal('\u001b[38;5;196mX')
  assert.equal(parsed.lines[0][0].style.color, 'rgb(255, 0, 0)')
  assert.equal(paletteColor(196), 'rgb(255, 0, 0)')
  assert.equal(paletteColor(16), 'rgb(0, 0, 0)')
  assert.equal(paletteColor(231), 'rgb(255, 255, 255)')
  assert.equal(paletteColor(232), 'rgb(8, 8, 8)')
}

{
  const parsed = parseTerminal('\u001b[38;2;1;2;3mX')
  assert.equal(parsed.lines[0][0].style.color, 'rgb(1, 2, 3)')
}

{
  const parsed = parseTerminal('\u001b[31;47;7mX')
  assert.equal(parsed.lines[0][0].style.color, '#d3d7cf')
  assert.equal(parsed.lines[0][0].style.backgroundColor, '#cc0000')
}

{
  const parsed = parseTerminal('10%\r20%\r30%')
  assert.deepEqual(lineTexts(parsed), ['30%'])
}

{
  // A shorter rewrite leaves the tail of the previous line untouched, exactly
  // like a terminal without an erase-line sequence.
  const parsed = parseTerminal('100%\r50%')
  assert.deepEqual(lineTexts(parsed), ['50%%'])
}

{
  const parsed = parseTerminal('abc\r\u001b[Kxy')
  assert.deepEqual(lineTexts(parsed), ['xy'])
}

{
  const parsed = parseTerminal('abc\bX')
  assert.deepEqual(lineTexts(parsed), ['abX'])
}

{
  const parsed = parseTerminal('\u001b[2;3HX')
  assert.deepEqual(lineTexts(parsed), ['', '  X'])
}

{
  const parsed = parseTerminal('\u001b[2Jgone')
  assert.deepEqual(lineTexts(parsed), ['gone'])
}

{
  const parsed = parseTerminal('\u001b]0;a title\u0007hi')
  assert.deepEqual(lineTexts(parsed), ['hi'])
}

{
  const parsed = parseTerminal('\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\')
  assert.deepEqual(lineTexts(parsed), ['link'])
}

{
  const parsed = parseTerminal('a\tb')
  assert.deepEqual(lineTexts(parsed), ['a       b'])
}

{
  const parsed = parseTerminal('你a')
  assert.deepEqual(lineTexts(parsed), ['你a'])
  assert.equal(parsed.plain, '你a')
}

{
  const parsed = parseTerminal('x   ')
  assert.deepEqual(lineTexts(parsed), ['x'])
  assert.equal(parsed.plain, 'x')
}

{
  const source = Array.from({ length: 2505 }, (_, index) => `line-${index}`).join('\n')
  const parsed = parseTerminal(source)
  assert.equal(parsed.lineCount, 2505)
  assert.equal(parsed.shown, 2000)
  assert.equal(parsed.truncated, true)
  assert.deepEqual(lineTexts(parsed)[0], 'line-505')
  assert.ok(parsed.plain.startsWith('line-0\n'), 'copy text keeps the full retained transcript')
}

{
  const parsed = parseTerminal('')
  assert.deepEqual(lineTexts(parsed), [''])
  assert.equal(parsed.plain, '')
}

// ── formatting ─────────────────────────────────────────────────────────────
assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(1023), '1023 B')
assert.equal(formatBytes(1536), '1.5 KB')
assert.equal(formatBytes(100 * 1024), '100 KB')
assert.equal(formatBytes(1024 * 1024), '1.0 MB')
assert.equal(formatBytes(-1), '---')
assert.equal(formatBytes(undefined), '---')

assert.equal(formatDuration(0, zhTime), '0.0秒')
assert.equal(formatDuration(4200, zhTime), '4.2秒')
assert.equal(formatDuration(65000, zhTime), '1分05秒')
assert.equal(formatDuration(3723000, zhTime), '1时02分')
assert.equal(formatDuration(Number.NaN, zhTime), '0.0秒')

assert.equal(byteLengthOf(''), 0)
assert.equal(byteLengthOf('abc'), 3)
assert.equal(byteLengthOf('你'), 3)
assert.equal(byteLengthOf('😀'), 4)

assert.equal(terminalFontFamily(''), 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace')
assert.match(terminalFontFamily('Cascadia Mono'), /^Cascadia Mono, ui-monospace/)

// ── job and session projection ─────────────────────────────────────────────
const liveEarly = { id: 'a', status: 'running', startedAt: 10 }
const liveLate = { id: 'b', status: 'stopping', startedAt: 20 }
const doneEarly = { id: 'c', status: 'completed', startedAt: 1, finishedAt: 100 }
const doneLate = { id: 'd', status: 'failed', startedAt: 2, finishedAt: 200 }
assert.deepEqual(orderJobs([doneEarly, liveLate, doneLate, liveEarly]).map((job) => job.id), ['a', 'b', 'd', 'c'])
assert.equal(isLive(liveEarly), true)
assert.equal(isLive(doneEarly), false)
assert.equal(statusName('queued'), 'unknown')
assert.equal(statusName('killed'), 'killed')
assert.equal(dotState('running'), 'running')
assert.equal(dotState('stopping'), 'stopping')
assert.equal(dotState('completed'), 'completed')
assert.equal(dotState('failed'), 'failed')
assert.equal(dotState('killed'), 'idle')

const choices = sessionChoices({
  ids: ['old', 'new', 'missing-row'],
  byId: {
    old: { displayTitle: 'Old session', running: false, updatedAt: 10 },
    new: { title: 'New session', running: true, updatedAt: 20 },
  },
})
assert.deepEqual(choices, [
  { id: 'new', title: 'New session', running: true, updatedAt: 20 },
  { id: 'old', title: 'Old session', running: false, updatedAt: 10 },
])

// ── apply-time wiring ──────────────────────────────────────────────────────
function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

const registrations = []
const inspectRegistrations = []
const events = new Map()
const effects = []
const localeNamespaces = []
const fakeContext = {
  effect(callback) {
    const cleanup = callback()
    if (typeof cleanup === 'function') effects.push(cleanup)
    return () => {}
  },
  get(name) {
    return fakeContext[name]
  },
  inject(names, callback) {
    if (names.every((name) => fakeContext[name] !== undefined)) callback(fakeContext)
    return () => {}
  },
  on(event, listener) {
    if (!events.has(event)) events.set(event, new Set())
    events.get(event).add(listener)
    return () => {
      events.get(event)?.delete(listener)
    }
  },
  cordisInspect: {
    register(provider) {
      inspectRegistrations.push(provider)
      return () => {}
    },
  },
  locale: {
    bind: () => (key) => key,
    register(namespace, dictionaries) {
      localeNamespaces.push({ namespace, dictionaries })
      return () => {}
    },
  },
  slots: {
    inject(_name, callback) {
      callback()
      return () => {}
    },
    register(options, component) {
      registrations.push({ ...options, component })
      return () => {}
    },
    entries(name) {
      return registrations.filter((entry) => entry.name === name).map((entry) => ({ options: entry }))
    },
  },
  theme: {
    getTheme: () => ({
      preference: 'system',
      revision: 1,
      active: { id: 'dark', colorScheme: 'dark' },
      fontSizes: { text: 14, code: 12, terminal: 13 },
      fontFamilies: { text: '', code: '', terminal: 'Cascadia Mono' },
    }),
  },
  uiSession: { adapter: { current: createStore({ key: 'session-1' }) } },
  sessions: {
    list: createStore({
      ids: ['session-1'],
      byId: { 'session-1': { id: 'session-1', displayTitle: 'One', running: true, updatedAt: 1 } },
    }),
  },
  jobs: {
    state: createStore({ rows: {}, observed: {} }),
    watchRows: () => () => {},
    observe: () => () => {},
    kill: async () => ({ ok: true }),
  },
  layout: { selectPanel: () => {} },
}

api.apply(fakeContext)

assert.equal(localeNamespaces.length, 1)
assert.equal(localeNamespaces[0].namespace, 'jobTerminal')

const mainRegistration = registrations.find((entry) => entry.name === 'main')
assert.ok(mainRegistration !== undefined, 'the main panel is registered')
assert.equal(mainRegistration.key, 'jobs')
assert.equal(mainRegistration.locale, 'jobTerminal')
assert.equal(typeof mainRegistration.inject, 'function')
const injected = mainRegistration.inject()
assert.equal(typeof injected.watchRows, 'function')
assert.equal(typeof injected.observe, 'function')
assert.equal(typeof injected.killJob, 'function')
assert.equal(typeof injected.backToConversation, 'function')
assert.equal(typeof injected.jobsState.getSnapshot, 'function')
assert.equal(typeof injected.themeState.getSnapshot, 'function')
assert.equal(injected.lastSession.id, 'session-1', 'the last watched Session is remembered')

const panelRegistration = registrations.find((entry) => entry.name === 'sidebar.panellist')
assert.ok(panelRegistration !== undefined, 'the sidebar entry is registered')
assert.equal(panelRegistration.id, 'jobs')
assert.equal(panelRegistration.order, 5)
assert.equal(panelRegistration.label(), 'panel.title')
assert.equal(typeof panelRegistration.component, 'function')

const icon = panelRegistration.component({ size: 16 })
assert.equal(icon.type, 'svg')
assert.equal(icon.props.width, 16)
assert.equal(icon.props.height, 16)
assert.equal(icon.props['aria-hidden'], 'true')
assert.ok(Array.isArray(icon.children) && icon.children.length >= 3, 'the icon draws a terminal glyph')

const themeStore = injected.themeState
assert.equal(themeStore.getSnapshot().active.colorScheme, 'dark')
for (const listener of events.get('theme/change') ?? []) {
  listener({
    preference: 'dark',
    revision: 2,
    active: { id: 'light', colorScheme: 'light' },
    fontSizes: { text: 14, code: 12, terminal: 14 },
    fontFamilies: { text: '', code: '', terminal: '' },
  })
}
assert.equal(themeStore.getSnapshot().active.colorScheme, 'light')
assert.equal(themeStore.getSnapshot().fontSizes.terminal, 14)

// The diagnostic provider registers only after the seats exist; its presence
// proves a successful Client activation through `cordis_inspect_query`.
assert.equal(inspectRegistrations.length, 1)
const provider = inspectRegistrations[0]
assert.equal(provider.manifest.id, 'JobTerminal')
assert.equal(provider.manifest.methods[0].name, 'status')
assert.equal(provider.manifest.methods[0].inputSchema.additionalProperties, false)
const status = provider.query('status')
assert.equal(status.active, true)
assert.equal(status.panelId, 'jobs')
assert.equal(status.sidebarEntry, true)
assert.equal(status.mainPanel, true)
assert.equal(status.lastSession, 'session-1')
assert.equal(status.currentSession, 'session-1')
assert.equal(status.activePanel, null)
assert.equal(status.watchedSessions, 0)
assert.equal(status.localeNamespace, 'jobTerminal')
assert.throws(() => provider.query('nope'), /unknown JobTerminal inspect method/)

// The registered page wrapper renders an error boundary around the panel and
// keeps the slot entry alive when the panel render fails.
const page = mainRegistration.component
assert.equal(typeof page, 'function')
const pageT = (key, params) => (params === undefined ? `t:${key}` : `t:${key} ${JSON.stringify(params)}`)
const pageTree = page({ t: pageT })
assert.equal(typeof pageTree.type, 'function')
assert.equal(pageTree.props.t('error.title'), 't:error.title')
const boundary = pageTree.type
const boundaryInstance = new boundary({ t: pageT })
boundaryInstance.state = { error: new Error('boom') }
const fallback = boundaryInstance.render()
assert.equal(fallback.type, 'div')
assert.ok(fallback.props.className.includes('dshjt_errorPage'))
const titleNode = fallback.children[0].children[0]
assert.equal(titleNode.children[0], 't:error.title')
const textNode = fallback.children[0].children[1]
assert.match(textNode.children[0], /boom/)

for (const cleanup of effects) cleanup()
