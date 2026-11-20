// jsdom integration check for the background-jobs sidebar panel.
//
// Renders the real Client half through React DOM with fake stores/services so
// the initial render, effects (roster watch, auto-select, observation), ANSI
// output, follow toggle, and the two-press kill control all execute.
//
// Run: `npm install` (dev dependencies) then `npm run test:render`.
import { JSDOM } from 'jsdom'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url))

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
  url: 'http://127.0.0.1/',
  pretendToBeVisual: true,
})
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.HTMLElement = dom.window.HTMLElement
globalThis.Node = dom.window.Node
globalThis.MouseEvent = dom.window.MouseEvent
globalThis.IS_REACT_ACT_ENVIRONMENT = true
try {
  globalThis.localStorage = dom.window.localStorage
} catch {
  Object.defineProperty(globalThis, 'localStorage', { value: dom.window.localStorage, configurable: true })
}
window.__ModuleLoader__ = {
  load(definition) {
    window.__definition = definition
  },
}

const React = await import('react')
const { createRoot } = await import('react-dom/client')
const { act } = React

await import(pathToFileURL(clientPath).href + `?render=${Date.now()}`)
const definition = window.__definition
assert.ok(definition !== undefined, 'client bundle registered')
const api = definition.factory(() => React)
const { copy } = api.__internals

function makeT(dict) {
  return (key, params) => {
    const template = dict[key] ?? key
    return params === undefined
      ? template
      : template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
  }
}
const t = makeT(copy.zh)

function createStore(initial) {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
  }
}

const sessionId = 'session-demo'
const jobId = 'pwsh-demo'
const runningJob = {
  id: jobId,
  kind: 'pwsh',
  label: 'Run the demo job',
  owner: sessionId,
  status: 'running',
  startedAt: Date.now() - 4200,
  output: { total: 64, earliest: 0 },
  progress: 'building 3/7',
}
const doneJob = {
  id: 'pwsh-done',
  kind: 'pwsh',
  label: 'Finished demo job',
  owner: sessionId,
  status: 'completed',
  startedAt: Date.now() - 60000,
  finishedAt: Date.now() - 55000,
  detail: 'exit code: 0',
  output: { total: 12, earliest: 0 },
}

const jobsState = createStore({
  rows: { [sessionId]: [runningJob, doneJob] },
  observed: {
    [jobId]: {
      jobId,
      text: '\u001b[32mhello\u001b[0m from job\nprogress 1\rprogress 2\n',
      gapBefore: false,
      streaming: true,
    },
  },
})
const watchCalls = []
const observeCalls = []
const killCalls = []
const releases = []
const selectPanelCalls = []
const registrations = []
const inspectRegistrations = []
const themeState = createStore({
  preference: 'dark',
  revision: 1,
  active: { id: 'dark', colorScheme: 'dark' },
  fontSizes: { text: 14, code: 12, terminal: 13 },
  fontFamilies: { text: '', code: '', terminal: 'Cascadia Mono' },
})

const fakeContext = {
  effect(callback) {
    const cleanup = callback()
    return () => {
      if (typeof cleanup === 'function') cleanup()
    }
  },
  get(name) {
    return fakeContext[name]
  },
  inject(names, callback) {
    if (names.every((name) => fakeContext[name] !== undefined)) callback(fakeContext)
    return () => {}
  },
  on() {
    return () => {}
  },
  locale: {
    bind: () => t,
    register: () => () => {},
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
  cordisInspect: {
    register(provider) {
      inspectRegistrations.push(provider)
      return () => {}
    },
  },
  theme: { getTheme: () => themeState.getSnapshot() },
  uiSession: { adapter: { current: createStore({ key: sessionId }) } },
  sessions: {
    list: createStore({
      ids: [sessionId, 'session-other'],
      byId: {
        [sessionId]: { id: sessionId, displayTitle: 'Demo session', running: true, updatedAt: 2 },
        'session-other': { id: 'session-other', displayTitle: 'Other session', running: false, updatedAt: 1 },
      },
    }),
  },
  jobs: {
    state: jobsState,
    watchRows(id) {
      watchCalls.push(id)
      return () => releases.push('watch')
    },
    observe(id, job) {
      observeCalls.push([id, job])
      return () => releases.push('observe')
    },
    kill(id, job) {
      killCalls.push([id, job])
      return Promise.resolve({ ok: true })
    },
  },
  layout: {
    panelInfo: createStore({ activePanelId: 'jobs' }),
    selectPanel(panel) {
      selectPanelCalls.push(panel)
    },
  },
}

api.apply(fakeContext)
const main = registrations.find((entry) => entry.name === 'main')
assert.ok(main !== undefined, 'main panel registered')
const injected = main.inject()
const root = createRoot(document.getElementById('root'))
await act(async () => {
  root.render(React.createElement(main.component, { ...injected, t }))
})
await act(async () => {
  await Promise.resolve()
})

const page = document.querySelector('[data-job-terminal]')
assert.ok(page !== null, 'panel rendered')
const text = page.textContent
assert.match(text, /后台任务/)
assert.match(text, /Demo session/)
assert.match(text, /Run the demo job/)
assert.match(text, /Finished demo job/)
assert.match(text, /hello from job/)
assert.match(text, /progress 2/)
assert.match(text, /运行中/)
assert.match(text, /已完成/)
assert.equal(watchCalls[0], sessionId, 'the current Session roster is watched')
assert.deepEqual(observeCalls[0], [sessionId, jobId], 'the first live job is observed')
assert.equal(inspectRegistrations.length, 1, 'diagnostic provider registered')
assert.equal(inspectRegistrations[0].query('status').sidebarEntry, true)

const follow = page.querySelector('.dshjt_follow')
assert.ok(follow !== null)
assert.equal(follow.textContent, '跟随中')
await act(async () => {
  follow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
assert.equal(follow.textContent, '已暂停', 'follow toggle pauses')
await act(async () => {
  follow.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
assert.equal(follow.textContent, '跟随中', 'follow toggle resumes')

const stop = page.querySelector('.dshjt_stop')
assert.ok(stop !== null, 'stop control rendered for the live job')
await act(async () => {
  stop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
assert.equal(stop.getAttribute('data-kill-state'), 'armed', 'first press arms the stop')
await act(async () => {
  stop.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
  await Promise.resolve()
})
assert.equal(killCalls.length, 1, 'second press requests the kill')
assert.deepEqual(killCalls[0], [sessionId, jobId])
assert.equal(stop.getAttribute('data-kill-state'), 'idle', 'successful kill returns to idle')

const back = page.querySelector('.dshjt_back')
assert.ok(back !== null)
await act(async () => {
  back.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
assert.deepEqual(selectPanelCalls, [null], 'back returns to the conversation')

await act(async () => {
  root.unmount()
})
assert.ok(releases.includes('watch'), 'roster watch released on unmount')
assert.ok(releases.includes('observe'), 'observation released on unmount')

console.log('RENDER TEST OK')
