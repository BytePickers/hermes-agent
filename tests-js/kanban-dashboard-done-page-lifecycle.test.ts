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

function createServer() {
  const tasks = new Map<string, any>([
    ['t1', openTask('t1')],
    ['d1', doneTask('d1', 300)],
    ['d2', doneTask('d2', 200)], // lives on done page 2 (limit-1 window)
  ])

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
        const t = tasks.get(id)

        if (t && body.status) { t.status = body.status }
      }

      return Promise.resolve({ results: (body.ids || []).map((id: string) => ({ id, ok: true })) })
    }

    const patchMatch = url.match(/\/tasks\/([^/?]+)/)

    if (patchMatch && opts && opts.method === 'PATCH') {
      const t = tasks.get(decodeURIComponent(patchMatch[1]))
      const body = JSON.parse((opts && opts.body) || '{}')

      if (t && body.status) { t.status = body.status }

      return Promise.resolve({})
    }

    if (patchMatch && opts && opts.method === 'DELETE') {
      tasks.delete(decodeURIComponent(patchMatch[1]))

      return Promise.resolve({})
    }

    return Promise.resolve({})
  }

  let deferMode = false
  const deferredEnabled = () => deferMode

  return {
    route,
    setDeferLoadMore(v: boolean) { deferMode = v },
    releaseDeferred(filter: string): number {
      let n = 0

      for (const d of deferred.splice(0)) {
        if (d.url.includes(filter)) { d.resolve(d.payload); n++ }
      }

      return n
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

function mount(server: ReturnType<typeof createServer>) {
  const runtime = createHooksRuntime()
  const registered: Array<[string, any]> = []
  const calls: Array<{ url: string; opts: any }> = []

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
      // Never settles: no WebSocket loop in tests.
      buildWsUrl: () => new Promise(() => {}),
    },
    __HERMES_PLUGINS__: {
      register: (name: string, page: any) => { registered.push([name, page]) },
    },
    __HERMES_KANBAN_TEST__: true,
    localStorage: {
      getItem: () => null,
      setItem: () => { /* ignore */ },
      removeItem: () => { /* ignore */ },
    },
  }

  ;(globalThis as unknown as { window: unknown }).window = win
  vm.runInThisContext(readFileSync(PLUGIN_PATH, 'utf8'), { filename: PLUGIN_PATH })

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
    nodeWithProp,
    doneIds,
    todoIds,
    donePaging,
    calls,
    callsTo,
  }
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
})
