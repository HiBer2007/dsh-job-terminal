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
const ReactDOM = await import('react-dom')
const { createRoot } = await import('react-dom/client')
const { act } = React

await import(pathToFileURL(clientPath).href + `?render=${Date.now()}`)
const definition = window.__definition
assert.ok(definition !== undefined, 'client bundle registered')
const api = definition.factory((spec) => {
  if (spec === 'react') return React
  if (spec === 'react-dom') return ReactDOM
  throw new Error(`unexpected module request: ${spec}`)
})
const { copy, focus } = api.__internals

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
    'pwsh-done': {
      jobId: 'pwsh-done',
      text: 'finished output line\n',
      gapBefore: false,
      streaming: false,
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

// ── header shadow: open button hands the exact job to the panel ────────────
const header = registrations.find((entry) => entry.name === 'conversation.session.header.actions')
assert.ok(header !== undefined, 'session-header job list shadow registered')
assert.equal(header.id, 'job-list')
assert.equal(header.priority, -1, 'the shadow wins over the shipped entry')
const headerInjected = header.inject()
assert.equal(headerInjected.focusState, focus, 'the header and the panel share the focus store')

const headerContainer = document.createElement('div')
document.body.appendChild(headerContainer)
const headerRoot = createRoot(headerContainer)
await act(async () => {
  headerRoot.render(React.createElement(header.component, { ...headerInjected, t, sessionId }))
})
await act(async () => {
  await Promise.resolve()
})

const trigger = headerContainer.querySelector('.Ag-ohG_trigger')
assert.ok(trigger !== null, 'job trigger renders in the session header')
await act(async () => {
  trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
let menu = document.querySelector('.Ag-ohG_menu')
assert.ok(menu !== null, 'job popover renders in a body portal')
assert.match(menu.textContent, /Run the demo job/)

const liveLine = [...menu.querySelectorAll('.Ag-ohG_rowLine')].find((line) => line.textContent.includes('Run the demo job'))
assert.ok(liveLine !== undefined)
const liveRowButton = liveLine.querySelector('.Ag-ohG_row')
assert.ok(liveRowButton !== null)
await act(async () => {
  liveRowButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
const inlineTerminal = document.querySelector('.dsjjt_menuTerminal')
assert.ok(inlineTerminal !== null, 'expanding a row renders the inline retained output')
assert.match(inlineTerminal.textContent, /hello from job/)
assert.match(inlineTerminal.textContent, /progress 2/)

const settledToggle = menu.querySelector('.Ag-ohG_sectionToggle')
assert.ok(settledToggle !== null, 'finished section toggle renders')
await act(async () => {
  settledToggle.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
menu = document.querySelector('.Ag-ohG_menu')
const settledLine = [...menu.querySelectorAll('.Ag-ohG_rowLine')].find((line) => line.textContent.includes('Finished demo job'))
assert.ok(settledLine !== undefined, 'finished job row expands')
const openButton = settledLine.querySelector('.dsjjt_open')
assert.ok(openButton !== null, 'open button sits in the finished job row')
assert.equal(openButton.getAttribute('aria-label'), '在后台任务面板中打开 Finished demo job')

await act(async () => {
  openButton.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
})
assert.ok(selectPanelCalls.includes('jobs'), 'open selects the jobs panel')
assert.deepEqual(
  { sessionId: focus.getSnapshot()?.sessionId, jobId: focus.getSnapshot()?.jobId },
  { sessionId, jobId: 'pwsh-done' },
  'open hands the exact finished job to the panel',
)
assert.equal(document.querySelector('.Ag-ohG_menu'), null, 'open closes the popover')

await act(async () => {
  headerRoot.unmount()
})
headerContainer.remove()

// The panel consumes the handoff and selects the finished job instead of the
// first live job its default selection would otherwise choose.
const focusedContainer = document.createElement('div')
document.body.appendChild(focusedContainer)
const focusedRoot = createRoot(focusedContainer)
await act(async () => {
  focusedRoot.render(React.createElement(main.component, { ...injected, t }))
})
await act(async () => {
  await Promise.resolve()
})
const focusedPage = focusedContainer.querySelector('[data-job-terminal]')
assert.ok(focusedPage !== null)
assert.match(focusedPage.textContent, /Finished demo job/)
assert.match(focusedPage.textContent, /finished output line/)
assert.equal(focusedPage.querySelector('.dshjt_outTitle')?.textContent, 'Finished demo job')
assert.deepEqual(observeCalls.at(-1), [sessionId, 'pwsh-done'], 'the focused finished job is observed')
assert.equal(focus.getSnapshot(), null, 'the handoff is consumed once')

await act(async () => {
  focusedRoot.unmount()
})
focusedContainer.remove()

console.log('RENDER TEST OK')
