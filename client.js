// Background jobs sidebar — browser half.
//
// Registers one left-sidebar entry (`jobs`) and the main panel it opens. The
// panel lists the selected Session's background jobs and streams the selected
// job's retained output into a terminal-style view.
//
// Why this is a live attach without a second transport: a `dsh-jobs` job is a
// pipe-backed producer, and its bounded output ring is the only live output
// source — there is no OS PTY handle to re-open after the job already started.
// The Client `jobs` service (installed by `@deepseek-ai/dsh-api-job-controller`)
// follows that ring at absolute offsets without touching the model's consuming
// cursor. This module subscribes to those same live bytes and renders them like
// a terminal: ANSI SGR colors, carriage-return overwrite, tabs, backspace,
// erase-line/display, and auto-follow. It never consumes output and never adds
// model context.
window.__ModuleLoader__.load({
  id: '@local/dsh-job-terminal',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const ID = '@local/dsh-job-terminal'
    const PANEL_ID = 'jobs'
    const NS = 'jobTerminal'
    const LAST_SESSION_KEY = 'dsh.job-terminal.last-session'
    const STICK_THRESHOLD = 24
    const SCAN_LINE_CAP = 6000
    const RENDER_LINE_CAP = 2000
    const KILL_ARM_MS = 3000
    const KILL_FAILED_MS = 2000
    const COPY_FEEDBACK_MS = 1600
    const IDLE_KILL = Object.freeze({ key: undefined, state: 'idle' })
    const LIVE_STATUSES = new Set(['running', 'stopping'])

    // ── copy ────────────────────────────────────────────────────────────────
    const zh = {
      'panel.title': '后台任务',
      'panel.subtitle': '实时查看后台任务的输出，任务结束后保留可读的尾部输出',
      'header.live': '运行中',
      'header.settled': '已结束',
      'header.back': '返回对话',
      'header.backAria': '关闭后台任务面板并返回对话',
      'session.label': '会话',
      'session.aria': '选择要查看后台任务的会话',
      'session.none': '还没有会话',
      'section.live': '运行中',
      'section.settled': '已结束',
      'status.running': '运行中',
      'status.stopping': '停止中',
      'status.completed': '已完成',
      'status.killed': '已停止',
      'status.failed': '失败',
      'status.unknown': '未知',
      'duration.liveTitle': '已运行 {duration}',
      'duration.doneTitle': '运行了 {duration}',
      'duration.seconds': '{seconds}秒',
      'duration.minutes': '{minutes}分{seconds}秒',
      'duration.hours': '{hours}时{minutes}分',
      'job.empty': '本会话没有后台任务',
      'job.emptyHint': '当 agent 用 run_in_background 启动命令时，任务会出现在这里。',
      'job.noSession': '还没有选中会话',
      'job.noSessionHint': '先在左侧栏打开或新建一个会话，再回来查看后台任务。',
      'job.progressAria': '任务进度',
      'kill.stop': '停止任务 {label}',
      'kill.confirm': '再次点击红色停止按钮确认',
      'kill.confirmAria': '再次点击确认停止任务 {label}',
      'kill.confirmAction': '确认停止',
      'kill.pending': '正在停止…',
      'kill.failed': '停止失败，请重试',
      'kill.idleHint': '选择任务查看实时输出',
      'output.title': '实时输出',
      'output.aria': '后台任务实时输出',
      'output.noJob': '选择一个任务查看输出',
      'output.waiting': '等待任务输出…',
      'output.none': '这个任务没有保留的输出',
      'output.gap': '较早的输出已滚出保留窗口，下面从可用的最早位置继续。',
      'output.error': '输出流中断：{error}',
      'output.copy': '复制输出',
      'output.copyAria': '复制当前任务的输出',
      'output.copied': '已复制',
      'output.copyFailed': '复制失败',
      'output.follow': '跟随中',
      'output.paused': '已暂停',
      'output.followAria': '暂停或恢复自动跟随输出',
      'output.jump': '跳到最新',
      'output.jumpAria': '滚动到最新输出',
      'output.loaded': '已加载',
      'output.loadedAria': '当前视图已加载 {size} 输出',
      'output.truncated': '只显示最近 {count} 行；完整保留内容可用“复制输出”取得。',
      'output.hint': '终端渲染：ANSI 颜色、回车覆盖与自动跟随',
      'output.live': '实时',
      'output.finished': '已结束',
      'error.title': '后台任务面板出错',
      'error.hint': '刷新页面后重试。错误信息：{message}',
    }
    const en = {
      'panel.title': 'Background jobs',
      'panel.subtitle': 'Watch background-job output live; a settled job keeps a readable tail',
      'header.live': 'Running',
      'header.settled': 'Finished',
      'header.back': 'Back to chat',
      'header.backAria': 'Close the background jobs panel and return to the conversation',
      'session.label': 'Session',
      'session.aria': 'Choose the Session whose background jobs to show',
      'session.none': 'No Sessions yet',
      'section.live': 'Running',
      'section.settled': 'Finished',
      'status.running': 'running',
      'status.stopping': 'stopping',
      'status.completed': 'completed',
      'status.killed': 'stopped',
      'status.failed': 'failed',
      'status.unknown': 'unknown',
      'duration.liveTitle': 'Running for {duration}',
      'duration.doneTitle': 'Ran for {duration}',
      'duration.seconds': '{seconds}s',
      'duration.minutes': '{minutes}m {seconds}s',
      'duration.hours': '{hours}h {minutes}m',
      'job.empty': 'No background jobs in this Session',
      'job.emptyHint': 'Commands an agent starts with run_in_background appear here.',
      'job.noSession': 'No Session is selected',
      'job.noSessionHint': 'Open or start a Session in the left sidebar, then come back to see its background jobs.',
      'job.progressAria': 'Job progress',
      'kill.stop': 'Stop job {label}',
      'kill.confirm': 'Press the red stop button again to confirm',
      'kill.confirmAria': 'Press again to confirm stopping {label}',
      'kill.confirmAction': 'Confirm stop',
      'kill.pending': 'Stopping…',
      'kill.failed': 'Stop failed; try again',
      'kill.idleHint': 'Select a job to watch its live output',
      'output.title': 'Live output',
      'output.aria': 'Live output of the background job',
      'output.noJob': 'Select a job to see its output',
      'output.waiting': 'Waiting for the job to write output…',
      'output.none': 'This job has no retained output',
      'output.gap': 'Earlier output scrolled out of the retention window; the view continues from the earliest retained byte.',
      'output.error': 'The output stream stopped: {error}',
      'output.copy': 'Copy output',
      'output.copyAria': 'Copy the current job output',
      'output.copied': 'Copied',
      'output.copyFailed': 'Copy failed',
      'output.follow': 'Following',
      'output.paused': 'Paused',
      'output.followAria': 'Pause or resume automatic output following',
      'output.jump': 'Jump to latest',
      'output.jumpAria': 'Scroll to the latest output',
      'output.loaded': 'Loaded',
      'output.loadedAria': '{size} of output loaded in this view',
      'output.truncated': 'Showing the latest {count} lines; use “Copy output” for the longer retained text.',
      'output.hint': 'Terminal rendering: ANSI colors, carriage-return overwrite, auto-follow',
      'output.live': 'live',
      'output.finished': 'finished',
      'error.title': 'The background jobs panel failed',
      'error.hint': 'Reload the page and try again. Error: {message}',
    }

    // ── ANSI palette and terminal parsing ──────────────────────────────────
    /** The Tango palette xterm.js uses as its default ANSI colors. */
    const ANSI_PALETTE = [
      '#2e3436', '#cc0000', '#4e9a06', '#c4a000', '#3465a4', '#75507b', '#06989a', '#d3d7cf',
      '#555753', '#ef2929', '#8ae234', '#fce94f', '#729fcf', '#ad7fa8', '#34e2e2', '#eeeeec',
    ]
    const DEFAULT_SGR = Object.freeze({
      fg: null,
      bg: null,
      bold: 0,
      dim: 0,
      italic: 0,
      underline: 0,
      inverse: 0,
      strike: 0,
    })
    const STYLE_CACHE = new Map()

    /**
     * One palette index as a CSS color, including the 6×6×6 cube and the
     * grayscale ramp of the 256-color set.
     * @param index - palette index, 0 through 255.
     * @returns CSS color string.
     */
    function paletteColor(index) {
      const value = Number.isInteger(index) ? index : 0
      if (value < 0 || value > 255) return ANSI_PALETTE[7]
      if (value < 16) return ANSI_PALETTE[value]
      if (value < 232) {
        const n = value - 16
        const channel = (level) => (level === 0 ? 0 : 55 + level * 40)
        return `rgb(${channel(Math.floor(n / 36))}, ${channel(Math.floor(n / 6) % 6)}, ${channel(n % 6)})`
      }
      const gray = 8 + (value - 232) * 10
      return `rgb(${gray}, ${gray}, ${gray})`
    }

    /**
     * Stable key for one SGR state, used to group adjacent cells into spans.
     * @param sgr - SGR state.
     * @returns key string.
     */
    function sgrKey(sgr) {
      return `${sgr.fg ?? ''}\u0000${sgr.bg ?? ''}\u0000${sgr.bold}${sgr.dim}${sgr.italic}${sgr.underline}${sgr.inverse}${sgr.strike}`
    }

    /**
     * Map an SGR state onto React inline style; inverse swaps the two colors.
     * @param sgr - SGR state.
     * @returns style object shared through the cache.
     */
    function styleOfSgr(sgr) {
      const key = sgrKey(sgr)
      const cached = STYLE_CACHE.get(key)
      if (cached !== undefined) return cached
      const style = {}
      let fg = sgr.fg
      let bg = sgr.bg
      if (sgr.inverse) {
        const previousFg = fg
        fg = bg ?? 'var(--dsw-alias-bg-base)'
        bg = previousFg ?? 'var(--dsw-alias-label-primary)'
      }
      if (fg !== null) style.color = fg
      if (bg !== null) style.backgroundColor = bg
      if (sgr.bold) style.fontWeight = 600
      if (sgr.dim) style.opacity = 0.55
      if (sgr.italic) style.fontStyle = 'italic'
      const decorations = []
      if (sgr.underline) decorations.push('underline')
      if (sgr.strike) decorations.push('line-through')
      if (decorations.length > 0) style.textDecoration = decorations.join(' ')
      STYLE_CACHE.set(key, style)
      return style
    }

    /**
     * Apply one SGR parameter list on top of a state.
     * @param state - current SGR state.
     * @param params - parsed CSI parameters (numeric).
     * @returns the next SGR state (the frozen default for a reset).
     */
    function applySgr(state, params) {
      if (params.length === 0) return DEFAULT_SGR
      let next = state
      const patch = (values) => {
        next = { ...next, ...values }
      }
      for (let index = 0; index < params.length; index += 1) {
        const param = params[index]
        if (param === 0) {
          next = DEFAULT_SGR
        } else if (param === 1) {
          patch({ bold: 1 })
        } else if (param === 2) {
          patch({ dim: 1 })
        } else if (param === 3) {
          patch({ italic: 1 })
        } else if (param === 4) {
          patch({ underline: 1 })
        } else if (param === 7) {
          patch({ inverse: 1 })
        } else if (param === 9) {
          patch({ strike: 1 })
        } else if (param === 22) {
          patch({ bold: 0, dim: 0 })
        } else if (param === 23) {
          patch({ italic: 0 })
        } else if (param === 24) {
          patch({ underline: 0 })
        } else if (param === 27) {
          patch({ inverse: 0 })
        } else if (param === 29) {
          patch({ strike: 0 })
        } else if (param >= 30 && param <= 37) {
          patch({ fg: ANSI_PALETTE[param - 30] })
        } else if (param === 38) {
          if (params[index + 1] === 5 && index + 2 < params.length) {
            patch({ fg: paletteColor(params[index + 2]) })
            index += 2
          } else if (params[index + 1] === 2 && index + 4 < params.length) {
            patch({ fg: `rgb(${params[index + 2]}, ${params[index + 3]}, ${params[index + 4]})` })
            index += 4
          }
        } else if (param === 39) {
          patch({ fg: null })
        } else if (param >= 40 && param <= 47) {
          patch({ bg: ANSI_PALETTE[param - 40] })
        } else if (param === 48) {
          if (params[index + 1] === 5 && index + 2 < params.length) {
            patch({ bg: paletteColor(params[index + 2]) })
            index += 2
          } else if (params[index + 1] === 2 && index + 4 < params.length) {
            patch({ bg: `rgb(${params[index + 2]}, ${params[index + 3]}, ${params[index + 4]})` })
            index += 4
          }
        } else if (param === 49) {
          patch({ bg: null })
        } else if (param >= 90 && param <= 97) {
          patch({ fg: ANSI_PALETTE[param - 90 + 8] })
        } else if (param >= 100 && param <= 107) {
          patch({ bg: ANSI_PALETTE[param - 100 + 8] })
        }
      }
      return next
    }

    /**
     * Parse one CSI parameter text such as `1;31` or `2K`.
     * @param raw - parameter bytes between `ESC [` and the final byte.
     * @returns numeric parameters; a private prefix is discarded.
     */
    function csiParams(raw) {
      if (raw === '') return []
      const body = raw[0] === '?' || raw[0] === '>' || raw[0] === '!' || raw[0] === '<' || raw[0] === '=' ? raw.slice(1) : raw
      return body.split(';').map((part) => {
        if (part === '') return 0
        const value = Number.parseInt(part, 10)
        return Number.isFinite(value) ? value : 0
      })
    }

    /**
     * Locate one escape sequence starting at `start`.
     * @param chars - code points of the source.
     * @param start - index of the ESC.
     * @returns kind, payload, and the index of the sequence's last consumed char.
     */
    function escapeAt(chars, start) {
      let index = start + 1
      if (index >= chars.length) return { kind: 'ignore', end: start }
      const lead = chars[index]
      if (lead === '[') {
        index += 1
        let raw = ''
        while (index < chars.length) {
          const code = chars[index].codePointAt(0)
          if (code >= 0x40 && code <= 0x7e) return { kind: 'csi', raw, final: chars[index], end: index }
          raw += chars[index]
          index += 1
        }
        return { kind: 'ignore', end: chars.length - 1 }
      }
      if (lead === ']') {
        index += 1
        while (index < chars.length) {
          if (chars[index] === '\u0007') return { kind: 'osc', end: index }
          if (chars[index] === '\u001b' && chars[index + 1] === '\\') return { kind: 'osc', end: index + 1 }
          index += 1
        }
        return { kind: 'ignore', end: chars.length - 1 }
      }
      if (lead === 'P' || lead === '^' || lead === '_') {
        index += 1
        while (index < chars.length && !(chars[index] === '\u001b' && chars[index + 1] === '\\')) index += 1
        return { kind: 'ignore', end: Math.min(index + 1, chars.length - 1) }
      }
      if (lead === '7') return { kind: 'save', end: index }
      if (lead === '8') return { kind: 'restore', end: index }
      if (lead === 'c') return { kind: 'reset', end: index }
      if ('()#%+-./=>'.includes(lead)) return { kind: 'ignore', end: Math.min(index + 1, chars.length - 1) }
      return { kind: 'ignore', end: index }
    }

    /** East Asian wide code point test (the ranges xterm treats as two cells). */
    function isWide(code) {
      return (
        (code >= 0x1100 && code <= 0x115f) ||
        (code >= 0x2e80 && code <= 0x303e) ||
        (code >= 0x3041 && code <= 0x33ff) ||
        (code >= 0x3400 && code <= 0x4dbf) ||
        (code >= 0x4e00 && code <= 0x9fff) ||
        (code >= 0xa000 && code <= 0xa4cf) ||
        (code >= 0xac00 && code <= 0xd7a3) ||
        (code >= 0xf900 && code <= 0xfaff) ||
        (code >= 0xfe10 && code <= 0xfe19) ||
        (code >= 0xfe30 && code <= 0xfe6f) ||
        (code >= 0xff00 && code <= 0xff60) ||
        (code >= 0xffe0 && code <= 0xffe6) ||
        (code >= 0x1f300 && code <= 0x1f64f) ||
        (code >= 0x1f900 && code <= 0x1f9ff) ||
        (code >= 0x20000 && code <= 0x2fffd) ||
        (code >= 0x30000 && code <= 0x3fffd)
      )
    }

    /** Combining-mark test: a mark joins the previous cell instead of advancing. */
    function isCombining(code) {
      return (
        (code >= 0x0300 && code <= 0x036f) ||
        (code >= 0x0483 && code <= 0x0489) ||
        (code >= 0x0591 && code <= 0x05bd) ||
        (code >= 0x0610 && code <= 0x061a) ||
        (code >= 0x064b && code <= 0x065f) ||
        (code >= 0x0670 && code <= 0x0670) ||
        (code >= 0x06d6 && code <= 0x06ed) ||
        (code >= 0x1ab0 && code <= 0x1aff) ||
        (code >= 0x1dc0 && code <= 0x1dff) ||
        (code >= 0x20d0 && code <= 0x20ff) ||
        (code >= 0xfe20 && code <= 0xfe2f) ||
        (code >= 0x1f3fb && code <= 0x1f3ff) ||
        (code >= 0xe0100 && code <= 0xe01ef)
      )
    }

    /**
     * Render one line's cells into text-and-style runs.
     * @param cells - cell array; missing cells are default spaces.
     * @returns array of `{ text, style }` runs.
     */
    function lineToRuns(cells) {
      let end = cells.length
      while (end > 0) {
        const cell = cells[end - 1]
        if (cell === null || cell === undefined) {
          end -= 1
          continue
        }
        if (cell.text === ' ' && cell.sgr === DEFAULT_SGR) {
          end -= 1
          continue
        }
        break
      }
      const runs = []
      let current = undefined
      let currentKey = undefined
      for (let index = 0; index < end; index += 1) {
        const cell = cells[index]
        const sgr = cell === null || cell === undefined ? DEFAULT_SGR : cell.sgr
        const text = cell === null || cell === undefined ? ' ' : cell.text
        if (cell !== null && cell !== undefined && cell.wide === true && text === '') continue
        const key = sgrKey(sgr)
        if (current !== undefined && key === currentKey) {
          current.text += text
        } else {
          current = { text, style: styleOfSgr(sgr) }
          currentKey = key
          runs.push(current)
        }
      }
      return runs
    }

    /**
     * One line's plain text, preserving leading spaces and trimming only the
     * trailing default blanks.
     * @param cells - cell array.
     * @returns plain text.
     */
    function lineToText(cells) {
      let text = ''
      for (const cell of cells) {
        if (cell === null || cell === undefined) text += ' '
        else if (cell.wide === true && cell.text === '') continue
        else text += cell.text
      }
      return text.replace(/ +$/u, '')
    }

    /**
     * Parse job output as a terminal would: SGR styles, CR overwrite, tabs,
     * backspace, erase-line/display, and basic cursor movement. The result is
     * capped for the DOM while `plain` keeps every retained line for copy.
     * @param input - raw output text.
     * @returns `{ lines, plain, lineCount, shown, truncated }`.
     */
    function parseTerminal(input) {
      const source = typeof input === 'string' ? input : ''
      const chars = Array.from(source)
      let lines = [[]]
      let row = 0
      let col = 0
      let sgr = DEFAULT_SGR
      let saved = null
      let dropped = 0
      let truncated = false

      const ensureRow = (target) => {
        while (lines.length <= target) lines.push([])
      }
      const ensureCell = (targetRow, targetCol) => {
        ensureRow(targetRow)
        const line = lines[targetRow]
        while (line.length <= targetCol) line.push(null)
      }
      const put = (text, width) => {
        ensureCell(row, col + width - 1)
        lines[row][col] = { text, sgr }
        if (width === 2) lines[row][col + 1] = { text: '', sgr, wide: true }
        col += width
      }
      const blankHere = (count) => {
        ensureCell(row, col + count - 1)
        for (let offset = 0; offset < count; offset += 1) lines[row][col + offset] = { text: ' ', sgr }
      }
      const trimScan = () => {
        if (lines.length <= SCAN_LINE_CAP) return
        const cut = lines.length - SCAN_LINE_CAP
        lines = lines.slice(cut)
        row = Math.max(0, row - cut)
        dropped += cut
        truncated = true
      }
      const pushLine = () => {
        row += 1
        ensureRow(row)
        trimScan()
      }
      const eraseLine = (mode) => {
        ensureRow(row)
        const line = lines[row]
        if (mode === 0) {
          line.length = Math.min(line.length, col)
        } else if (mode === 1) {
          ensureCell(row, col)
          for (let index = 0; index <= col; index += 1) line[index] = { text: ' ', sgr }
        } else {
          line.length = 0
        }
      }
      const eraseDisplay = (mode) => {
        if (mode === 2 || mode === 3) {
          lines = [[]]
          row = 0
          col = 0
          dropped = 0
          truncated = false
          return
        }
        if (mode === 0) {
          const line = lines[row] ?? []
          line.length = Math.min(line.length, col)
          lines.length = row + 1
          return
        }
        for (let index = 0; index < row; index += 1) lines[index] = []
        ensureCell(row, col)
        const line = lines[row]
        for (let index = 0; index <= col; index += 1) line[index] = { text: ' ', sgr }
      }
      const insertLines = (count) => {
        ensureRow(row)
        const blanks = Array.from({ length: count }, () => [])
        lines.splice(row, 0, ...blanks)
        trimScan()
      }
      const deleteLines = (count) => {
        ensureRow(row)
        lines.splice(row, count)
        if (lines.length === 0) lines = [[]]
      }
      const deleteChars = (count) => {
        ensureRow(row)
        const line = lines[row]
        if (col < line.length) line.splice(col, count)
      }
      const insertChars = (count) => {
        ensureCell(row, col + count - 1)
        const line = lines[row]
        line.splice(col, 0, ...Array.from({ length: count }, () => ({ text: ' ', sgr })))
      }
      const scrollLines = (count, down) => {
        const blanks = Array.from({ length: count }, () => [])
        if (down) {
          lines = [...blanks, ...lines]
          row = Math.min(lines.length - 1, row + count)
        } else {
          lines = [...lines.slice(count), ...blanks]
        }
      }

      const applyCsi = (sequence) => {
        const params = csiParams(sequence.raw)
        const amount = (index) => Math.max(1, params[index] || 1)
        switch (sequence.final) {
          case 'm':
            sgr = applySgr(sgr, params)
            break
          case 'A':
            row = Math.max(0, row - amount(0))
            break
          case 'B':
            row += amount(0)
            ensureRow(row)
            break
          case 'C':
            col += amount(0)
            break
          case 'D':
            col = Math.max(0, col - amount(0))
            break
          case 'E':
            row += amount(0)
            col = 0
            ensureRow(row)
            break
          case 'F':
            row = Math.max(0, row - amount(0))
            col = 0
            break
          case 'G':
            col = Math.max(0, amount(0) - 1)
            break
          case 'H':
          case 'f':
            row = Math.max(0, (params[0] || 1) - 1)
            col = Math.max(0, (params[1] || 1) - 1)
            ensureRow(row)
            break
          case 'd':
            row = Math.max(0, (params[0] || 1) - 1)
            ensureRow(row)
            break
          case 'J':
            eraseDisplay(params[0] || 0)
            break
          case 'K':
            eraseLine(params[0] || 0)
            break
          case 'L':
            insertLines(amount(0))
            break
          case 'M':
            deleteLines(amount(0))
            break
          case 'P':
            deleteChars(amount(0))
            break
          case 'X':
            blankHere(amount(0))
            break
          case '@':
            insertChars(amount(0))
            break
          case 'S':
            scrollLines(amount(0), false)
            break
          case 'T':
            scrollLines(amount(0), true)
            break
          case 's':
            saved = { row, col, sgr }
            break
          case 'u':
            if (saved !== null) {
              row = saved.row
              col = saved.col
              sgr = saved.sgr
              ensureRow(row)
            }
            break
          default:
            break
        }
      }

      for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index]
        if (char === '\u001b') {
          const sequence = escapeAt(chars, index)
          index = sequence.end
          if (sequence.kind === 'csi') applyCsi(sequence)
          else if (sequence.kind === 'save') saved = { row, col, sgr }
          else if (sequence.kind === 'restore' && saved !== null) {
            row = saved.row
            col = saved.col
            sgr = saved.sgr
            ensureRow(row)
          } else if (sequence.kind === 'reset') {
            lines = [[]]
            row = 0
            col = 0
            sgr = DEFAULT_SGR
            dropped = 0
            truncated = false
          }
          continue
        }
        if (char === '\n') {
          pushLine()
          col = 0
          continue
        }
        if (char === '\r') {
          col = 0
          continue
        }
        if (char === '\b') {
          if (col > 0) col -= 1
          continue
        }
        if (char === '\t') {
          const stop = col + (8 - (col % 8))
          while (col < stop) {
            put(' ', 1)
          }
          continue
        }
        const code = char.codePointAt(0)
        if (code < 0x20 || code === 0x7f) continue
        if (char === '\ufeff') continue
        if (isCombining(code) && col > 0) {
          const line = lines[row]
          let previous = col - 1
          while (previous >= 0 && line[previous] !== undefined && line[previous].wide === true) previous -= 1
          if (previous >= 0 && line[previous] !== undefined) {
            line[previous] = { ...line[previous], text: line[previous].text + char }
          }
          continue
        }
        put(char, isWide(code) ? 2 : 1)
      }

      const allLines = lines
      const start = Math.max(0, allLines.length - RENDER_LINE_CAP)
      const visible = allLines.slice(start)
      const rendered = visible.map((cells) => lineToRuns(cells))
      const plain = allLines.map((cells) => lineToText(cells)).join('\n')
      return {
        lines: rendered,
        plain,
        lineCount: allLines.length,
        shown: rendered.length,
        truncated: truncated || start > 0,
        droppedLines: dropped + start,
      }
    }

    // ── formatting ──────────────────────────────────────────────────────────
    /**
     * Human-readable byte count with a stable unit suffix.
     * @param bytes - byte count.
     * @returns e.g. `812 B`, `12.4 KB`, `3.1 MB`.
     */
    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return '---'
      if (bytes < 1024) return `${Math.round(bytes)} B`
      const units = ['KB', 'MB', 'GB']
      let value = bytes / 1024
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      const digits = value >= 100 ? 0 : 1
      return `${value.toFixed(digits)} ${units[unit]}`
    }

    /**
     * Compact elapsed time in the active locale.
     * @param ms - elapsed milliseconds.
     * @param t - locale seat.
     * @returns e.g. `4.2秒`, `1分05秒`, `1时02分`.
     */
    function formatDuration(ms, t) {
      const safe = typeof ms === 'number' && Number.isFinite(ms) ? Math.max(0, ms) : 0
      const tenths = Math.round(safe / 100) / 10
      if (tenths < 60) return t('duration.seconds', { seconds: tenths.toFixed(1) })
      const whole = Math.round(tenths)
      if (whole < 3600) {
        return t('duration.minutes', {
          minutes: Math.floor(whole / 60),
          seconds: String(whole % 60).padStart(2, '0'),
        })
      }
      return t('duration.hours', {
        hours: Math.floor(whole / 3600),
        minutes: String(Math.floor(whole / 60) % 60).padStart(2, '0'),
      })
    }

    /** Whether a job is still live (running or stopping). */
    function isLive(job) {
      return job !== undefined && job !== null && LIVE_STATUSES.has(job.status)
    }

    /** Normalize a job status to one of the dictionary keys. */
    function statusName(status) {
      return status === 'running' || status === 'stopping' || status === 'completed' || status === 'killed' || status === 'failed'
        ? status
        : 'unknown'
    }

    /** Localized status label. */
    function statusLabel(status, t) {
      return t(`status.${statusName(status)}`)
    }

    /** Dot color state used by CSS. */
    function dotState(status) {
      if (status === 'running') return 'running'
      if (status === 'stopping') return 'stopping'
      if (status === 'failed') return 'failed'
      if (status === 'completed') return 'completed'
      return 'idle'
    }

    /**
     * Order jobs: live work first by start time, settled work after, newest
     * finish first.
     * @param jobs - roster rows.
     * @returns a new ordered array.
     */
    function orderJobs(jobs) {
      const live = []
      const settled = []
      for (const job of jobs) (isLive(job) ? live : settled).push(job)
      live.sort((left, right) => left.startedAt - right.startedAt)
      settled.sort((left, right) => (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt))
      return [...live, ...settled]
    }

    /**
     * Session select rows sorted newest activity first.
     * @param snapshot - the Client sessions list snapshot.
     * @returns `{ id, title, running, updatedAt }` rows.
     */
    function sessionChoices(snapshot) {
      const rows = []
      if (snapshot === undefined || snapshot === null) return rows
      for (const id of snapshot.ids ?? []) {
        const row = snapshot.byId?.[id]
        if (row === undefined) continue
        rows.push({
          id,
          title: row.displayTitle ?? row.title ?? id,
          running: row.running === true,
          updatedAt: row.updatedAt ?? 0,
        })
      }
      rows.sort((left, right) => right.updatedAt - left.updatedAt)
      return rows
    }

    /** Copy plain text, preferring the async clipboard with a legacy fallback. */
    async function copyPlainText(text) {
      if (typeof text !== 'string' || text.length === 0) return false
      try {
        if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        // Fall through to the textarea path.
      }
      try {
        const area = document.createElement('textarea')
        area.value = text
        area.setAttribute('readonly', '')
        area.style.position = 'fixed'
        area.style.top = '0'
        area.style.left = '0'
        area.style.opacity = '0'
        document.body.appendChild(area)
        area.select()
        const copied = document.execCommand('copy')
        area.remove()
        return copied
      } catch {
        return false
      }
    }

    /** Read the remembered fallback Session id from browser storage. */
    function readLastSession() {
      try {
        const value = typeof localStorage === 'undefined' ? null : localStorage.getItem(LAST_SESSION_KEY)
        return typeof value === 'string' && value !== '' ? value : undefined
      } catch {
        return undefined
      }
    }

    /** Remember the last active Session id without making storage a dependency. */
    function writeLastSession(sessionId) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(LAST_SESSION_KEY, sessionId)
      } catch {
        // Storage failures only lose the fallback.
      }
    }

    /** The terminal font stack, with the user's configured family first. */
    function terminalFontFamily(configured) {
      const fallback = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace'
      return typeof configured === 'string' && configured.trim() !== '' ? `${configured}, ${fallback}` : fallback
    }

    /** UTF-8 byte length of a text, using TextEncoder when available. */
    function byteLengthOf(text) {
      if (typeof text !== 'string' || text.length === 0) return 0
      if (typeof TextEncoder === 'function') return new TextEncoder().encode(text).length
      let bytes = 0
      for (const character of text) {
        const code = character.codePointAt(0)
        bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4
      }
      return bytes
    }

    // ── stores and small hooks ─────────────────────────────────────────────
    /**
     * Subscribe a component to one external snapshot store.
     * @param store - `{ getSnapshot, subscribe }`.
     * @returns the current snapshot.
     */
    function useStore(store) {
      return React.useSyncExternalStore(
        React.useCallback((listener) => store.subscribe(listener), [store]),
        React.useCallback(() => store.getSnapshot(), [store]),
        React.useCallback(() => store.getSnapshot(), [store]),
      )
    }

    /**
     * Create a theme snapshot store over the `theme/change` event.
     * @param ctx - Client plugin context.
     * @returns store with `getSnapshot`, `subscribe`, and `dispose`.
     */
    function createThemeStore(ctx) {
      let snapshot = ctx.theme.getTheme()
      const listeners = new Set()
      const off = ctx.on('theme/change', (next) => {
        snapshot = next
        for (const listener of listeners) listener()
      })
      return {
        getSnapshot: () => snapshot,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        dispose: () => {
          off()
        },
      }
    }

    // ── glyphs ─────────────────────────────────────────────────────────────
    /** The sidebar / empty-state terminal glyph, drawn at the requested size. */
    function JobsIcon({ size }) {
      const dimension = typeof size === 'number' && Number.isFinite(size) ? size : 18
      return h(
        'svg',
        {
          width: dimension,
          height: dimension,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': 'true',
          focusable: 'false',
          style: { display: 'block' },
        },
        h('rect', { x: 2.9, y: 4.4, width: 18.2, height: 15.2, rx: 3.6, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M6.6 9.2 9.4 12l-2.8 2.8',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M11.2 14.8h5.6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
        h('circle', { cx: 17.9, cy: 8.3, r: 1.15, fill: 'currentColor' }),
      )
    }

    /** A filled stop square for the two-press stop control. */
    function StopGlyph({ size }) {
      const dimension = typeof size === 'number' && Number.isFinite(size) ? size : 10
      return h(
        'svg',
        { width: dimension, height: dimension, viewBox: '0 0 10 10', 'aria-hidden': 'true', focusable: 'false' },
        h('rect', { x: 1, y: 1, width: 8, height: 8, rx: 1.7, fill: 'currentColor' }),
      )
    }

    /** A left chevron for the back-to-chat control. */
    function BackGlyph() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
        h('path', {
          d: 'M9.9 3.2 5.1 8l4.8 4.8',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    // ── components ─────────────────────────────────────────────────────────
    /**
     * One status dot with the job state as its data attribute.
     * @returns the dot span.
     */
    function StatusDot({ status }) {
      return h('span', { className: 'dshjt_dot', 'data-state': dotState(status), 'aria-hidden': 'true' })
    }

    /**
     * One job row with the two-press stop control; the stop button's box never
     * changes size between idle, armed, pending, and failed states.
     */
    function JobRow({ job, selected, now, t, onSelect, killPhase, onKillPress }) {
      const live = isLive(job)
      const key = String(job.id)
      const phase = killPhase.key === key ? killPhase.state : 'idle'
      const armed = phase === 'armed'
      const pending = phase === 'pending'
      const failed = phase === 'failed'
      const started = typeof job.startedAt === 'number' ? job.startedAt : now
      const finished = typeof job.finishedAt === 'number' ? job.finishedAt : started
      const durationMs = live ? Math.max(0, now - started) : Math.max(0, finished - started)
      const duration = formatDuration(durationMs, t)
      const label = typeof job.label === 'string' && job.label !== '' ? job.label : String(job.id)
      const stopLabel = armed ? t('kill.confirmAria', { label }) : t('kill.stop', { label })
      const title = live ? t('duration.liveTitle', { duration }) : t('duration.doneTitle', { duration })
      return h(
        'div',
        { className: selected ? 'dshjt_rowLine dshjt_rowSelected' : 'dshjt_rowLine' },
        h(
          'button',
          {
            type: 'button',
            className: 'dshjt_row',
            'aria-pressed': selected,
            title: label,
            onClick: () => onSelect(job),
          },
          h(
            'span',
            { className: 'dshjt_rowTop' },
            h(StatusDot, { status: job.status }),
            h('span', { className: 'dshjt_rowLabel', title: label }, label),
            h('span', { className: 'dshjt_duration', title }, duration),
          ),
          h(
            'span',
            { className: 'dshjt_rowMeta' },
            h('span', { className: 'dshjt_kind', title: job.kind }, job.kind ?? 'job'),
            h('span', { className: 'dshjt_status', 'data-state': dotState(job.status) }, statusLabel(job.status, t)),
            typeof job.progress === 'string' && job.progress !== ''
              ? h('span', { className: 'dshjt_progress', title: job.progress, 'aria-label': t('job.progressAria') }, job.progress)
              : null,
          ),
        ),
        live
          ? h(
              'button',
              {
                type: 'button',
                className: 'dshjt_stop',
                'data-kill-state': pending ? 'pending' : armed ? 'armed' : failed ? 'failed' : 'idle',
                disabled: pending,
                'aria-label': stopLabel,
                title: stopLabel,
                onClick: (event) => {
                  event.stopPropagation()
                  onKillPress(job)
                },
              },
              h(StopGlyph, { size: 10 }),
            )
          : null,
      )
    }

    /**
     * One roster section (running or finished) with a fixed-width count slot.
     */
    function JobSection({ title, count, children }) {
      return h(
        'section',
        { className: 'dshjt_section' },
        h(
          'div',
          { className: 'dshjt_sectionHead' },
          h('span', { className: 'dshjt_sectionTitle' }, title),
          h('span', { className: 'dshjt_sectionCount' }, String(count)),
        ),
        h('div', { className: 'dshjt_sectionRows' }, children),
      )
    }

    /**
     * The live terminal surface: parsed lines, notices, sticky auto-follow, and
     * a bottom bar with the follow/jump controls.
     */
    function TerminalSurface({ parsed, observed, job, t, font }) {
      const scrollRef = React.useRef(null)
      const stickRef = React.useRef(true)
      const [stick, setStick] = React.useState(true)
      const hasText = parsed !== undefined && parsed.lines.length > 0 && (observed?.text ?? '') !== ''
      const streaming = observed?.streaming === true
      const liveJob = isLive(job)

      const scrollToEnd = React.useCallback(() => {
        const element = scrollRef.current
        if (element !== null) element.scrollTop = element.scrollHeight
      }, [])

      React.useLayoutEffect(() => {
        if (!stickRef.current) return
        scrollToEnd()
      }, [parsed, scrollToEnd])

      const onScroll = React.useCallback(() => {
        const element = scrollRef.current
        if (element === null) return
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_THRESHOLD
        if (atBottom === stickRef.current) return
        stickRef.current = atBottom
        setStick(atBottom)
      }, [])

      const toggleFollow = () => {
        const next = !stickRef.current
        stickRef.current = next
        setStick(next)
        if (next) scrollToEnd()
      }

      const notices = []
      if (observed?.gapBefore === true) {
        notices.push(h('div', { key: 'gap', className: 'dshjt_notice' }, t('output.gap')))
      }
      if (parsed?.truncated === true) {
        notices.push(h('div', { key: 'truncated', className: 'dshjt_notice' }, t('output.truncated', { count: parsed.shown })))
      }
      if (typeof observed?.error === 'string' && observed.error !== '') {
        notices.push(h('div', { key: 'error', className: 'dshjt_notice dshjt_noticeError' }, t('output.error', { error: observed.error })))
      }

      let empty = null
      if (!hasText && (observed?.error === undefined || observed.error === '')) {
        const waiting = job !== undefined && (streaming || (observed === undefined && liveJob))
        const message = job === undefined ? t('output.noJob') : waiting ? t('output.waiting') : t('output.none')
        empty = h(
          'div',
          { className: 'dshjt_terminalEmpty' },
          waiting
            ? h('span', { className: 'dshjt_waitDot', 'aria-hidden': 'true' })
            : job === undefined
              ? null
              : h('span', { className: 'dshjt_waitMark', 'aria-hidden': 'true' }),
          h('span', null, message),
        )
      }

      const renderedLines = parsed?.lines ?? []
      const lines = renderedLines.length > 0 ? renderedLines : [[]]
      const lineNodes = lines.map((runs, index) =>
        h(
          'div',
          { className: 'dshjt_line', key: index },
          runs.map((run, runIndex) => h('span', { key: runIndex, style: run.style }, run.text)),
          streaming && index === lines.length - 1
            ? h('span', { key: 'caret', className: 'dshjt_caret', 'aria-hidden': 'true' }, ' ')
            : null,
        ),
      )

      const received = React.useMemo(() => byteLengthOf(observed?.text ?? ''), [observed?.text])
      const receivedText = formatBytes(received)
      const receivedTitle = t('output.loadedAria', { size: receivedText })
      return h(
        'div',
        { className: 'dshjt_terminalWrap' },
        h(
          'div',
          {
            className: 'dshjt_terminal',
            ref: scrollRef,
            role: 'log',
            tabIndex: 0,
            'aria-live': 'off',
            'aria-label': t('output.aria'),
            onScroll,
            style: font,
          },
          notices,
          lineNodes,
          empty,
        ),
        h(
          'div',
          { className: 'dshjt_termFoot' },
          h('span', { className: 'dshjt_termHint', title: t('output.hint') }, t('output.hint')),
          h('span', { className: 'dshjt_termStats' },
            h('span', { className: 'dshjt_termStatLabel' }, t('output.loaded')),
            h('span', { className: 'dshjt_size dshjt_received', title: receivedTitle }, receivedText),
            h(
              'button',
              {
                type: 'button',
                className: 'dshjt_follow',
                'aria-pressed': stick,
                'aria-label': t('output.followAria'),
                title: t('output.followAria'),
                onClick: toggleFollow,
              },
              stick ? t('output.follow') : t('output.paused'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshjt_jump',
                style: stick ? { visibility: 'hidden' } : undefined,
                'aria-label': t('output.jumpAria'),
                title: t('output.jumpAria'),
                onClick: () => {
                  stickRef.current = true
                  setStick(true)
                  scrollToEnd()
                },
              },
              t('output.jump'),
            ),
          ),
        ),
      )
    }

    /**
     * The main page: Session picker, job roster, and the selected job's live
     * terminal. It is a global panel, so it reads the current Session from the
     * UI Session adapter and keeps a remembered fallback.
     */
    function JobsPanel(props) {
      const {
        jobsState,
        watchRows,
        observe,
        killJob,
        uiSessionState,
        sessionsState,
        themeState,
        lastSession,
        backToConversation,
        t,
      } = props
      const jobsSnapshot = useStore(jobsState)
      const uiSession = useStore(uiSessionState)
      const sessions = useStore(sessionsState)
      const theme = useStore(themeState)
      const [picked, setPicked] = React.useState(undefined)
      const [selection, setSelection] = React.useState({ sessionId: undefined, jobId: undefined })
      const [killPhase, setKillPhase] = React.useState(IDLE_KILL)
      const [now, setNow] = React.useState(() => Date.now())
      const [copied, setCopied] = React.useState('idle')
      const copyTimer = React.useRef(undefined)

      const choices = React.useMemo(() => sessionChoices(sessions), [sessions])
      const currentId = uiSession?.key
      const pickedId = picked !== undefined && picked.atCurrent === currentId && choices.some((choice) => choice.id === picked.id) ? picked.id : undefined
      const fallbackId = lastSession.id !== undefined && choices.some((choice) => choice.id === lastSession.id) ? lastSession.id : undefined
      const sessionId = pickedId ?? currentId ?? fallbackId ?? choices[0]?.id
      const sessionRow = sessionId === undefined ? undefined : sessions?.byId?.[sessionId]

      const jobs = React.useMemo(() => {
        if (sessionId === undefined) return []
        return jobsSnapshot.rows[String(sessionId)] ?? []
      }, [jobsSnapshot.rows, sessionId])
      const ordered = React.useMemo(() => orderJobs(jobs), [jobs])
      const liveJobs = React.useMemo(() => ordered.filter(isLive), [ordered])
      const settledJobs = React.useMemo(() => ordered.filter((job) => !isLive(job)), [ordered])
      const liveCount = liveJobs.length
      const settledCount = settledJobs.length
      const anyLive = liveCount > 0
      const selectedJobId = selection.sessionId === sessionId ? selection.jobId : undefined
      const selectedJob = React.useMemo(
        () => (selectedJobId === undefined ? undefined : ordered.find((job) => String(job.id) === selectedJobId)),
        [ordered, selectedJobId],
      )
      const observed = selectedJobId === undefined ? undefined : jobsSnapshot.observed[selectedJobId]
      const parsed = React.useMemo(() => parseTerminal(observed?.text ?? ''), [observed?.text])
      const hasText = (observed?.text ?? '') !== ''

      // Watch the roster while this Session is on screen; the Client jobs
      // service reference-counts the stream and resumes whole after a reconnect.
      React.useEffect(() => {
        if (sessionId === undefined) return undefined
        return watchRows(sessionId)
      }, [sessionId, watchRows])

      // Keep one ticker while live rows exist; elapsed labels update in place
      // inside fixed-width slots.
      React.useEffect(() => {
        if (!anyLive) return undefined
        setNow(Date.now())
        const timer = setInterval(() => {
          setNow(Date.now())
        }, 1000)
        return () => {
          clearInterval(timer)
        }
      }, [anyLive])

      // Stop observing a job once it leaves the roster or another job is
      // selected; the service drops its accumulated view after the last release.
      React.useEffect(() => {
        if (sessionId === undefined || selectedJobId === undefined) return undefined
        return observe(sessionId, selectedJobId)
      }, [sessionId, selectedJobId, observe])

      // Keep a valid selection: default to the first live job, otherwise the
      // first settled one; never leave a removed job selected.
      React.useEffect(() => {
        if (sessionId === undefined || ordered.length === 0) {
          if (selectedJobId !== undefined) setSelection({ sessionId: undefined, jobId: undefined })
          return
        }
        const present = selectedJobId !== undefined && ordered.some((job) => String(job.id) === selectedJobId)
        if (present) return
        const first = ordered.find(isLive) ?? ordered[0]
        setSelection({ sessionId, jobId: String(first.id) })
      }, [sessionId, ordered, selectedJobId])

      // Disarm a kill confirmation after its window; a failed hint clears too.
      React.useEffect(() => {
        if (killPhase.state !== 'armed' && killPhase.state !== 'failed') return undefined
        const delay = killPhase.state === 'armed' ? KILL_ARM_MS : KILL_FAILED_MS
        const timer = setTimeout(() => {
          setKillPhase((current) => (current.key === killPhase.key && current.state === killPhase.state ? IDLE_KILL : current))
        }, delay)
        return () => {
          clearTimeout(timer)
        }
      }, [killPhase])

      React.useEffect(() => () => {
        if (copyTimer.current !== undefined) clearTimeout(copyTimer.current)
      }, [])

      const onSelectJob = (job) => {
        if (sessionId === undefined) return
        setSelection({ sessionId, jobId: String(job.id) })
        setKillPhase(IDLE_KILL)
      }

      const onPickSession = (next) => {
        if (next === '') return
        setPicked({ atCurrent: currentId, id: next })
        setSelection({ sessionId: undefined, jobId: undefined })
        setKillPhase(IDLE_KILL)
      }

      const onKillPress = (job) => {
        if (sessionId === undefined) return
        const key = String(job.id)
        if (killPhase.key === key && killPhase.state === 'armed') {
          setKillPhase({ key, state: 'pending' })
          Promise.resolve()
            .then(() => killJob(sessionId, job.id))
            .then(
              (result) => {
                if (result !== undefined && result.ok === true) {
                  setKillPhase(IDLE_KILL)
                  return
                }
                setKillPhase({ key, state: 'failed' })
              },
              () => {
                setKillPhase({ key, state: 'failed' })
              },
            )
          return
        }
        setKillPhase({ key, state: 'armed' })
      }

      const copyOutput = () => {
        if (!hasText) return
        copyPlainText(parsed.plain).then((ok) => {
          if (copyTimer.current !== undefined) clearTimeout(copyTimer.current)
          setCopied(ok ? 'copied' : 'failed')
          copyTimer.current = setTimeout(() => {
            setCopied('idle')
          }, COPY_FEEDBACK_MS)
        })
      }

      const font = {
        fontSize: `${theme?.fontSizes?.terminal ?? 13}px`,
        fontFamily: terminalFontFamily(theme?.fontFamilies?.terminal),
      }

      const killHint =
        killPhase.state === 'armed'
          ? t('kill.confirm')
          : killPhase.state === 'failed'
            ? t('kill.failed')
            : killPhase.state === 'pending'
              ? t('kill.pending')
              : t('kill.idleHint')

      const sessionOptions = (() => {
        const rows = choices
        if (sessionId === undefined || choices.some((choice) => choice.id === sessionId)) return rows
        return [
          { id: sessionId, title: sessionRow?.displayTitle ?? sessionId, running: sessionRow?.running === true },
          ...rows,
        ]
      })()

      const header = h(
        'header',
        { className: 'dshjt_head' },
        h(
          'div',
          { className: 'dshjt_headMain' },
          h(
            'div',
            { className: 'dshjt_titleRow' },
            h('h1', { className: 'dshjt_title' }, t('panel.title')),
            h(
              'div',
              { className: 'dshjt_stats', role: 'status' },
              h('span', { className: 'dshjt_stat' },
                h('span', { className: 'dshjt_statLabel' }, t('header.live')),
                h('span', { className: 'dshjt_num' }, String(liveCount))),
              h('span', { className: 'dshjt_sep', 'aria-hidden': 'true' }, '·'),
              h('span', { className: 'dshjt_stat' },
                h('span', { className: 'dshjt_statLabel' }, t('header.settled')),
                h('span', { className: 'dshjt_num' }, String(settledCount))),
            ),
          ),
          h('p', { className: 'dshjt_subtitle' }, t('panel.subtitle')),
        ),
        h(
          'div',
          { className: 'dshjt_headActions' },
          h(
            'label',
            { className: 'dshjt_sessionPick' },
            h('span', { className: 'dshjt_sessionLabel' }, t('session.label')),
            h(
              'select',
              {
                className: 'dshjt_select',
                value: sessionId ?? '',
                style: { colorScheme: theme?.active?.colorScheme === 'dark' ? 'dark' : 'light' },
                'aria-label': t('session.aria'),
                onChange: (event) => onPickSession(event.target.value),
              },
              sessionOptions.length === 0
                ? h('option', { value: '' }, t('session.none'))
                : sessionOptions.map((choice) =>
                    h('option', { key: choice.id, value: choice.id }, `${choice.running ? '● ' : ''}${choice.title}`),
                  ),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dshjt_back',
              'aria-label': t('header.backAria'),
              title: t('header.back'),
              onClick: backToConversation,
            },
            h(BackGlyph, null),
            h('span', null, t('header.back')),
          ),
        ),
      )

      let body = null
      if (ordered.length === 0) {
        const noSession = sessionId === undefined
        body = h(
          'div',
          { className: 'dshjt_emptyPane' },
          h(
            'div',
            { className: 'dshjt_emptyCard' },
            h('span', { className: 'dshjt_emptyIcon' }, h(JobsIcon, { size: 30 })),
            h('h2', { className: 'dshjt_emptyTitle' }, t(noSession ? 'job.noSession' : 'job.empty')),
            h('p', { className: 'dshjt_emptyText' }, t(noSession ? 'job.noSessionHint' : 'job.emptyHint')),
          ),
        )
      } else {
        const copyLabel = copied === 'copied' ? t('output.copied') : copied === 'failed' ? t('output.copyFailed') : t('output.copy')
        body = h(
          'div',
          { className: 'dshjt_split' },
          h(
            'aside',
            { className: 'dshjt_listPane' },
            h(
              'div',
              { className: 'dshjt_listScroll' },
              liveJobs.length > 0
                ? h(JobSection, { title: t('section.live'), count: liveCount },
                    liveJobs.map((job) =>
                      h(JobRow, {
                        key: String(job.id),
                        job,
                        selected: String(job.id) === selectedJobId,
                        now,
                        t,
                        onSelect: onSelectJob,
                        killPhase,
                        onKillPress,
                      }),
                    ))
                : null,
              settledJobs.length > 0
                ? h(JobSection, { title: t('section.settled'), count: settledCount },
                    settledJobs.map((job) =>
                      h(JobRow, {
                        key: String(job.id),
                        job,
                        selected: String(job.id) === selectedJobId,
                        now,
                        t,
                        onSelect: onSelectJob,
                        killPhase,
                        onKillPress,
                      }),
                    ))
                : null,
            ),
            h('div', { className: 'dshjt_listFoot', role: 'status' }, killHint),
          ),
          h(
            'section',
            { className: 'dshjt_outputPane' },
            h(
              'div',
              { className: 'dshjt_outHead' },
              h(
                'div',
                { className: 'dshjt_outTitleWrap' },
                h('div', { className: 'dshjt_outTitle', title: selectedJob?.label }, selectedJob?.label ?? t('output.title')),
                h(
                  'div',
                  { className: 'dshjt_outMeta' },
                  selectedJob === undefined
                    ? t('output.noJob')
                    : [
                        h('span', { key: 'kind', className: 'dshjt_outKind', title: selectedJob.kind }, selectedJob.kind ?? 'job'),
                        h('span', { key: 'status', className: 'dshjt_statusChip', 'data-state': dotState(selectedJob.status) }, statusLabel(selectedJob.status, t)),
                        typeof selectedJob.detail === 'string' && selectedJob.detail !== ''
                          ? h('span', { key: 'detail', className: 'dshjt_outDetail', title: selectedJob.detail }, selectedJob.detail)
                          : null,
                        typeof selectedJob.progress === 'string' && selectedJob.progress !== ''
                          ? h('span', { key: 'progress', className: 'dshjt_outProgress', title: selectedJob.progress }, selectedJob.progress)
                          : null,
                      ],
                ),
              ),
              h(
                'div',
                { className: 'dshjt_outActions' },
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dshjt_action',
                    'aria-label': t('output.copyAria'),
                    title: t('output.copyAria'),
                    disabled: !hasText,
                    onClick: copyOutput,
                  },
                  copyLabel,
                ),
              ),
            ),
            h(TerminalSurface, {
              key: `${String(sessionId)}:${String(selectedJobId)}`,
              parsed,
              observed,
              job: selectedJob,
              t,
              font,
            }),
          ),
        )
      }

      return h('div', { className: 'dshjt_page', 'data-job-terminal': true }, header, body)
    }

    /** Error boundary: one broken render must not blank the whole slot entry. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: undefined }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[job-terminal] panel render failed:', error)
      }

      render() {
        if (this.state.error === undefined) return this.props.children
        const t = typeof this.props.t === 'function' ? this.props.t : (key) => key
        const message = this.state.error instanceof Error ? this.state.error.message : String(this.state.error)
        return h(
          'div',
          { className: 'dshjt_page dshjt_errorPage' },
          h(
            'div',
            { className: 'dshjt_emptyCard' },
            h('h2', { className: 'dshjt_emptyTitle' }, t('error.title')),
            h('p', { className: 'dshjt_emptyText' }, t('error.hint', { message })),
          ),
        )
      }
    }

    /** Registered page: wraps the real panel so a render bug stays contained. */
    function JobsPanelEntry(props) {
      return h(PanelBoundary, { t: props.t }, h(JobsPanel, props))
    }

    // ── styles ─────────────────────────────────────────────────────────────
    const CSS = [
      '.dshjt_page{box-sizing:border-box;height:100%;min-height:0;width:100%;display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.6}',
      '.dshjt_page *{box-sizing:border-box}',
      '.dshjt_head{flex:none;display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;padding:26px 32px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '[data-platform=darwin] .dshjt_head{padding-top:calc(26px + var(--dsh-frame-top-clearance,0px))}',
      '.dshjt_headMain{min-width:0;display:flex;flex-direction:column;gap:4px}',
      '.dshjt_titleRow{display:flex;align-items:baseline;gap:16px;flex-wrap:wrap;min-width:0}',
      '.dshjt_title{margin:0;font-size:20px;font-weight:500;line-height:28px;min-width:0}',
      '.dshjt_subtitle{margin:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px}',
      '.dshjt_stats{display:inline-flex;align-items:baseline;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dshjt_stat{display:inline-flex;align-items:baseline;gap:4px}',
      '.dshjt_statLabel{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dshjt_num{display:inline-block;min-width:2ch;text-align:right;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary)}',
      '.dshjt_sep{opacity:.6}',
      '.dshjt_headActions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.dshjt_sessionPick{display:inline-flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-secondary);font-size:12px;white-space:nowrap}',
      '.dshjt_sessionLabel{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dshjt_select{height:30px;min-width:150px;max-width:260px;padding:0 26px 0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:28px;text-overflow:ellipsis;cursor:pointer}',
      '.dshjt_select:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.dshjt_select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshjt_back{height:30px;display:inline-flex;align-items:center;gap:4px;padding:0 9px;border:1px solid transparent;border-radius:8px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;white-space:nowrap}',
      '.dshjt_back:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
      '.dshjt_back:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshjt_split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(250px,340px) minmax(0,1fr);overflow:hidden}',
      '.dshjt_listPane{min-height:0;min-width:0;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1)}',
      '.dshjt_listScroll{flex:1;min-height:0;overflow:auto;padding:10px 8px}',
      '.dshjt_listFoot{flex:none;border-top:1px solid var(--dsw-alias-border-l1);padding:8px 12px;min-height:34px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dshjt_section{display:flex;flex-direction:column;gap:2px}',
      '.dshjt_section+.dshjt_section{margin-top:12px}',
      '.dshjt_sectionHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:6px 8px 4px;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;letter-spacing:.02em}',
      '.dshjt_sectionTitle{text-transform:uppercase}',
      '.dshjt_sectionCount{display:inline-block;min-width:2ch;text-align:right;font-variant-numeric:tabular-nums}',
      '.dshjt_sectionRows{display:flex;flex-direction:column;gap:2px}',
      '.dshjt_rowLine{position:relative;display:flex;align-items:flex-start;gap:4px;border-radius:10px}',
      '.dshjt_rowLine:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.dshjt_rowSelected,.dshjt_rowSelected:hover{background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 1px var(--dsw-alias-border-l2)}',
      '.dshjt_row{flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;padding:8px 10px;border:0;border-radius:10px;background:0 0;color:inherit;font:inherit;text-align:left;cursor:pointer}',
      '.dshjt_row:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}',
      '.dshjt_rowTop{display:flex;align-items:center;gap:7px;min-width:0}',
      '.dshjt_dot{flex:none;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-idle-primary)}',
      '.dshjt_dot[data-state=running]{background:var(--dsw-alias-brand-primary);animation:dshjt-pulse 1.4s ease-in-out infinite}',
      '.dshjt_dot[data-state=stopping]{background:var(--dsw-alias-state-warn-primary)}',
      '.dshjt_dot[data-state=completed]{background:var(--dsw-alias-state-success-primary)}',
      '.dshjt_dot[data-state=failed]{background:var(--dsw-alias-state-error-primary)}',
      '.dshjt_dot[data-state=idle]{background:var(--dsw-alias-state-idle-primary)}',
      '.dshjt_rowLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px}',
      '.dshjt_duration{flex:none;display:inline-block;min-width:7ch;text-align:right;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dshjt_rowMeta{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden}',
      '.dshjt_kind{flex:none;max-width:11ch;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:10px;line-height:15px;padding:0 5px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px}',
      '.dshjt_status{flex:none;width:9.5ch;overflow:hidden;text-overflow:ellipsis;text-align:left}',
      '.dshjt_status[data-state=running]{color:var(--dsw-alias-brand-primary)}',
      '.dshjt_status[data-state=stopping]{color:var(--dsw-alias-state-warn-primary)}',
      '.dshjt_status[data-state=completed]{color:var(--dsw-alias-state-success-primary)}',
      '.dshjt_status[data-state=failed]{color:var(--dsw-alias-state-error-primary)}',
      '.dshjt_size{flex:none;display:inline-block;min-width:8ch;text-align:right;font-variant-numeric:tabular-nums}',
      '.dshjt_progress{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.dshjt_stop{flex:none;width:26px;height:26px;margin:7px 6px 0 0;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:0 0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));cursor:pointer}',
      '.dshjt_stop:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dshjt_stop:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshjt_stop[data-kill-state=armed]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);animation:dshjt-armed 1s ease-in-out infinite}',
      '.dshjt_stop[data-kill-state=pending]{opacity:.5;cursor:default}',
      '.dshjt_stop[data-kill-state=failed]{color:var(--dsw-alias-state-error-primary)}',
      '.dshjt_outputPane{min-height:0;min-width:0;display:flex;flex-direction:column}',
      '.dshjt_outHead{flex:none;display:flex;align-items:flex-start;justify-content:space-between;gap:12px;padding:12px 20px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);min-height:58px}',
      '.dshjt_outTitleWrap{min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.dshjt_outTitle{font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}',
      '.dshjt_outMeta{display:flex;align-items:center;gap:8px;min-width:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px;white-space:nowrap;overflow:hidden;flex-wrap:wrap}',
      '.dshjt_outKind{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--dsw-alias-label-secondary)}',
      '.dshjt_statusChip{flex:none;display:inline-block;min-width:5.6em;text-align:center;padding:0 6px;border:1px solid var(--dsw-alias-border-l2);border-radius:5px;font-size:10px;line-height:15px;color:var(--dsw-alias-label-secondary)}',
      '.dshjt_statusChip[data-state=running]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.dshjt_statusChip[data-state=stopping]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.dshjt_statusChip[data-state=completed]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary)}',
      '.dshjt_statusChip[data-state=failed]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dshjt_outDetail,.dshjt_outProgress{min-width:0;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}',
      '.dshjt_outActions{flex:none;display:flex;align-items:center;gap:6px}',
      '.dshjt_action{height:26px;min-width:96px;padding:0 9px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:24px;cursor:pointer;white-space:nowrap}',
      '.dshjt_action:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
      '.dshjt_action:disabled{opacity:.45;cursor:default}',
      '.dshjt_action:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshjt_terminalWrap{flex:1;min-height:0;display:flex;flex-direction:column;padding:10px 0 0}',
      '.dshjt_terminal{flex:1;min-height:0;overflow:auto;padding:8px 20px 14px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);line-height:1.5;font-variant-ligatures:none;white-space:pre-wrap;overflow-wrap:anywhere;word-break:break-word;tab-size:8}',
      '.dshjt_terminal::-webkit-scrollbar{width:10px}',
      '.dshjt_line{min-height:1.5em;white-space:pre-wrap;overflow-wrap:anywhere}',
      '.dshjt_caret{display:inline-block;width:.58em;height:1.05em;margin-left:1px;vertical-align:-.14em;background:var(--dsw-alias-label-secondary);opacity:.8;animation:dshjt-blink 1s step-end infinite}',
      '.dshjt_notice{margin:0 0 8px;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:7px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family,inherit);font-size:11px;line-height:16px;white-space:pre-wrap}',
      '.dshjt_noticeError{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dshjt_terminalEmpty{display:flex;align-items:center;gap:8px;padding:10px 0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px;font-style:normal}',
      '.dshjt_waitMark{width:12px;height:1.2em;display:inline-block;background:var(--dsw-alias-label-secondary);opacity:.5;vertical-align:-.15em}',
      '.dshjt_waitDot{width:7px;height:7px;border-radius:50%;display:inline-block;background:var(--dsw-alias-brand-primary);animation:dshjt-pulse 1.4s ease-in-out infinite}',
      '.dshjt_termFoot{flex:none;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:6px 20px;border-top:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:11px;line-height:16px}',
      '.dshjt_termHint{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dshjt_termStats{display:inline-flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:flex-end}',
      '.dshjt_termStatLabel{color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary))}',
      '.dshjt_received{color:var(--dsw-alias-label-secondary);min-width:8ch}',
      '.dshjt_follow{height:24px;min-width:76px;padding:0 8px;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:0 0;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}',
      '.dshjt_follow[aria-pressed=false]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}',
      '.dshjt_follow:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
      '.dshjt_follow:focus-visible,.dshjt_jump:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.dshjt_jump{height:24px;min-width:72px;padding:0 8px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:0 0;color:var(--dsw-alias-brand-primary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}',
      '.dshjt_jump:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.dshjt_emptyPane{flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:32px;overflow:auto}',
      '.dshjt_emptyCard{max-width:420px;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center;padding:28px 24px;border:1px solid var(--dsw-alias-border-l1);border-radius:16px;background:var(--dsw-alias-bg-layer-1)}',
      '.dshjt_emptyIcon{display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:14px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.dshjt_emptyTitle{margin:0;font-size:15px;line-height:22px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dshjt_emptyText{margin:0;color:var(--dsw-alias-label-tertiary,var(--dsw-alias-label-secondary));font-size:12px;line-height:18px;overflow-wrap:anywhere}',
      '.dshjt_errorPage{align-items:center;justify-content:center;padding:32px;overflow:auto}',
      '.dshjt_errorPage .dshjt_emptyCard{max-width:520px}',
      '@keyframes dshjt-pulse{0%,100%{opacity:.35}50%{opacity:1}}',
      '@keyframes dshjt-blink{0%,49%{opacity:.8}50%,100%{opacity:0}}',
      '@keyframes dshjt-armed{0%,100%{opacity:1}50%{opacity:.55}}',
      '@media (max-width:900px){.dshjt_split{grid-template-columns:minmax(220px,300px) minmax(0,1fr)}.dshjt_head{padding:20px 20px 14px}.dshjt_outHead{padding:10px 14px}.dshjt_terminal{padding:8px 14px 12px}.dshjt_termFoot{padding:6px 14px}}',
      '@media (max-width:720px){.dshjt_split{grid-template-columns:1fr;grid-template-rows:minmax(120px,38%) minmax(0,1fr)}.dshjt_listPane{border-right:0;border-bottom:1px solid var(--dsw-alias-border-l1)}.dshjt_subtitle{display:none}.dshjt_headActions{width:100%;justify-content:flex-start}}',
      '@media (prefers-reduced-motion:reduce){.dshjt_dot[data-state=running],.dshjt_waitDot,.dshjt_caret,.dshjt_stop[data-kill-state=armed]{animation:none}}',
    ].join('')

    /** Insert the panel stylesheet once per Client generation. */
    function installStyles(ctx) {
      ctx.effect(() => {
        if (typeof document === 'undefined') return () => {}
        const tagId = ID + '/job-terminal.css'
        const selector = 'style[data-plugin-css=' + JSON.stringify(tagId) + ']'
        if (document.querySelector(selector) !== null) return () => {}
        const tag = document.createElement('style')
        tag.dataset.plugin = ID
        tag.dataset.pluginCss = tagId
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => {
          tag.remove()
        }
      }, ID + ': styles')
    }

    // ── plugin body ─────────────────────────────────────────────────────────
    const inject = ['slots', 'locale', 'jobs', 'uiSession', 'sessions', 'theme', 'layout']

    /**
     * Register the sidebar entry and the main panel it opens. The panel owns no
     * Host resource: every read and control goes through the Client `jobs`
     * service, which reference-counts its streams per viewer.
     * @param ctx - Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), ID + ': dictionaries')
      installStyles(ctx)

      const t = ctx.locale.bind(NS)
      const lastSession = { id: readLastSession() }

      let themeStore
      ctx.effect(() => {
        themeStore = createThemeStore(ctx)
        return () => {
          themeStore.dispose()
          themeStore = undefined
        }
      }, ID + ': theme store')

      ctx.effect(() => {
        const current = ctx.uiSession.adapter.current
        const sync = () => {
          const key = current.getSnapshot().key
          if (key !== undefined && key !== lastSession.id) {
            lastSession.id = key
            writeLastSession(key)
          }
        }
        const off = current.subscribe(sync)
        sync()
        return () => {
          off()
        }
      }, ID + ': last session')

      ctx.effect(() => ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({
          jobsState: ctx.jobs.state,
          watchRows: (sessionId) => ctx.jobs.watchRows(sessionId),
          observe: (sessionId, jobId) => ctx.jobs.observe(sessionId, jobId),
          killJob: (sessionId, jobId) => ctx.jobs.kill(sessionId, jobId),
          uiSessionState: ctx.uiSession.adapter.current,
          sessionsState: ctx.sessions.list,
          themeState: themeStore,
          lastSession,
          backToConversation: () => ctx.layout.selectPanel(null),
        }),
      }, JobsPanelEntry)), ID + ': main panel')

      ctx.effect(() => ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 5,
        locale: NS,
        label: () => t('panel.title'),
      }, JobsIcon)), ID + ': sidebar entry')

      // Read-only diagnostic provider: its presence proves the Client half
      // activated, and it reports the registrations this plugin made. The
      // model reaches it through `cordis_inspect_query` (Client provider
      // `JobTerminal`, method `status`); it can never change runtime state.
      ctx.inject(['cordisInspect'], (scope) => {
        scope.effect(() => scope.cordisInspect.register({
          manifest: {
            id: 'JobTerminal',
            description: 'Live background-jobs sidebar status: panel registration, remembered Session, and client activation.',
            methods: [{
              name: 'status',
              description: 'Report that this Client plugin is active and which seats it registered.',
              inputSchema: { type: 'object', properties: {}, additionalProperties: false },
              outputSchema: { description: 'JSON data owned by this inspect provider.' },
            }],
          },
          query(method) {
            if (method !== 'status') throw new Error(`unknown JobTerminal inspect method "${method}"`)
            let sidebarEntry = false
            let mainPanel = false
            try {
              const slots = ctx.get('slots')
              sidebarEntry = (slots?.entries?.('sidebar.panellist') ?? []).some((entry) => entry.options?.id === PANEL_ID)
              mainPanel = (slots?.entries?.('main') ?? []).some((entry) => entry.options?.key === PANEL_ID)
            } catch {
              // The status report stays useful even when the slot registry is mid-teardown.
            }
            let currentSession = null
            try {
              currentSession = ctx.uiSession?.adapter?.current?.getSnapshot?.().key ?? null
            } catch {
              // A disconnected page may not have a Session binding yet.
            }
            let activePanel = null
            try {
              activePanel = ctx.layout?.panelInfo?.getSnapshot?.().activePanelId ?? null
            } catch {
              // The layout store is absent only during teardown.
            }
            let watchedSessions = 0
            try {
              watchedSessions = Object.keys(ctx.jobs?.state?.getSnapshot?.().rows ?? {}).length
            } catch {
              // Job state is optional for this report.
            }
            return {
              active: true,
              panelId: PANEL_ID,
              lastSession: lastSession.id ?? null,
              currentSession,
              activePanel,
              sidebarEntry,
              mainPanel,
              watchedSessions,
              localeNamespace: NS,
            }
          },
        }), ID + ': inspect provider')
      })
    }

    return {
      inject,
      apply,
      __internals: {
        parseTerminal,
        applySgr,
        paletteColor,
        styleOfSgr,
        formatBytes,
        formatDuration,
        byteLengthOf,
        orderJobs,
        sessionChoices,
        isLive,
        statusName,
        statusLabel,
        dotState,
        terminalFontFamily,
        ANSI_PALETTE,
        DEFAULT_SGR,
        copy: { zh, en },
      },
    }
  },
})
