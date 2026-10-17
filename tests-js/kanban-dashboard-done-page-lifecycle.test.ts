import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { describe, expect, it, vi } from 'vitest'

// Drives the REAL kanban dashboard component (the plain-IIFE plugin bundle)
// through a minimal dependency-aware React-hooks shim — the tests-js suite is
// node-only (no jsdom/React), so this harness renders the component by
// invoking it and running its effects manually. No vdom is diffed; the tests
// observe behavior through the props the component hands to its children
// (BoardColumns receives the merged board + paging state + move callbacks)
// and through the network calls it makes.
//
// Pinned here (Gate-B round 2 findings on PR #3):
// - moving/deleting a card that only lives in a loaded done page must also
//   remove it from the held extra pages (no ghost after refresh), and
// - a "Load more" response that lands after a board/filter scope switch must
//   be discarded, never appended to the new scope's extra pages.

const PLUGIN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../plugins/kanban/dashboard/dist/index.js',
)

type VNode = { type: { name?: string } | string | null; props: Record<string, any>; children: unknown[] }

const doneTask = (id: string, completedAt: number | null) => ({
  id,
  status: 'done',
  title: `task ${id}`,
  completed_at: completedAt,
  tenant: 'infra',
})

const openTask = (id: string) => ({
  id,
  status: 'todo',
  title: `task ${id}`,
  completed_at: null,
  tenant: 'infra',
})

// --- React-hooks shim (single component instance, dep-aware) ----------------

function createHooksRuntime() {
  const slots = new Map<number, any>()
  let hookIndex = 0
  let effectList: Array<{ fn: any; deps: any[] | undefined }> = []
  let committed: Array<{ deps?: any[]; cleanup: any }> = []
  let dirty = false

  const sameDeps = (a: any[] | undefined, b: any[] | undefined): boolean => {
    if (a === undefined || b === undefined) { return false }

    if (a.length !== b.length) { return false }

    return a.every((v, i) => v === b[i])
  }

  const React: any = {
    createElement: (type: any, props: any, ...children: any[]): VNode =>
      ({ type, props: props || {}, children }),
    Component: class {},
    useState(initial: any): [any, (u: any) => void] {
      const i = hookIndex++

      if (!slots.has(i)) { slots.set(i, { v: typeof initial === 'function' ? initial() : initial }) }
      const slot = slots.get(i)

      return [slot.v, (update: any) => {
        slot.v = typeof update === 'function' ? update(slot.v) : update
        dirty = true
      }]
    },
    useRef(initial: any) {
      const i = hookIndex++

      if (!slots.has(i)) { slots.set(i, { v: { current: initial } }) }

      return slots.get(i).v
    },
    useCallback(fn: any, deps?: any[]) {
      const i = hookIndex++
      const prev = slots.get(i)

      if (!prev || !sameDeps(prev.deps, deps)) { slots.set(i, { v: fn, deps }) }

      return slots.get(i).v
    },
    useMemo(fn: any, deps?: any[]) {
      const i = hookIndex++
      const prev = slots.get(i)

      if (!prev || !sameDeps(prev.deps, deps)) { slots.set(i, { v: fn(), deps }) }

      return slots.get(i).v
    },
    useEffect(fn: any, deps?: any[]) {
      effectList.push({ fn, deps })
    },
  }

  return {
    React,
    hooks: {
      useState: React.useState,
      useEffect: React.useEffect,
      useCallback: React.useCallback,
      useMemo: React.useMemo,
      useRef: React.useRef,
    },
    beginRender() {
      hookIndex = 0
      effectList = []
    },
    takeDirty(): boolean {
      const was = dirty
      dirty = false

      return was
    },
    runEffectsPass() {
      const nextCommitted: Array<{ deps?: any[]; cleanup: any }> = []

      for (let i = 0; i < effectList.length; i++) {
        const entry = effectList[i]
        const prev = committed[i]

        if (!prev || !sameDeps(prev.deps, entry.deps)) {
          if (prev && typeof prev.cleanup === 'function') { prev.cleanup() }
          nextCommitted.push({ deps: entry.deps, cleanup: entry.fn() })
        } else {
          nextCommitted.push(prev)
        }
      }

      for (let i = effectList.length; i < committed.length; i++) {
        if (committed[i] && typeof committed[i].cleanup === 'function') { committed[i].cleanup() }
      }

      committed = nextCommitted
    },
    unmount() {
      for (const c of committed) {
        if (c && typeof c.cleanup === 'function') { c.cleanup() }
      }

      committed = []
    },
  }
}

// --- stateful fixture server -------------------------------------------------
//
// Emulates plugin_api.get_board faithfully enough for these tests: the done
// column is served in windows (fixture limit = 1) sorted newest-completed-
// first, mutations (PATCH/bulk/DELETE) change server truth, and every /board
// read reflects that truth. done_offset requests can be deferred: the payload
// is built at REQUEST time (a real server would compute it then) and handed
// to the test, which releases it later — the honest shape of the race.

function createServer(extraTasks: any[] = []) {
  const tasks = new Map<string, any>([
    ['t1', openTask('t1')],
    ['d1', doneTask('d1', 300)],
    ['d2', doneTask('d2', 200)], // lives on done page 2 (limit-1 window)
    ...extraTasks.map((t) => [t.id, t] as [string, any]),
  ])

  // DELETE ids that fail (partial-failure emulation for bulk delete).
  const deleteFailures = new Set<string>()

  // Bulk/PATCH ids whose WRITE fails (failed-move restore emulation): the
  // mutation does NOT apply server-side for these ids — done membership is
  // kept — and the response reports ok:false (bulk) / rejects (PATCH).
  const writeFailures = new Set<string>()

  const LIMIT = 1
  // Drift tests need a WIDER first-page window than the ghost tests: the
  // gap scenario requires a multi-card first page that a new completion can
  // shift cards out of. Defaults to the ghost tests' 1-card window.
  let doneLimit = LIMIT

  // Tenant emulation for the stale-scope-refresh tests: a real /board read
  // with ?tenant= filters the WHOLE board to that tenant's cards.
  const tasksByTenant = (list: any[], tenant: string) =>
    tenant ? list.filter((t) => t.tenant === tenant) : list

  const doneSorted = (tenant = ''): any[] =>
    tasksByTenant([...tasks.values()].filter((t) => t.status === 'done'), tenant)
      .sort((a, b) => {
        const aOpen = a.completed_at == null
        const bOpen = b.completed_at == null

        if (aOpen !== bOpen) { return aOpen ? 1 : -1 }

        if (!aOpen && a.completed_at !== b.completed_at) { return b.completed_at - a.completed_at }

        return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0)
      })

  const serveBoard = (offset: number, tenant = '') => {
    const limit = Math.max(1, doneLimit)
    const done = doneSorted(tenant)
    const window = done.slice(offset, offset + limit)

    return {
      columns: [
        { name: 'triage', tasks: [] },
        { name: 'todo', tasks: tasksByTenant([...tasks.values()].filter((t) => t.status === 'todo'), tenant) },
        { name: 'ready', tasks: [] },
        { name: 'running', tasks: [] },
        { name: 'blocked', tasks: [] },
        { name: 'review', tasks: [] },
        { name: 'done', tasks: window },
      ],
      tenants: ['infra'],
      assignees: [],
      latest_event_id: 1,
      done_pagination: { total: done.length, offset, limit },
    }
  }

  // Deferred done_offset responses: built at request time, released by the test.
  const deferred: Array<{ url: string; payload: any; resolve: (data: any) => void }> = []

  const route = (url: string, opts: any): Promise<any> => {
    if (url.includes('/config')) { return Promise.resolve({ render_markdown: true }) }

    if (url.includes('/boards')) {
      return Promise.resolve({
        boards: [{ slug: 'default', name: 'Default' }, { slug: 'board-b', name: 'B' }],
        current: 'default',
      })
    }

    const qs = new URLSearchParams(url.split('?')[1] || '')

    if (url.includes('/board') && qs.has('done_offset')) {
      const offset = Number(qs.get('done_offset') || 0)
      const payload = serveBoard(offset, qs.get('tenant') || '')

      if (!deferredEnabled()) { return Promise.resolve(payload) }

      return new Promise((resolve) => { deferred.push({ url, payload, resolve }) })
    }

    if (url.includes('/board')) {
      // First-page reads can be deferred too: the response is built at REQUEST
      // time (pre-mutation server truth) and released by the test later —
      // pins down the stale-/board-read race.
      const payload = serveBoard(0, qs.get('tenant') || '')

      if (!boardReadDeferEnabled()) { return Promise.resolve(payload) }

      return new Promise((resolve) => { deferred.push({ url, payload, resolve }) })
    }

    if (url.includes('/tasks/bulk')) {
      const body = JSON.parse((opts && opts.body) || '{}')

      for (const id of body.ids || []) {
        if (writeFailures.has(id)) { continue }

        const t = tasks.get(id)

        if (t && body.status) { t.status = body.status }

        if (t && body.archive) { t.status = 'archived' }
      }

      const result = (): any => ({
        results: (body.ids || []).map((id: string) => writeFailures.has(id)
          ? { id, ok: false, error: `write failed: ${id}` }
          : { id, ok: true }),
      })

      if (deferredWritesEnabled()) {
        return new Promise((resolve) => { deferred.push({ url, payload: result(), resolve }) })
      }

      return Promise.resolve(result())
    }

    const patchMatch = url.match(/\/tasks\/([^/?]+)/)

    // Task detail (drawer load): GET /tasks/<id>
    if (patchMatch && (!opts || !opts.method)) {
      const t = tasks.get(decodeURIComponent(patchMatch[1]))

      return Promise.resolve({
        task: t ? { ...t } : null,
        comments: [],
        events: [],
        attachments: [],
        links: { parents: [], children: [] },
        child_results: [],
      })
    }

    // Reclaim / reassign flip the task's status to ready (server truth).
    if (patchMatch && opts && opts.method === 'POST'
      && (url.includes('/reclaim') || url.includes('/reassign'))) {
      const t = tasks.get(decodeURIComponent(patchMatch[1]))

      if (t) { t.status = 'ready' }

      return Promise.resolve({})
    }

    if (patchMatch && opts && opts.method === 'PATCH') {
      const id = decodeURIComponent(patchMatch[1])

      if (writeFailures.has(id)) {
        // A failing write can be PARKED too: the test holds the rejection in
        // flight so a WS event can land inside the write window (the restore
        // guard race — a same-scope gate reset between dispatch and failure).
        if (deferredWritesEnabled()) {
          return new Promise((_resolve, reject) => {
            deferred.push({ url, payload: null, resolve: () => { reject(new Error(`patch failed: ${id}`)) } })
          })
        }

        return Promise.reject(new Error(`patch failed: ${id}`))
      }

      const t = tasks.get(id)
      const body = JSON.parse((opts && opts.body) || '{}')

      if (t && body.status) { t.status = body.status }

      if (deferredWritesEnabled()) {
        return new Promise((resolve) => { deferred.push({ url, payload: {}, resolve }) })
      }

      return Promise.resolve({})
    }

    if (patchMatch && opts && opts.method === 'DELETE') {
      const id = decodeURIComponent(patchMatch[1])

      if (deleteFailures.has(id)) { return Promise.reject(new Error(`delete failed: ${id}`)) }

      if (deferDeleteMode) {
        // Deferred deletes apply server-side at RELEASE time: the fixture's
        // task map is shared across boards, so keeping the deleted task in
        // the map until release lets the same id keep living on the OTHER
        // board — exactly the cross-board id collision under test (ids are
        // only unique within one board's kanban_db file).
        return new Promise((resolve) => {
          deferred.push({ url, payload: {}, resolve: () => { tasks.delete(id); resolve({}) } })
        })
      }

      tasks.delete(id)

      return Promise.resolve({})
    }

    return Promise.resolve({})
  }

  let deferMode = false
  const deferredEnabled = () => deferMode
  let deferWriteMode = false
  const deferredWritesEnabled = () => deferWriteMode
  let deferBoardReadMode = false
  const boardReadDeferEnabled = () => deferBoardReadMode
  let deferDeleteMode = false

  return {
    route,
    setDeferLoadMore(v: boolean) { deferMode = v },
    // Parks WRITE responses (PATCH/bulk) like setDeferLoadMore parks pages:
    // the test holds a membership write in flight to pin down the pre-commit
    // window of the optimistic move paths.
    setDeferWrites(v: boolean) { deferWriteMode = v },
    // Parks FIRST-PAGE /board reads (built at request time): the test holds a
    // read in flight across a membership mutation — the stale-overwrite race.
    setDeferBoardReads(v: boolean) { deferBoardReadMode = v },
    // Parks DELETE responses (applied server-side at release time): the test
    // holds a delete in flight across a board switch — the cross-board
    // id-collision race.
    setDeleteFailures(ids: string[]) { for (const id of ids) { deleteFailures.add(id) } },
    setDeferDeletes(v: boolean) { deferDeleteMode = v },
    // Marks bulk/PATCH ids whose WRITE fails (mutation not applied, ok:false /
    // rejection) — drives the failed-move restore paths.
    setWriteFailures(ids: string[]) { for (const id of ids) { writeFailures.add(id) } },
    releaseDeferred(filter: string): number {
      let n = 0

      for (const d of deferred.splice(0)) {
        if (d.url.includes(filter)) { d.resolve(d.payload); n++ }
      }

      return n
    },
    // Releases exactly the OLDEST parked response (FIFO) — lets a test
    // resolve a specific in-flight request without releasing later ones.
    releaseFirstDeferred(): number {
      const d = deferred.shift()

      if (!d) { return 0 }

      d.resolve(d.payload)

      return 1
    },
    serverDoneIds(): string[] { return doneSorted().map((t) => t.id) },
    setTaskStatus(id: string, status: string) {
      const t = tasks.get(id)

      if (t) { t.status = status }
    },
    deleteTask(id: string) { tasks.delete(id) },
    // Drift tests: a wider first-page window than the ghost tests' 1-card
    // limit — the gap scenario needs a multi-card first page.
    setDoneLimit(n: number) { doneLimit = n },
    // A FOREIGN client completes a card (kanban_db.complete_task appends
    // `completed`): it enters the done list at the TOP (newest completed_at).
    completeTask(id: string, completedAt: number) {
      const t = tasks.get(id)

      if (t) { t.status = 'done'; t.completed_at = completedAt }
    },
  }
}

// --- harness ----------------------------------------------------------------

function walk(node: unknown, visit: (n: VNode) => void): void {
  if (!node || typeof node !== 'object') { return }

  if (Array.isArray(node)) {
    for (const child of node) { walk(child, visit) }

    return
  }

  const n = node as VNode

  if (!('type' in n) || !('props' in n)) { return }
  visit(n)
  walk(n.children, visit)
}

// Shared browser/window stub: one SDK + globals per harness instance. Every
// harness evaluates the real plugin IIFE against its OWN window/hooks runtime,
// so each mounted component gets an isolated hook-slot space (the same trick
// real React plays per root).
// opts.ws: install a WebSocket stub and let buildWsUrl resolve — lets a test
// drive the plugin's real ws.onmessage handler (captured instances are
// returned via the mount handle).
// opts.deferFirstWsUrl: the FIRST buildWsUrl call returns a manually-resolvable
// deferred (mount.releaseFirstWsUrl) — lets a test park a URL-build
// continuation across a scope switch.
function createWindow(runtime: ReturnType<typeof createHooksRuntime>, server: ReturnType<typeof createServer>, calls: Array<{ url: string; opts: any }>, opts: { ws?: boolean; deferFirstWsUrl?: boolean } = {}) {
  const wsInstances: Array<Record<string, any>> = []
  const pendingWsUrls: Array<(url: string) => void> = []
  let wsUrlCalls = 0

  if (opts.ws) {
    class FakeWebSocket {
      url: string
      onopen: (() => void) | null = null
      onmessage: ((ev: { data: string }) => void) | null = null
      onclose: ((ev: { code?: number }) => void) | null = null

      constructor(url: string) {
        this.url = url
        wsInstances.push(this)
      }

      close() { /* noop */ }
    }

    ;(globalThis as unknown as { WebSocket: unknown }).WebSocket = FakeWebSocket
  }

  const win: Record<string, unknown> = {
    __HERMES_PLUGIN_SDK__: {
      React: runtime.React,
      components: {
        Card: () => null,
        CardContent: () => null,
        Badge: () => null,
        Button: () => null,
        Input: () => null,
        Label: () => null,
        Select: () => null,
        SelectOption: () => null,
      },
      hooks: runtime.hooks,
      utils: { cn: () => '', timeAgo: () => '' },
      fetchJSON: (url: string, opts?: any) => {
        calls.push({ url, opts })

        return server.route(url, opts)
      },
      // Never settles: no WebSocket loop in tests (unless opts.ws).
      buildWsUrl: opts.ws
        ? () => {
            wsUrlCalls += 1

            if (opts.deferFirstWsUrl && wsUrlCalls === 1) {
              return new Promise<string>((resolve) => { pendingWsUrls.push(resolve) })
            }

            return Promise.resolve('ws://test/events')
          }
        : () => new Promise(() => {}),
    },
    __HERMES_PLUGINS__: {
      register: (name: string, page: any) => { /* per-harness capture not needed here */ },
    },
    __HERMES_KANBAN_TEST__: true,
    localStorage: {
      getItem: () => null,
      setItem: () => { /* ignore */ },
      removeItem: () => { /* ignore */ },
    },
    // TaskDrawer registers an Escape-key listener on mount.
    addEventListener: () => {},
    removeEventListener: () => {},
    // Completion-summary carve-out (production uses window.prompt for the
    // "move to done" summary); tests that drive a move INTO done stub it.
    prompt: () => 'completion summary from test',
    alert: () => {},
  }

  ;(globalThis as unknown as { window: unknown }).window = win

  return {
    win,
    wsInstances,
    releaseFirstWsUrl: () => {
      const resolvers = pendingWsUrls.splice(0)

      for (const r of resolvers) { r('ws://test/events') }
    },
  }
}

function evalPlugin(): void {
  vm.runInThisContext(readFileSync(PLUGIN_PATH, 'utf8'), { filename: PLUGIN_PATH })
}

function mount(server: ReturnType<typeof createServer>, opts: { ws?: boolean; deferFirstWsUrl?: boolean } = {}) {
  const runtime = createHooksRuntime()
  const registered: Array<[string, any]> = []
  const calls: Array<{ url: string; opts: any }> = []

  const { win, wsInstances, releaseFirstWsUrl } = createWindow(runtime, server, calls, opts) as { win: Record<string, any>; wsInstances: Array<Record<string, any>>; releaseFirstWsUrl: () => void }
  win.__HERMES_PLUGINS__ = {
    register: (name: string, page: any) => { registered.push([name, page]) },
  }

  evalPlugin()

  const KanbanPage = registered[0][1]

  let tree: VNode | null = null

  const render = () => {
    runtime.beginRender()
    tree = KanbanPage() as unknown as VNode
  }

  render()

  const tick = () => new Promise((r) => setImmediate(r))

  const flush = async (rounds = 30): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      await tick()

      if (runtime.takeDirty()) { render() }
      runtime.runEffectsPass()
    }
  }

  const findProps = (componentName: string): Record<string, any> => {
    let found: Record<string, any> | null = null
    walk(tree, (n) => {
      if (!found && typeof n.type === 'function' && n.type.name === componentName) { found = n.props }
    })

    if (!found) { throw new Error(`${componentName} element not found in rendered tree`) }

    return found
  }

  const nodeWithProp = (prop: string): Record<string, any> => {
    let found: Record<string, any> | null = null
    walk(tree, (n) => {
      if (!found && n.props && typeof n.props[prop] === 'function') { found = n.props }
    })

    if (!found) { throw new Error(`no node with prop ${prop}`) }

    return found
  }

  const doneIds = (): string[] => {
    const board = findProps('BoardColumns').board
    const col = (board.columns as any[]).find((c) => c.name === 'done')

    return ((col && col.tasks) as any[]).map((t) => t.id)
  }

  const todoIds = (): string[] => {
    const board = findProps('BoardColumns').board
    const col = (board.columns as any[]).find((c) => c.name === 'todo')

    return ((col && col.tasks) as any[]).map((t) => t.id)
  }

  const donePaging = (): { total: number; loaded: number; hasMore: boolean } => findProps('BoardColumns').donePaging

  const callsTo = (fragment: string) => calls.filter((c) => c.url.includes(fragment))

  return {
    flush,
    unmount: runtime.unmount,
    boardColumnsProps: () => findProps('BoardColumns'),
    dialogsProps: () => findProps('KanbanDialogs'),
    taskDrawerProps: () => findProps('TaskDrawer'),
    nodeWithProp,
    doneIds,
    todoIds,
    donePaging,
    wsInstances,
    releaseFirstWsUrl,
    calls,
    callsTo,
  }
}

// Harness for the REAL TaskDrawer: mounts the drawer component directly
// (its own hooks runtime + own IIFE evaluation), lets it load its task
// detail, and exposes the drawer's rendered subtree — doPatch itself is
// reachable as TaskDetail's `onPatch` prop, exactly as the drawer wires it.
function mountDrawer(server: ReturnType<typeof createServer>, drawerProps: Record<string, any>) {
  const runtime = createHooksRuntime()
  const calls: Array<{ url: string; opts: any }> = []

  createWindow(runtime, server, calls)
  evalPlugin()

  const TaskDrawer = (globalThis as unknown as { window: Record<string, any> }).window
    .__HERMES_KANBAN_TEST_HELPERS__.TaskDrawer as (props: Record<string, any>) => VNode

  const props = {
    renderMarkdown: () => '',
    allTasks: [],
    assignees: [],
    eventTick: 0,
    onClose: () => {},
    onOpenTask: () => {},
    onRefresh: () => {},
    ...drawerProps,
  }

  let tree: VNode | null = null

  const render = () => {
    runtime.beginRender()
    tree = TaskDrawer(props) as unknown as VNode
  }

  render()

  const tick = () => new Promise((r) => setImmediate(r))

  const flush = async (rounds = 30): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      await tick()

      if (runtime.takeDirty()) { render() }
      runtime.runEffectsPass()
    }
  }

  const detailProps = (): Record<string, any> => {
    let found: Record<string, any> | null = null

    walk(tree, (n) => {
      if (!found && typeof n.type === 'function' && n.type.name === 'TaskDetail') { found = n.props }
    })

    if (!found) { throw new Error('TaskDetail element not found — drawer did not load its task detail') }

    return found
  }

  return { flush, detailProps, calls, callsTo: (fragment: string) => calls.filter((c) => c.url.includes(fragment)) }
}

// Harness for the REAL diagnostics chain: mounts DiagnosticsSection and — in
// the same pass, in stable tree order — invokes its DiagnosticCard children
// (the same invocation order every pass keeps the hook-slot space consistent,
// mirroring how React walks the tree). The action button's real onClick is
// then reachable through the rendered subtree.
function mountDiagSection(server: ReturnType<typeof createServer>, sectionProps: Record<string, any>) {
  const runtime = createHooksRuntime()
  const calls: Array<{ url: string; opts: any }> = []

  createWindow(runtime, server, calls)
  evalPlugin()

  const helpers = (globalThis as unknown as { window: Record<string, any> }).window
    .__HERMES_KANBAN_TEST_HELPERS__

  const props = { task: sectionProps.task, ...sectionProps }

  let tree: VNode | null = null

  const render = () => {
    runtime.beginRender()
    tree = helpers.DiagnosticsSection(props) as unknown as VNode
    // Invoke the real DiagnosticCard elements in stable tree order.
    walk(tree, (n) => {
      if (typeof n.type === 'function' && n.type.name === 'DiagnosticCard') {
        n.children = [(n.type as any)(n.props)]
      }
    })
  }

  render()

  const tick = () => new Promise((r) => setImmediate(r))

  const flush = async (rounds = 30): Promise<void> => {
    for (let i = 0; i < rounds; i++) {
      await tick()

      if (runtime.takeDirty()) { render() }
      runtime.runEffectsPass()
    }
  }

  // Clicks the real action for the given kind: DiagnosticActionButton's
  // onClick is exactly `onExec(action)` — invoked here against the real
  // execAction closure the DiagnosticCard wired in.
  const clickAction = (kind: string): void => {
    let clicked = false

    walk(tree, (n) => {
      if (clicked) { return }

      if (typeof n.type === 'function' && n.type.name === 'DiagnosticActionButton'
        && n.props.action && n.props.action.kind === kind
        && typeof n.props.onExec === 'function') {
        n.props.onExec(n.props.action)
        clicked = true
      }
    })

    if (!clicked) { throw new Error(`no rendered action button for kind ${kind}`) }
  }

  return { flush, clickAction, calls, callsTo: (fragment: string) => calls.filter((c) => c.url.includes(fragment)) }
}

describe('kanban dashboard done-page lifecycle (component harness)', () => {
  it('single move out of done removes the card from the held extra pages (no ghost)', async () => {
    const server = createServer()
    const h = mount(server)
    await h.flush()

    // Load the deeper done page (d2 lives only there).
    expect(h.donePaging()).toEqual({ total: 2, loaded: 1, hasMore: true })
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2']) // merged, server order

    // Move d2 (extra-page card) out of done — non-destructive target.
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    // No ghost: d2 left the merged done column AND optimistically landed in
    // todo (it was pulled from the held extra page into the destination).
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.todoIds()).toContain('d2')
    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    expect(JSON.parse(patch!.opts.body)).toEqual({ status: 'todo' })

    // A later refresh reflects the server truth and stays ghost-free.
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('bulk move out of done removes every moved card from the held extra pages', async () => {
    const server = createServer()
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Select both done cards, bulk-move them to todo.
    h.boardColumnsProps().toggleSelected('d1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('d2', true)
    await h.flush()
    h.boardColumnsProps().onMoveSelected('todo')
    await h.flush()

    // The success path refreshes from the server; both moved cards are gone
    // from done — neither the optimistic state nor a stale extra page
    // resurrects them.
    expect(h.doneIds()).toEqual([])
    expect(h.todoIds()).toEqual(expect.arrayContaining(['d1', 'd2', 't1']))
    const bulk = h.callsTo('/tasks/bulk')[0]
    expect(bulk).toBeTruthy()
    expect(JSON.parse(bulk.opts.body).ids.sort()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('delete of an extra-page card removes it from the held extra pages (no ghost)', async () => {
    const server = createServer()
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Delete d2 through the confirm dialog.
    h.boardColumnsProps().onDelete('d2')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()

    expect(h.doneIds()).toEqual(['d1'])
    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)
    h.unmount()
  })

  it('load-more response that lands after a board switch is discarded, never hung on the new scope', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Start the load-more; its response is built (old scope) but parked.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()

    // Switch boards while the request is in flight.
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()

    // New scope is live and holds only its own done cards.
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.donePaging()).toEqual({ total: 2, loaded: 1, hasMore: true })

    // The stale response lands now — it belongs to the old scope and must
    // NOT be appended to the new scope's freshly cleared extra pages.
    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('load-more response landing after a tenant filter switch is discarded too', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server)
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()

    // Switch the tenant filter while the request is in flight. The fixture
    // tasks carry tenant "infra", so filtering to "infra" keeps them visible
    // while still re-scoping the board (reset effect + gate bump).
    h.nodeWithProp('setTenantFilter').setTenantFilter('infra')
    await h.flush()

    server.releaseDeferred('done_offset')
    await h.flush()
    // Without the gate the stale page-2 card would appear here as a ghost.
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a write that settles after a tenant switch refreshes the NEW scope (no old-scope overwrite)', async () => {
    // x1 lives in another tenant; the unfiltered board shows it, the
    // tenant=infra scope must not.
    const server = createServer([
      { id: 'x1', status: 'todo', title: 'task x1', completed_at: null, tenant: 'acme' },
    ])

    server.setDeferWrites(true)
    const h = mount(server)

    await h.flush()
    expect(h.todoIds()).toEqual(expect.arrayContaining(['t1', 'x1']))

    // Dispatch a single move; its PATCH response is parked in flight.
    h.boardColumnsProps().onMove('d1', 'todo')
    await h.flush()

    // Switch the tenant scope while the write is in flight. The scope effect
    // re-reads the board under the new filter — x1 drops out of view.
    h.nodeWithProp('setTenantFilter').setTenantFilter('infra')
    await h.flush()
    expect(h.todoIds()).not.toContain('x1')

    // The write settles NOW. Its post-commit refresh must re-read the NEW
    // scope (?tenant=infra): the dispatch-time loadBoard closure would
    // rebuild the old (unfiltered) query and — riding the fresh gate token
    // the post-commit invalidation just minted — overwrite the new scope's
    // board with it (x1 would reappear, potentially another tenant's data).
    server.releaseDeferred('/tasks/')
    await h.flush()

    const boardReads = h.callsTo('/board').filter((c) => !c.url.includes('done_offset'))
    const lastRead = boardReads[boardReads.length - 1]
    expect(new URLSearchParams(lastRead.url.split('?')[1] || '').get('tenant')).toBe('infra')
    expect(h.todoIds()).not.toContain('x1')
    h.unmount()
  })

  it('a first-page refresh that shifted the done list fills the gap on the next load-more (no skipped card)', async () => {
    const server = createServer([{ ...doneTask('d3', 100) }, openTask('n0')])
    server.setDoneLimit(2)
    const h = mount(server)
    await h.flush()
    // First page (limit 2): d1, d2 — d3 lives beyond it.
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    expect(h.donePaging()).toEqual({ total: 3, loaded: 2, hasMore: true })

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2', 'd3'])

    // A foreign client completes n0 — it enters done at the TOP and pushes
    // every older card one position down. The next first-page refresh (WS
    // reload / toolbar) re-reads only the first window; the held extras are
    // frozen.
    server.completeTask('n0', 400)
    h.nodeWithProp('onRefresh').onRefresh()
    await h.flush()

    // Fresh first page is [n0, d1]; extras still hold d3. d2 now sits in the
    // gap between them — the held-count offset (3) would request slice[3:] =
    // [d3] (a repeat, silently deduped) and d2 would NEVER load.
    expect(h.doneIds()).toEqual(expect.arrayContaining(['n0', 'd1', 'd3']))
    expect(h.donePaging()).toEqual({ total: 4, loaded: 3, hasMore: true })

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()

    // Drift-corrected offset (consumed 2 + total delta 0) requests
    // slice[2:] = [d2, d3] — the gap card d2 arrives; the d3 repeat is
    // deduped by the merge.
    expect(h.doneIds()).toEqual(['n0', 'd1', 'd2', 'd3'])
    expect(h.donePaging()).toEqual({ total: 4, loaded: 4, hasMore: false })
    h.unmount()
  })

  it('load-more response that lands after a same-scope move is discarded (no ghost)', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Start the load-more; its response is built from the PRE-mutation server
    // state (offset 1 -> [d2]) and parked.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // Same-scope membership mutation while the request is in flight: d2 moves
    // out of done. The mutation must invalidate the in-flight fetch — its
    // parked page was computed before the move and still contains d2.
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    // The invalidation releases the loading lock (the stale request's
    // .finally can no longer release it — its token is stale now).
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    expect(JSON.parse(patch!.opts.body)).toEqual({ status: 'todo' })

    // The stale response lands now — it must NOT be appended: d2 would come
    // back as a ghost into the merged done column. (d2 is not re-shown
    // anywhere until a refresh — the card lived only in the parked response.)
    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    // The post-commit refresh (fresh read under the new generation) shows
    // server truth: d2 legitimately sits in todo after the successful move.
    expect(h.todoIds()).toEqual(['t1', 'd2'])
    h.unmount()
  })

  it('a membership mutation releases the loading lock; the fresh load-more applies, the stale one does not', async () => {
    // Extra seed card: three done cards total, so a deeper page still exists
    // after the mutation deletes one of them.
    const server = createServer([doneTask('d0', 400)])
    server.setDeferLoadMore(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    // First load-more in flight, parked (payload [d1], pre-mutation truth).
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // Same-scope membership mutation while the fetch is in flight: d0 is
    // deleted (confirm dialog). The mutation invalidates the in-flight fetch
    // and releases the lock.
    h.boardColumnsProps().onDelete('d0')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    expect(h.callsTo('/tasks/d0').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)

    // The released lock allows a FRESH load-more (second parked request; the
    // server still holds two done cards, so a deeper page exists).
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // Both responses land: the stale one (pre-mutation, old token) is
    // discarded; the fresh one (current token) applies its page. The fresh
    // request continues at the held offset (1) — its page is [d2], served
    // from post-mutation server truth.
    expect(server.releaseDeferred('done_offset')).toBe(2)
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('drawer status patch of an extra-page card reaches the parent prune hook with the final patch', async () => {
    const server = createServer()
    const patched: Array<[string, any]> = []

    const h = mountDrawer(server, {
      taskId: 'd2',
      boardSlug: 'default',
      onTaskPatched: (taskId: string, patch: any) => { patched.push([taskId, patch]) },
    })

    await h.flush()

    // The drawer loaded its detail; doPatch is reachable as TaskDetail's
    // onPatch prop — exactly how StatusActions/TaskDetail call it.
    const detail = h.detailProps()
    expect(typeof detail.onPatch).toBe('function')

    detail.onPatch({ status: 'todo' })
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    expect(JSON.parse(patch!.opts.body)).toEqual({ status: 'todo' })
    // The parent is told WHICH task changed and HOW — it prunes extraDone.
    expect(patched).toEqual([['d2', { status: 'todo' }]])
  })

  it('drawer reports every applied patch to the parent; the parent decides membership', async () => {
    const server = createServer()
    const patched: Array<[string, any]> = []

    const h = mountDrawer(server, {
      taskId: 'd2',
      boardSlug: 'default',
      onTaskPatched: (taskId: string, patch: any) => { patched.push([taskId, patch]) },
    })

    await h.flush()

    // The drawer does not know about done paging — it forwards WHAT was
    // patched and the parent (owner of the held extra pages) applies the
    // membership rule (prune on status/archived, keep otherwise).
    h.detailProps().onPatch({ priority: 3 })
    await h.flush()

    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'PATCH')).toBe(true)
    expect(patched).toEqual([['d2', { priority: 3 }]])
  })

  it('drawer unblock action reports the status flip to the parent (extra-page ghost guard)', async () => {
    const server = createServer()
    const patched: Array<[string, any]> = []
    const task = { ...doneTask('d1', 300), diagnostics: [{ kind: 'worker_stalled', severity: 'error', title: 'stalled', detail: 'stalled', actions: [{ kind: 'unblock', label: 'Unblock' }] }] }

    const h = mountDiagSection(server, {
      task,
      boardSlug: 'default',
      assignees: [],
      diagnostics: task.diagnostics,
      onRefresh: () => {},
      onTaskPatched: (taskId: string, patch: any) => { patched.push([taskId, patch]) },
    })

    await h.flush()

    h.clickAction('unblock')
    await h.flush()

    const patch = h.callsTo('/tasks/d1').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    expect(JSON.parse(patch!.opts.body)).toEqual({ status: 'ready' })
    expect(patched).toEqual([['d1', { status: 'ready' }]])
  })

  it('parent prune hook: membership-changing drawer patch removes the extra-page card, non-membership patch keeps it', async () => {
    const server = createServer()
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Open the drawer for the extra-page card — the render site must wire
    // the prune hook through.
    h.boardColumnsProps().onOpen('d2')
    await h.flush()
    const drawer = h.taskDrawerProps()
    expect(typeof drawer.onTaskPatched).toBe('function')

    // A status patch on the extra-page card drops it from the merged done
    // column immediately (no ghost), without touching the first page.
    drawer.onTaskPatched('d2', { status: 'todo' })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // A non-membership patch must NOT prune — the card stays visible.
    drawer.onTaskPatched('d1', { priority: 5 })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('bulk delete with one failing delete prunes the deleted ids and refreshes (no ghost)', async () => {
    const server = createServer()
    server.setDeleteFailures(['d2'])
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Select both done cards, bulk-delete them; d2's DELETE fails.
    h.boardColumnsProps().toggleSelected('d1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('d2', true)
    await h.flush()
    h.nodeWithProp('onDelete').onDelete(2)
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()

    // Both DELETEs were attempted; d1's success still counts: pruned from
    // the held pages AND the board refreshed — d2 (still on the server) is
    // served by the refresh, d1 is not resurrected as a ghost.
    expect(h.callsTo('/tasks/d1').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)
    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)
    expect(h.doneIds()).toEqual(['d2'])
    h.unmount()
  })

  it('single delete rides the board param: the DELETE URL carries the current board slug', async () => {
    // plugin_api.delete_task resolves a MISSING board param to the ACTIVE
    // board (its own DB file per board). A delete fired without ?board=
    // would hit the default board's DB — the wrong card at an id collision,
    // else a 404 — whenever the dashboard's tab is not the active board.
    const server = createServer()
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onDelete('d1')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()

    const del = h.callsTo('/tasks/d1').find((c) => (c.opts && c.opts.method) === 'DELETE')
    expect(del).toBeTruthy()
    expect(new URLSearchParams((del!.url.split('?')[1]) || '').get('board')).toBe('default')
    h.unmount()
  })

  it('bulk delete rides the board param too: every DELETE URL carries the current board slug', async () => {
    const server = createServer()
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().toggleSelected('d1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('d2', true)
    await h.flush()
    h.nodeWithProp('onDelete').onDelete(2)
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()

    for (const id of ['d1', 'd2']) {
      const del = h.callsTo(`/tasks/${id}`).find((c) => (c.opts && c.opts.method) === 'DELETE')
      expect(del).toBeTruthy()
      expect(new URLSearchParams((del!.url.split('?')[1]) || '').get('board')).toBe('default')
    }

    h.unmount()
  })

  it('a stale load-more must not release the new scope\u2019s loading lock (no double fetch)', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Start a load-more in the old scope; its response is parked.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // Scope switch: gate resets and the loading lock is cleared.
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(false)

    // A fresh load-more in the new scope takes the lock again.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // The STALE response lands now. Its .finally must NOT release the lock
    // — otherwise two load-more fetches could run for the same offset.
    server.releaseFirstDeferred()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // The current request's response applies and releases the lock.
    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    h.unmount()
  })

  it('load-more is blocked while a move write is in flight; usable again after it settles', async () => {
    // Seed cards d0 (first page) and d3 (deepest): after the held extra-page
    // card d1 moves out, done still spans two pages (d0, d2, d3), so the
    // post-settle load-more has something to fetch.
    const server = createServer([doneTask('d0', 400), doneTask('d3', 100)])
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1'])

    // Move d1 (held extra-page card) out of done — the PATCH write is parked,
    // so the component sits in the pre-commit window: dispatch-time
    // prune+invalidation happened, but the server still holds d1 in done at
    // the OLD done_pagination total.
    h.boardColumnsProps().onMove('d1', 'todo')
    await h.flush()
    const offsetCallsBefore = h.callsTo('done_offset').length

    // A "Load more" dispatched inside the window must be a no-op — its page
    // would be built from pre-write server state and ghost d1 back in.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore)
    expect(h.doneIds()).toEqual(['d0'])

    // The write settles: pagination unblocks (post-commit invalidation) and
    // a fresh load-more is served from post-move server truth — no ghost.
    server.releaseDeferred('/tasks/d1')
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore + 1)
    // Fresh page from post-move truth: done = [d0, d2] (d1 is in todo).
    expect(h.doneIds()).toEqual(['d0', 'd2'])
    expect(h.todoIds()).toContain('d1')
    h.unmount()
  })

  it('applyBulk status patch blocks load-more until the write settles too', async () => {
    // Seed card: three done cards total, so a deeper page still exists after
    // the bulk write moved d0 out of done.
    const server = createServer([doneTask('d0', 400)])
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().toggleSelected('d0')
    await h.flush()
    // BulkActionBar apply — the applyBulk path (status patch without the
    // move dialogs). The write is parked: pre-commit window.
    h.nodeWithProp('onApply').onApply({ status: 'todo' })
    await h.flush()
    const offsetCallsBefore = h.callsTo('done_offset').length

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore)

    server.releaseDeferred('/tasks/bulk')
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore + 1)
    // Fresh page from post-write server truth — no d0 ghost anywhere.
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    expect(h.todoIds()).toContain('d0')
    h.unmount()
  })

  it('bulk archive of an extra-page done card removes it from the held extra pages (no ghost)', async () => {
    const server = createServer()
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // archive:true changes done membership server-side exactly like a status
    // move (bulk handler archive_task) — the same ghost guard must apply.
    h.boardColumnsProps().toggleSelected('d2')
    await h.flush()
    h.nodeWithProp('onApply').onApply({ archive: true })
    await h.flush()

    expect(h.doneIds()).toEqual(['d1'])
    const bulk = h.callsTo('/tasks/bulk')[0]
    expect(bulk).toBeTruthy()
    expect(JSON.parse(bulk!.opts.body).archive).toBe(true)
    h.unmount()
  })

  it('a WS status event invalidates an in-flight load-more (no ghost after the refresh)', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Load-more in flight; its page is built from PRE-event server state and
    // parked ([d2] at offset 1).
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // Server-side membership changes and the status event arrives over the
    // real WS handler while the page is still parked.
    const ws = h.wsInstances[0]
    expect(ws).toBeTruthy()

    if (ws.onopen) { ws.onopen() }
    server.setTaskStatus('d2', 'todo')
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'status' }], cursor: 2 }) })
    await h.flush()

    // The event released the loading lock immediately (the stale request's
    // .finally can no longer release it once invalidated).
    expect(h.boardColumnsProps().doneLoading).toBe(false)

    // The parked pre-event page lands — it must be discarded: d2 left done
    // server-side and would come back as a ghost into the merged column.
    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a non-membership WS event does not invalidate an in-flight load-more', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server, { ws: true })
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // An 'edited' event does not change board membership — the in-flight
    // page stays valid and must still apply.
    const ws = h.wsInstances[0]
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd1', kind: 'edited' }], cursor: 3 }) })
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    h.unmount()
  })

  it('a WS status event prunes a card already held in an extra page (no ghost)', async () => {
    const server = createServer()
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // d2 is loaded into a held extra page.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // ANOTHER client moves d2 out of done server-side; the status event
    // arrives over the real WS handler. The held extra page still carries
    // the stale done copy — the event must prune it immediately (the
    // debounced reload only replaces the first page, the merge would
    // otherwise resurrect d2 as a ghost even before that reload lands).
    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    server.setTaskStatus('d2', 'todo')

    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'status' }], cursor: 2 }) })
    await h.flush()

    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a WS archived event (foreign archive) prunes the held extra-page card and invalidates an in-flight load-more', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Load-more in flight; its page is built from PRE-event server state.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // A FOREIGN client archives d2 — the core appends kind 'archived'
    // (kanban_db.archive_task), never 'status' — while the page is parked.
    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    server.setTaskStatus('d2', 'archived')
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'archived' }], cursor: 2 }) })
    await h.flush()

    // The event released the loading lock immediately.
    expect(h.boardColumnsProps().doneLoading).toBe(false)

    // The parked pre-event page lands — it must be discarded: d2 left done
    // server-side and the held extra-page copy is already pruned, so it
    // would come back as a ghost into the merged column.
    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a WS deleted event (foreign hard delete) prunes a card held in an extra page (no ghost)', async () => {
    const server = createServer()
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // d2 is loaded into a held extra page.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // A FOREIGN client hard-deletes d2 (CLI or second dashboard tab). The
    // core appends the `deleted` tombstone (kanban_db._append_delete_tombstone)
    // — the task row is GONE server-side, so only the event can clear the
    // held extra-page copy. Without the prune the card would stay as a ghost
    // no client can ever remove.
    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'deleted' }], cursor: 2 }) })
    await h.flush()

    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a WS deleted event closes the open drawer instead of reloading it (no GET /tasks/:id)', async () => {
    const server = createServer()
    const h = mount(server, { ws: true })
    await h.flush()

    // Open the drawer for a card. This harness invokes only top-level
    // components, so the drawer's own detail GET is not recorded here —
    // what IS observable is the drawer VNode (props) and every fetch the
    // parent itself makes.
    h.boardColumnsProps().onOpen('d2')
    await h.flush()
    expect(h.taskDrawerProps().taskId).toBe('d2')

    // A FOREIGN client hard-deletes the OPEN task. The parent must close
    // the drawer through the normal onClose path (unmount) instead of
    // ticking it into a failing GET /tasks/:id (_require_task answers the
    // deleted task with an error).
    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'deleted' }], cursor: 2 }) })
    await h.flush()

    const drawerGone = (): boolean => {
      try {
        h.taskDrawerProps()

        return false
      } catch {
        return true
      }
    }

    expect(drawerGone()).toBe(true)

    // No detail fetch was fired by the parent after the delete (the drawer
    // reload path is eventTick-driven — the tick-skip is pinned by the
    // next test together with the real drawer harness).
    expect(h.callsTo('/tasks/d2').length).toBe(0)
    h.unmount()
  })

  it('a WS deleted event does not stamp the open drawer eventTick (drawer for another task stays open, tick untouched)', async () => {
    const server = createServer()
    const h = mount(server, { ws: true })
    await h.flush()

    // Open the drawer for d1; the deleted event names a DIFFERENT task
    // (d2): the drawer for d1 must stay open AND its eventTick prop must
    // stay 0 — a stamped tick would push the real drawer (mountDrawer
    // harness proves the tick-reload wiring) into a failing GET for the
    // deleted task on the next open.
    h.boardColumnsProps().onOpen('d1')
    await h.flush()
    expect(h.taskDrawerProps().taskId).toBe('d1')

    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'deleted' }], cursor: 2 }) })
    await h.flush()

    expect(h.taskDrawerProps().taskId).toBe('d1')
    expect(h.taskDrawerProps().eventTick).toBe(0)
    h.unmount()
  })

  it('a WS completed event (foreign completion) invalidates an in-flight load-more', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // A FOREIGN client completes a task — the core appends kind 'completed'
    // (kanban_db.complete_task), never 'status' — while the page is parked.
    // The page was built before the membership change (its offset math is
    // stale) and must be discarded; the debounced reload delivers the new
    // done card through the fresh first page.
    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    server.setTaskStatus('t1', 'done')
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 't1', kind: 'completed' }], cursor: 2 }) })
    await h.flush()

    expect(h.boardColumnsProps().doneLoading).toBe(false)

    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a WS reclaimed event is not a membership event (no prune, no invalidation)', async () => {
    const server = createServer()
    server.setDeferLoadMore(true)
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // reclaim_task refuses done tasks (running-only), so 'reclaimed' never
    // changes done membership — the held pages and the in-flight page must
    // stay untouched (a wrong prune would make a still-done card vanish).
    const ws = h.wsInstances[0]
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'reclaimed' }], cursor: 2 }) })
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    h.unmount()
  })

  it('a failed single move restores the extra-page card (no vanishing card)', async () => {
    const server = createServer()
    server.setWriteFailures(['d2'])
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Move d2 (extra-page card) to todo; the PATCH fails server-side — d2
    // KEEPS its done membership. The dispatch-time prune removed it from
    // the held extras; the failure path must put it back, or it vanishes
    // from the column (it lives beyond the first server page).
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    // d2 is back in the merged done column (first page d1 + restored d2).
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('a bulk move with a partial failure restores the failed extra-page card', async () => {
    // d0 sits on the first page (newest completion); d1/d2 live deeper.
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    // Bulk-move d1 + d2 to todo; d1 succeeds, d2 fails. Server truth after:
    // done = [d0, d2] — d2 is beyond the first page and only reachable via
    // the restored extra page.
    h.boardColumnsProps().toggleSelected('d1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('d2', true)
    await h.flush()
    h.boardColumnsProps().onMoveSelected('todo')
    await h.flush()

    // d1 moved; the failed d2 is restored into the held extras and merged
    // back behind the first-page card d0.
    expect(h.doneIds()).toEqual(['d0', 'd2'])
    expect(h.todoIds()).toEqual(expect.arrayContaining(['d1', 't1']))
    const bulk = h.callsTo('/tasks/bulk')[0]
    expect(bulk).toBeTruthy()
    expect(JSON.parse(bulk!.opts.body).ids.sort()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('applyBulk with a partial failure restores the failed extra-page card too', async () => {
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    h.boardColumnsProps().toggleSelected('d1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('d2', true)
    await h.flush()
    h.nodeWithProp('onApply').onApply({ status: 'todo' })
    await h.flush()

    // d1 moved; the failed d2 is restored into the held extras and merged
    // back behind the first-page card d0.
    expect(h.doneIds()).toEqual(['d0', 'd2'])
    expect(h.todoIds()).toContain('d1')
    h.unmount()
  })

  it('a failed membership write restores the extra-page card even when a foreign-card WS event resets the page gate mid-flight', async () => {
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    // Park the failing PATCH so the WS event can land INSIDE the write
    // window (dispatch → write settles) — the honest shape of the race.
    server.setDeferWrites(true)
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    // Move d2 (extra-page card) to todo; the PATCH is parked and will fail
    // server-side — d2 KEEPS its done membership.
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    // While the write is in flight, a WS membership event about a FOREIGN
    // card (t1) resets the page gate — same scope. The restore must still
    // fire when the write then fails: guarding it with the page-gate token
    // would suppress it (every membership mutation and WS event bumps that
    // gate) and d2 would vanish from the column until the next "Load more".
    const ws = h.wsInstances[0]
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 't1', kind: 'status' }], cursor: 2 }) })
    await h.flush()

    // The write fails now — the restore must put d2 back into the extras.
    server.releaseDeferred('/tasks/d2')
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    // d2 is back in the merged done column (first page d0 + held extras:
    // d1 was never touched, d2 restored after the failed write).
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])
    h.unmount()
  })

  it('a WS membership event for the SAME id inside the write window suppresses the restore (no ghost)', async () => {
    // The failed-write restore hangs on the scope generation only: a
    // membership event about a DIFFERENT card must not suppress it (test
    // above). But an event about the SAME id means the server's done
    // membership for THAT card changed while the write was in flight —
    // the WS handler already pruned the frozen extra copy, and restoring
    // it would resurrect a ghost.
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    server.setDeferWrites(true)
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    // Move d2 (extra-page card) to todo; the PATCH is parked and will fail.
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    // While the write is in flight, a foreign archive of d2 arrives over
    // the WS tailer (kind 'archived' — kanban_db.archive_task): the WS
    // handler prunes d2 from the held extras. The write then fails — but
    // d2's done membership changed server-side under the frozen copy, so
    // the restore must NOT put it back.
    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'archived' }], cursor: 2 }) })
    await h.flush()

    server.releaseDeferred('/tasks/d2')
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    // No ghost: d2 was pruned by the WS event and the restore skipped it.
    // d1 was never touched and stays held; d0 is the first page.
    expect(h.doneIds()).toEqual(['d0', 'd1'])
    h.unmount()
  })

  it('a WS membership event for a DIFFERENT id inside the write window does not suppress the restore', async () => {
    // Negative case for the per-id membership window: the event names
    // another HELD extra card (d1) — d2's restore must still fire.
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    server.setDeferWrites(true)
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    // Membership event about d1 (foreign status change) mid-flight: d1 is
    // pruned from the held extras by the WS handler — but d2's restore
    // must not be suppressed by an event about a different id.
    const ws = h.wsInstances[0]

    if (ws.onopen) { ws.onopen() }
    ws.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd1', kind: 'status' }], cursor: 2 }) })
    await h.flush()

    server.releaseDeferred('/tasks/d2')
    await h.flush()

    // d2 is restored after the failed write (d1's prune is the WS-prune
    // path's own behavior — it returns via the fresh first page / next
    // load-more, out of scope here).
    expect(h.doneIds()).toEqual(expect.arrayContaining(['d0', 'd2']))
    expect(h.doneIds()).not.toContain('d1')
    h.unmount()
  })

  it('a successful local delete inside the write window suppresses the failed-move restore (no ghost)', async () => {
    // A DELETE leaves NO WS event (kanban_db.delete_task hard-deletes the
    // task without appending a task_event), so the membership counter
    // cannot see it. A successful delete inside a failed write's window
    // means the card no longer exists server-side — the restore must not
    // resurrect the frozen extra-page copy.
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    // Move d2 (extra-page card) to todo; the PATCH is parked and will fail.
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    // While the write is in flight, d2 is deleted LOCALLY through the
    // confirm dialog: the DELETE succeeds (no WS event), the held extras
    // are pruned and the board refreshed.
    h.boardColumnsProps().onDelete('d2')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()
    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)

    // The parked PATCH now fails — d2 must stay gone.
    server.releaseDeferred('/tasks/d2')
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    // No ghost: d2 was deleted and the restore skipped it. d1 was never
    // touched and stays held; d0 is the first page.
    expect(h.doneIds()).toEqual(['d0', 'd1'])
    h.unmount()
  })

  it('a FAILED local delete inside the write window does not suppress the failed-move restore', async () => {
    // Over-suppression guard: a delete that FAILS never removed the card —
    // d2 keeps its done membership, nothing is counted (see doneDeletesRef),
    // and the restore must still fire when the parked PATCH fails.
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    server.setDeleteFailures(['d2'])
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()

    // The delete attempt fails server-side — d2 still exists and is still
    // done; the held extras still carry it (no prune on failure).
    h.boardColumnsProps().onDelete('d2')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()
    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)
    // d2 was pruned at MOVE dispatch (not by the failed delete) and its
    // restore has not fired yet — it must still be absent here.
    expect(h.doneIds()).toEqual(['d0', 'd1'])

    server.releaseDeferred('/tasks/d2')
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    // The restore fired: d2 is back in the merged done column.
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])
    h.unmount()
  })

  it('a successful local delete inside a bulk move write window suppresses the restore of the deleted id (no ghost)', async () => {
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    // Bulk-move d1 + d2; the bulk response is parked (d1 will succeed,
    // d2 will fail per setWriteFailures).
    h.boardColumnsProps().toggleSelected('d1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('d2', true)
    await h.flush()
    h.boardColumnsProps().onMoveSelected('todo')
    await h.flush()

    // Inside the parked write window, d2 is deleted LOCALLY (successful
    // DELETE, no WS event). The bulk response then lands: d1 moved, d2
    // "failed" — but d2 no longer exists server-side, so its restore must
    // be suppressed instead of resurrecting the frozen extra copy.
    h.boardColumnsProps().onDelete('d2')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()

    server.releaseDeferred('/tasks/bulk')
    await h.flush()

    const bulk = h.callsTo('/tasks/bulk')[0]
    expect(bulk).toBeTruthy()
    expect(JSON.parse(bulk!.opts.body).ids.sort()).toEqual(['d1', 'd2'])
    // No ghost: d1 moved (it lives beyond the first page again until the
    // next load-more), d2 was deleted — the restore skipped it, so only
    // the first-page card remains.
    expect(h.doneIds()).toEqual(['d0'])
    h.unmount()
  })

  it('a successful local delete inside an applyBulk write window suppresses the restore of the deleted id (no ghost)', async () => {
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    h.boardColumnsProps().toggleSelected('d1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('d2', true)
    await h.flush()
    h.nodeWithProp('onApply').onApply({ status: 'todo' })
    await h.flush()

    // Same race through the third restore path (applyBulk
    // restoreFailedExtras): d2 deleted inside the parked window, then the
    // bulk response lands with d2 marked failed.
    h.boardColumnsProps().onDelete('d2')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()

    server.releaseDeferred('/tasks/bulk')
    await h.flush()

    // No ghost: d1 moved, d2 deleted and NOT restored — only the
    // first-page card remains.
    expect(h.doneIds()).toEqual(['d0'])
    h.unmount()
  })

  it('a /board response built before a membership mutation is discarded when it lands after the mutation (no ghost in the first done page)', async () => {
    // Second open card so the pre-mutation read is a BULK write's refresh
    // (which exists on every code path — see bulk .then refresh); d0 is the
    // first-page done card that the membership mutation moves out.
    const server = createServer([doneTask('d0', 400), openTask('t2')])
    server.setDeferBoardReads(true)
    const h = mount(server)
    await h.flush()
    // Mount issues TWO reads: one before the board slug resolves from the
    // boards list (no ?board= param) and one after — the scope effect bumps
    // the gate between them, so the first is invalidated on purpose. Release
    // both; the second (current generation) renders the board.
    expect(server.releaseDeferred('/board')).toBe(2)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    // A /board read starts and parks (built from current truth: done [d0],
    // t1/t2 in todo): the refresh of a NON-membership bulk write (t1+t2 →
    // ready) dispatches loadBoard like every write completion.
    h.boardColumnsProps().toggleSelected('t1')
    await h.flush()
    h.boardColumnsProps().toggleSelected('t2', true)
    await h.flush()
    h.boardColumnsProps().onMoveSelected('ready')
    await h.flush()

    // Membership mutation while that read is still in flight: d0 leaves done.
    h.boardColumnsProps().onMove('d0', 'todo')
    await h.flush()

    // The pre-mutation response lands first (FIFO) — it must be DISCARDED:
    // applying it would overwrite the post-mutation board with pre-mutation
    // server state (d0 back in the first done page as a ghost).
    expect(server.releaseFirstDeferred()).toBe(1)
    await h.flush()
    expect(h.doneIds()).toEqual([])
    expect(h.todoIds()).toContain('d0')

    // The fresh post-mutation read applies: done = [d1] (server truth).
    expect(server.releaseDeferred('/board')).toBe(1)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.todoIds()).toEqual(['d0'])
    h.unmount()
  })

  it('a foreign change below the consumed window must not skip a still-done card on repeated load-more clicks (consistent totals)', async () => {
    // d4 sits BELOW everything the client has consumed: a foreign archive of
    // it changes the server total without shifting a single position the
    // client holds. The load-more delta must compare the anchor's total with
    // the most recent accepted response's total (same response lineage) —
    // correcting against the FIRST page's done_pagination.total instead
    // (never advanced by the load-more path) mixes two server epochs: the
    // change becomes a phantom +1 delta and every repeated click skips one
    // still-done card — d3 strands unreachable, every further click requests
    // an offset past the end.
    const server = createServer([doneTask('d3', 150), doneTask('d4', 100)])
    server.setDoneLimit(1)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.donePaging()).toEqual({ total: 4, loaded: 1, hasMore: true })

    // Click 1 consumes server index 1 (d2). The response is built from
    // post-archive server truth (total 3) and re-anchors the window on it.
    server.setTaskStatus('d4', 'archived')  // foreign archive BELOW the window
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    expect(h.donePaging()).toEqual({ total: 3, loaded: 2, hasMore: true })

    // Click 2 must request server index 2 — d3, still done.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2', 'd3'])
    expect(h.donePaging()).toEqual({ total: 3, loaded: 3, hasMore: false })
    h.unmount()
  })

  it('a first-page refresh between load-more clicks must not rewind the consumption anchor (forward progress)', async () => {
    // The held extras survive a first-page refresh — with an UNCHANGED window
    // (same total, same first-page head) the consumption anchor must too:
    // resetting it to the first-page boundary rewinds the window and the next
    // click re-fetches already-held pages (the merge dedupes the repeat), so
    // with a refresh between every click the column never pages forward.
    const server = createServer([doneTask('d3', 100)])
    server.setDoneLimit(1)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Click 1 consumes server index 1 (d2) — the extras hold it.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // A refresh with NO membership change (toolbar / WS-debounced reload):
    // fresh first page, extras survive, window unchanged. The anchor must
    // stay past the held extra (server index 2), not rewind to the boundary.
    h.nodeWithProp('onRefresh').onRefresh()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // The single next click must reach d3 — a rewound anchor would request
    // server index 1 (d2 again, silently deduped) and stall.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2', 'd3'])
    expect(h.donePaging()).toEqual({ total: 3, loaded: 3, hasMore: false })
    h.unmount()
  })

  it('a DELETE that settles after a board switch must not prune the new board\u2019s extra pages (same-id collision)', async () => {
    // Task ids are unique only WITHIN one board's db (one kanban_db file per
    // board) — the fixture serves the same ids for every board, which is
    // exactly the cross-board collision shape. A delete dispatched on board
    // A whose success lands after the switch to board B prunes by raw id:
    // without the scope guard it erases board B's still-done same-id card
    // from the held extra pages (reverse ghost until the filter switch).
    const server = createServer()
    server.setDeferDeletes(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Board A: load the extra page, delete d2 there (response parked).
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.boardColumnsProps().onDelete('d2')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()
    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)
    // Still held: the DELETE response is parked in flight.
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Switch to board B while the DELETE is in flight and re-load the extra
    // page there — board B serves the same id (the collision under test).
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // The parked DELETE settles now — it belongs to board A. The prune and
    // the page-gate invalidation are bound to the dispatch scope: board B's
    // same-id card stays in the held extras.
    server.releaseDeferred('/tasks/d2')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('a bulk DELETE that settles after a board switch must not prune the new board\u2019s extra pages either', async () => {
    // Sibling path of the single delete: deleteSelected's success handler
    // prunes every fulfilled DELETE by raw id — same cross-board collision
    // guard required.
    const server = createServer()
    server.setDeferDeletes(true)
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Board A: select the extra-page card d2 and bulk-delete it (deleteSelected
    // path — its success handler prunes every fulfilled DELETE by raw id).
    // d1 stays: the fixture's task map is shared across boards, deleting it
    // would empty board B's FIRST page too and bury the assertion.
    h.boardColumnsProps().toggleSelected('d2')
    await h.flush()
    h.nodeWithProp('onDelete').onDelete(1)
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()
    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'DELETE')).toBe(true)

    // Switch to board B while both DELETEs are in flight; rebuild its held
    // extra page (same ids — the collision shape).
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Both parked DELETEs settle — board A's successes. Board B's held
    // extra page must survive them.
    server.releaseDeferred('/tasks/')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('a delete success from the OLD board must not suppress the new board\u2019s failed-move restore (same-id collision)', async () => {
    // The delete counter is board-keyed (doneWindowKey): board A's late
    // delete success lands under board A's key and must not close board B's
    // write window for the same id — board B's failed move must still
    // restore its extra-page card. With a raw-id counter the late success
    // bumps the shared count and the restore is silently skipped.
    const server = createServer([doneTask('d0', 400)])
    server.setWriteFailures(['d2'])
    server.setDeferWrites(true)
    server.setDeferDeletes(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d0'])

    // Board A: load both extra pages, then delete d2 (response parked).
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])
    h.boardColumnsProps().onDelete('d2')
    await h.flush()
    h.dialogsProps().dialogProps.onConfirm()
    await h.flush()

    // Switch to board B while the DELETE is in flight and rebuild the held
    // extras there (same ids — the collision shape).
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])

    // Move d2 to todo on board B; the PATCH is parked and will fail.
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()
    expect(h.doneIds()).toEqual(['d0', 'd1'])

    // Board A's parked DELETE settles first (older request) — its success
    // must count under board A's key only.
    server.releaseFirstDeferred()
    await h.flush()
    // Then board B's failing PATCH settles: the restore must fire.
    server.releaseFirstDeferred()
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    expect(h.doneIds()).toEqual(['d0', 'd1', 'd2'])
    h.unmount()
  })

  it('a move PATCH parked across a board switch must not corrupt the new scope (pre-commit block + scope-guarded prune)', async () => {
    // The single move's success handler prunes the written id by raw id.
    // Across a board switch the same id is a DIFFERENT card (one kanban_db
    // file per board) — the prune is bound to the dispatch scope.
    //
    // Structural closure of this path (why the pin cannot distinguish a
    // guarded from an unguarded prune, and why the guard is still bound):
    // (1) the pre-commit window blocks load-more while the write is in
    // flight (asserted below), so the new scope cannot even build held extra
    // pages for a late stale success to erase; (2) the scope reset effect
    // empties extraDone at the switch (asserted below), so the late prune
    // always lands in empty pages. The dispatch-scope guard is the second
    // belt for the day the block is ever loosened; the REACHABLE carriers of
    // this ghost class (WS frame, drawer PATCH, DELETE) are pinned by their
    // own guard-dependent tests.
    const server = createServer()
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Board A: load the extra page and move d2 out of done (PATCH parked).
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()
    expect(h.callsTo('/tasks/d2').some((c) => (c.opts && c.opts.method) === 'PATCH')).toBe(true)

    // Switch to board B while the PATCH is in flight: load-more must stay
    // blocked for the whole pre-commit window.
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    const offsetCallsBefore = h.callsTo('done_offset').length
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore)

    // The parked PATCH settles — board A's success. The scope-guarded prune
    // must not touch the new scope; the refresh reflects the post-write
    // truth — no ghost, no crash.
    server.releaseDeferred('/tasks/d2')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // The pre-commit window ENDS with the write: load-more is usable again
    // (lock released, no deadlock) and the scope stays fully functional.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a bulk move parked across a board switch must not corrupt the new scope either', async () => {
    // Sibling path: performMoveTask's bulk success handler prunes every
    // ok-id by raw id — same dispatch-scope binding required.
    //
    // Structural closure as in the single-move pin above: the pre-commit
    // block (asserted below) keeps the new scope from building held extra
    // pages during the write window, and the scope reset empties extraDone
    // at the switch — the late prune always lands in empty pages, so a
    // guarded and an unguarded prune are behaviorally indistinguishable
    // here. The guard is the second belt; the reachable carriers (WS frame,
    // drawer PATCH, DELETE) carry their own guard-dependent tests.
    const server = createServer([doneTask('x1', 100)])
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2', 'x1'])

    // Board A: select both extra-page cards and bulk-move them (parked).
    h.boardColumnsProps().toggleSelected('d2')
    await h.flush()
    h.boardColumnsProps().toggleSelected('x1', true)
    await h.flush()
    h.boardColumnsProps().onMoveSelected('todo')
    await h.flush()
    const bulk = h.callsTo('/tasks/bulk')[0]
    expect(bulk).toBeTruthy()
    expect(JSON.parse(bulk!.opts.body).ids).toEqual(['d2', 'x1'])

    // Switch to board B while the bulk write is in flight: load-more stays
    // blocked for the whole pre-commit window.
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    const offsetCallsBefore = h.callsTo('done_offset').length
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore)

    // The parked bulk write settles — board A's success. The scope-guarded
    // prune must not touch the new scope's held pages.
    server.releaseDeferred('/tasks/bulk')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // The pre-commit window ENDS with the write: load-more is usable again
    // (lock released, no deadlock) and the scope stays fully functional.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('an applyBulk write parked across a board switch must not corrupt the new scope', async () => {
    // Sibling path: applyBulk's success handler prunes every ok-id by raw
    // id — same dispatch-scope binding required.
    //
    // Structural closure as in the single-move pin above: the pre-commit
    // block (asserted below) keeps the new scope from building held extra
    // pages during the write window, and the scope reset empties extraDone
    // at the switch — the late prune always lands in empty pages, so a
    // guarded and an unguarded prune are behaviorally indistinguishable
    // here. The guard is the second belt; the reachable carriers (WS frame,
    // drawer PATCH, DELETE) carry their own guard-dependent tests.
    const server = createServer()
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Board A: select the extra-page card and apply a status patch (parked).
    h.boardColumnsProps().toggleSelected('d2')
    await h.flush()
    h.nodeWithProp('onApply').onApply({ status: 'todo' })
    await h.flush()
    expect(h.callsTo('/tasks/bulk').length).toBeGreaterThan(0)

    // Switch to board B while the write is in flight: load-more stays
    // blocked for the whole pre-commit window.
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    const offsetCallsBefore = h.callsTo('done_offset').length
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore)

    // The parked write settles — board A's success. The scope-guarded prune
    // must not touch the new scope's held pages.
    server.releaseDeferred('/tasks/bulk')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // The pre-commit window ENDS with the write: load-more is usable again
    // (lock released, no deadlock) and the scope stays fully functional.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a stale WS membership event from the old board\u2019s socket must not prune the new board\u2019s extra pages (same-id collision)', async () => {
    // The socket is board-pinned and its effect closes it on a board switch,
    // but close() is asynchronous: a frame already received can still flush
    // to the OLD handler after the switch. That stale event belongs to the
    // old scope — its raw-id prune would erase the NEW board's still-done
    // same-id card from the held extras.
    const server = createServer()
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Board A: load the extra page. The socket captured here belongs to
    // board A's scope.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    const staleWs = h.wsInstances[h.wsInstances.length - 1]
    expect(staleWs).toBeTruthy()

    // Switch to board B and rebuild its held extra page — same ids (the
    // collision shape).
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // The stale frame flushes to board A's old handler now. It must not
    // touch board B's held extra pages (same-id d2 stays held).
    staleWs.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'status' }], cursor: 2 }) })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('a WS membership event after a tenant filter switch still prunes and invalidates (socket restarts with the scope)', async () => {
    // The scope reset effect bumps the scope generation for board AND filter
    // changes; the socket lifecycle must ride with it. A socket that kept
    // running across a filter switch would carry a stale scope token — the
    // guard would discard every membership frame of the still-running socket
    // and a foreign move of a held extra-page card would survive as a ghost
    // until the next board switch. The restart previously held only via the
    // accidental transitive identity chain scheduleReload -> refreshBoard ->
    // loadBoard([tenantFilter, includeArchived, board]); it is bound
    // explicitly in the socket effect's deps now (round-15 finding class).
    const server = createServer([doneTask('d3', 50)])
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    const socketsBefore = h.wsInstances.length

    // Filter switch: scope reset (extras cleared) AND an explicit socket
    // restart with a fresh scope token.
    h.nodeWithProp('setTenantFilter').setTenantFilter('infra')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.wsInstances.length).toBeGreaterThan(socketsBefore)
    const currentWs = h.wsInstances[h.wsInstances.length - 1]

    // Rebuild the extra page under the new filter, then park a further
    // load-more (built pre-event: it would deliver d3).
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    server.setDeferLoadMore(true)
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.boardColumnsProps().doneLoading).toBe(true)

    // A foreign client moves the held d2 out of done; the frame arrives on
    // the CURRENT socket: prune + invalidation must fire.
    server.setTaskStatus('d2', 'todo')
    currentWs.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'status' }], cursor: 7 }) })
    await h.flush()
    // Prune fired (d2 left the held extras) and the loading lock released.
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.boardColumnsProps().doneLoading).toBe(false)
    // The parked pre-event page lands — it must be discarded (stale gate
    // token): d2 would come back as a ghost, d3 is a pre-event snapshot.
    server.releaseDeferred('done_offset')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a WS membership event after an include-archived filter switch still prunes too (socket restarts with the scope)', async () => {
    // Same class as the tenant filter: the archive toggle is part of the
    // scope the socket token belongs to.
    const server = createServer()
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    const socketsBefore = h.wsInstances.length

    h.nodeWithProp('setIncludeArchived').setIncludeArchived(true)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.wsInstances.length).toBeGreaterThan(socketsBefore)
    const currentWs = h.wsInstances[h.wsInstances.length - 1]

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    server.setTaskStatus('d2', 'todo')
    currentWs.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'status' }], cursor: 7 }) })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('a frame flushed from the pre-filter socket after a filter switch is discarded (stale scope token)', async () => {
    // Symmetric pin for the filter dimension: with the socket restarting on
    // the switch, a late frame from the PRE-filter socket belongs to the old
    // scope — its raw-id prune must stay discarded (the fresh socket
    // re-delivers from the cursor, so nothing is lost). Mirrors the
    // board-switch negative above for the filter axis.
    const server = createServer()
    const h = mount(server, { ws: true })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    const staleWs = h.wsInstances[h.wsInstances.length - 1]
    expect(staleWs).toBeTruthy()

    h.nodeWithProp('setTenantFilter').setTenantFilter('infra')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // The stale frame flushes to the OLD socket's handler now — the guard
    // must reject it: the rebuilt held page stays intact.
    staleWs.onmessage({ data: JSON.stringify({ events: [{ task_id: 'd2', kind: 'status' }], cursor: 3 }) })
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.unmount()
  })

  it('a stale onclose from the OLD scope\u2019s socket after a board switch must NOT schedule a second socket (per-run lifecycle token)', async () => {
    // close() is asynchronous and the scope switch does not wait for it: the
    // old socket's onclose can fire AFTER the socket effect re-ran for the
    // new scope. The old shared wsClosedRef was reset to false by the new
    // run, so the late onclose sailed past its guard and scheduled the OLD
    // run's openWs — a duplicated socket generation with old parameters that
    // overwrote wsRef (the current socket untracked at the next cleanup:
    // leak, duplicate frames). Every continuation must be bound to the run
    // that created it: the old run's token was closed by ITS cleanup and a
    // newer run cannot un-close it.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const server = createServer()
      const h = mount(server, { ws: true })
      await h.flush()
      expect(h.doneIds()).toEqual(['d1'])
      const staleWs = h.wsInstances[h.wsInstances.length - 1]
      expect(staleWs).toBeTruthy()

      // Scope switch: the effect re-runs and opens the CURRENT socket.
      h.nodeWithProp('onSwitch').onSwitch('board-b')
      await h.flush()
      const socketsBefore = h.wsInstances.length
      expect(socketsBefore).toBeGreaterThanOrEqual(2)

      // The old socket's close event lands AFTER the switch (asynchronous
      // close). Its backoff reconnect timer must never fire a socket.
      staleWs.onclose({ code: 1006 })
      await vi.advanceTimersByTimeAsync(31_000)
      await h.flush()
      expect(h.wsInstances.length).toBe(socketsBefore)
      h.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a parked buildWsUrl continuation of the OLD scope must NOT open a socket after a board switch (per-run lifecycle token)', async () => {
    // The URL build is async (gated mode mints a ticket): its .then can
    // resolve after the scope switched. The old continuation checked the
    // shared, already-reset wsClosedRef and opened a second socket with the
    // old board pinned — wsRef overwritten, duplicate generation. The
    // continuation belongs to the run that started the build; that run was
    // closed by its own cleanup.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const server = createServer()
      const h = mount(server, { ws: true, deferFirstWsUrl: true })
      await h.flush()
      // The first URL build is parked: no socket yet.
      expect(h.wsInstances.length).toBe(0)

      // Scope switch: the new run's URL build resolves normally and opens
      // the current socket; the old run's continuation stays parked.
      h.nodeWithProp('onSwitch').onSwitch('board-b')
      await h.flush()
      const socketsBefore = h.wsInstances.length
      expect(socketsBefore).toBeGreaterThanOrEqual(1)

      // The parked URL build of the OLD run resolves now: it must open
      // nothing.
      h.releaseFirstWsUrl()
      await vi.advanceTimersByTimeAsync(31_000)
      await h.flush()
      expect(h.wsInstances.length).toBe(socketsBefore)
      h.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a legitimate reconnect after a connection drop WITHIN the same scope still reopens exactly one follow-up socket', async () => {
    // Negative pin: the per-run token must not suppress the real reconnect
    // path — a drop (non-1008 close) inside the current run schedules its
    // own openWs, which opens exactly one follow-up socket in the SAME run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    try {
      const server = createServer([doneTask('d3', 50)])
      const h = mount(server, { ws: true })
      await h.flush()
      expect(h.doneIds()).toEqual(['d1'])
      expect(h.wsInstances.length).toBe(1)
      const dropped = h.wsInstances[0]

      // Connection drop in the same scope: backoff reconnect fires.
      dropped.onclose({ code: 1006 })
      await vi.advanceTimersByTimeAsync(31_000)
      await h.flush()
      expect(h.wsInstances.length).toBe(2)
      const reconnected = h.wsInstances[1]
      // The follow-up socket is live: it carries the message wiring of the
      // same run (message handler installed).
      expect(typeof reconnected.onmessage).toBe('function')
      h.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a drawer patch reported with a stale scope token must not prune the new board\u2019s extra pages (same-id collision)', async () => {
    // The drawer chain stamps every patch report with the dispatch-time
    // scope generation (captureScopeGen). A PATCH dispatched on board A
    // whose success is reported after the switch to board B must be dropped
    // by the parent prune — ids collide across boards. Drawer patches do
    // NOT bump the pre-commit write counter, so board B CAN rebuild its
    // held extra page while the PATCH is in flight — the reachable shape of
    // this ghost. The same-board negative (current token → prune) is pinned
    // at the end.
    const server = createServer()
    const h = mount(server)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])

    // Board A: load the extra page, open the drawer for the extra-page card
    // (the render site wires the prune hook + token capture through), and
    // capture the dispatch-time token the way applyPatch does when it
    // issues the PATCH.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])
    h.boardColumnsProps().onOpen('d2')
    await h.flush()
    // Dispatch-time token, captured the way applyPatch does when it issues
    // the PATCH (undefined only if the chain doesn't stamp tokens — the
    // mountDrawer contract test pins the stamp itself).
    const capture = h.taskDrawerProps().captureScopeGen
    const staleToken = typeof capture === 'function' ? capture() : undefined

    // Switch to board B while the PATCH is in flight; rebuild its held
    // extra page — same ids (the collision shape).
    h.nodeWithProp('onSwitch').onSwitch('board-b')
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // The drawer's patch success is reported now, stamped with the STALE
    // dispatch-time token — the parent prune must ignore it: board B's
    // same-id card stays held.
    h.taskDrawerProps().onTaskPatched('d2', { status: 'todo' }, staleToken)
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Negative: the SAME id reported with the CURRENT scope's token (the
    // ordinary same-board drawer patch) must still prune.
    h.taskDrawerProps().onTaskPatched('d2', { status: 'todo' }, h.taskDrawerProps().captureScopeGen())
    await h.flush()
    expect(h.doneIds()).toEqual(['d1'])
    h.unmount()
  })

  it('drawer patch reports the dispatch-time scope token to the parent (stamped at dispatch, not at response)', async () => {
    // Contract pin for the real chain: TaskDetail.applyPatch captures the
    // scope generation when it ISSUES the PATCH and passes it as the third
    // onTaskPatched argument — a token captured at response time would let a
    // board switch launder a stale prune into the new scope.
    const server = createServer()

    let generation = 7
    const patched: Array<[string, any, unknown]> = []

    const h = mountDrawer(server, {
      taskId: 'd2',
      boardSlug: 'default',
      captureScopeGen: () => generation,
      onTaskPatched: (taskId: string, patch: any, scopeGen: unknown) => { patched.push([taskId, patch, scopeGen]) },
    })

    await h.flush()

    // Park the write so dispatch and response are distinct points in time.
    server.setDeferWrites(true)

    h.detailProps().onPatch({ status: 'todo' })
    generation = 8 // the scope moves on while the write is in flight
    server.releaseDeferred('/tasks/d2')
    await h.flush()

    const patch = h.callsTo('/tasks/d2').find((c) => (c.opts && c.opts.method) === 'PATCH')
    expect(patch).toBeTruthy()
    expect(patched).toEqual([['d2', { status: 'todo' }, 7]])
  })
})
