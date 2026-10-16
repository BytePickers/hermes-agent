import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

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

  const doneSorted = () =>
    [...tasks.values()]
      .filter((t) => t.status === 'done')
      .sort((a, b) => {
        const aOpen = a.completed_at == null
        const bOpen = b.completed_at == null

        if (aOpen !== bOpen) { return aOpen ? 1 : -1 }

        if (!aOpen && a.completed_at !== b.completed_at) { return b.completed_at - a.completed_at }

        return a.id < b.id ? 1 : (a.id > b.id ? -1 : 0)
      })

  const serveBoard = (offset: number) => {
    const done = doneSorted()
    const window = done.slice(offset, offset + LIMIT)

    return {
      columns: [
        { name: 'triage', tasks: [] },
        { name: 'todo', tasks: [...tasks.values()].filter((t) => t.status === 'todo') },
        { name: 'ready', tasks: [] },
        { name: 'running', tasks: [] },
        { name: 'blocked', tasks: [] },
        { name: 'review', tasks: [] },
        { name: 'done', tasks: window },
      ],
      tenants: ['infra'],
      assignees: [],
      latest_event_id: 1,
      done_pagination: { total: done.length, offset, limit: LIMIT },
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
      const payload = serveBoard(offset)

      if (!deferredEnabled()) { return Promise.resolve(payload) }

      return new Promise((resolve) => { deferred.push({ url, payload, resolve }) })
    }

    if (url.includes('/board')) { return Promise.resolve(serveBoard(0)) }

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

      if (writeFailures.has(id)) { return Promise.reject(new Error(`patch failed: ${id}`)) }

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

      tasks.delete(id)

      return Promise.resolve({})
    }

    return Promise.resolve({})
  }

  let deferMode = false
  const deferredEnabled = () => deferMode
  let deferWriteMode = false
  const deferredWritesEnabled = () => deferWriteMode

  return {
    route,
    setDeferLoadMore(v: boolean) { deferMode = v },
    // Parks WRITE responses (PATCH/bulk) like setDeferLoadMore parks pages:
    // the test holds a membership write in flight to pin down the pre-commit
    // window of the optimistic move paths.
    setDeferWrites(v: boolean) { deferWriteMode = v },
    setDeleteFailures(ids: string[]) { for (const id of ids) { deleteFailures.add(id) } },
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
function createWindow(runtime: ReturnType<typeof createHooksRuntime>, server: ReturnType<typeof createServer>, calls: Array<{ url: string; opts: any }>, opts: { ws?: boolean } = {}) {
  const wsInstances: Array<Record<string, any>> = []

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
        ? () => Promise.resolve('ws://test/events')
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

  return { win, wsInstances }
}

function evalPlugin(): void {
  vm.runInThisContext(readFileSync(PLUGIN_PATH, 'utf8'), { filename: PLUGIN_PATH })
}

function mount(server: ReturnType<typeof createServer>, opts: { ws?: boolean } = {}) {
  const runtime = createHooksRuntime()
  const registered: Array<[string, any]> = []
  const calls: Array<{ url: string; opts: any }> = []

  const { win, wsInstances } = createWindow(runtime, server, calls, opts) as { win: Record<string, any>; wsInstances: Array<Record<string, any>> }
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
    expect(h.todoIds()).toEqual(['t1'])
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
    const server = createServer()
    server.setDeferWrites(true)
    const h = mount(server)
    await h.flush()

    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.doneIds()).toEqual(['d1', 'd2'])

    // Move d2 out of done — the PATCH write is parked, so the component sits
    // in the pre-commit window: dispatch-time prune+invalidation happened,
    // but the server still holds d2 in done at the OLD done_pagination total.
    h.boardColumnsProps().onMove('d2', 'todo')
    await h.flush()
    const offsetCallsBefore = h.callsTo('done_offset').length

    // A "Load more" dispatched inside the window must be a no-op — its page
    // would be built from pre-write server state and ghost d2 back in.
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore)
    expect(h.doneIds()).toEqual(['d1'])

    // The write settles: pagination unblocks (post-commit invalidation) and
    // a fresh load-more is served from post-move server truth — no ghost.
    server.releaseDeferred('/tasks/d2')
    await h.flush()
    h.boardColumnsProps().onLoadMoreDone()
    await h.flush()
    expect(h.callsTo('done_offset').length).toBe(offsetCallsBefore + 1)
    expect(h.doneIds()).toEqual(['d1'])
    expect(h.todoIds()).toContain('d2')
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
})
