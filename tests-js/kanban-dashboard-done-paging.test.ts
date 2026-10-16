import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { describe, expect, it } from 'vitest'

// Loads the REAL kanban dashboard plugin bundle (a plain IIFE, no build step)
// against a stub plugin SDK and exercises its pure done-column paging helpers.
// The helpers merge the server's first done page with the deeper pages the
// client loaded via "Load more" — the backend pages the done column
// (done_pagination) and orders it newest-completed-first.

const PLUGIN_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../plugins/kanban/dashboard/dist/index.js',
)

function loadPlugin({ withTestSeam = true }: { withTestSeam?: boolean } = {}) {
  const registered: Array<[string, unknown]> = []

  const window: Record<string, unknown> = {
    __HERMES_PLUGIN_SDK__: {
      React: {
        createElement: () => null,
        // The plugin defines `class ErrorBoundary extends React.Component`.
        Component: class {},
      },
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
      hooks: {},
      utils: {},
    },
    __HERMES_PLUGINS__: {
      register: (name: string, page: unknown) => registered.push([name, page]),
    },
    __HERMES_KANBAN_TEST__: withTestSeam,
  }

  const source = readFileSync(PLUGIN_PATH, 'utf8')

  // The plugin reads `window` as a bare global (classic script in the host
  // page) — publish the stub on globalThis for the IIFE run.
  ;(globalThis as unknown as { window: unknown }).window = window
  vm.runInThisContext(source, { filename: PLUGIN_PATH })

  return { window, registered }
}

const task = (id: string, completedAt: number | null = null) => ({
  id,
  completed_at: completedAt,
})

describe('kanban dashboard done-column paging', () => {
  const helpers = loadPlugin().window.__HERMES_KANBAN_TEST_HELPERS__ as {
    mergeDoneTasks: (first: unknown, extra: unknown) => Array<{ id: string; completed_at: number | null }>
    donePagingState: (pagination: unknown, merged: unknown[]) => { total: number; loaded: number; hasMore: boolean }
    withMergedDoneColumn: (board: unknown, extra: unknown[]) => { columns: Array<{ name: string; tasks: Array<{ id: string }> }> } & Record<string, unknown>
    pruneExtraDoneTasks: (extra: unknown, ids: Set<string>) => Array<{ id: string }>
    doneWindowKey: (board: string | null | undefined, taskId: string) => string
    withOptimisticMove: (board: any, ids: Set<string>, newStatus: string, extraDone: any[]) => any
    createFetchGate: () => {
      current: () => number
      reset: () => number
      accepts: (token: number) => boolean
    }
    createScopeGeneration: () => {
      current: () => number
      bump: () => number
      accepts: (token: number) => boolean
    }
  }

  it('registers the kanban page against the plugin host', () => {
    const { registered } = loadPlugin()
    expect(registered).toHaveLength(1)
    expect(registered[0][0]).toBe('kanban')
    expect(typeof registered[0][1]).toBe('function')
  })

  it('mergeDoneTasks dedupes pages by id and orders newest-completed-first, nulls last', () => {
    const firstPage = [task('t1', 300), task('t2', 200), task('t3', null)]
    const extra = [task('t2', 200), task('t0', 400), task('t9', null, )]
    const merged = helpers.mergeDoneTasks(firstPage, extra)
    expect(merged.map((t) => t.id)).toEqual(['t0', 't1', 't2', 't9', 't3'])
  })

  it('mergeDoneTasks breaks ties on id DESC and survives empty inputs', () => {
    expect(
      helpers.mergeDoneTasks([task('a', 100), task('b', 100)], []).map((t) => t.id),
    ).toEqual(['b', 'a'])
    expect(helpers.mergeDoneTasks([], [])).toEqual([])
    expect(helpers.mergeDoneTasks(undefined, undefined)).toEqual([])
  })

  it('donePagingState reports loaded/hasMore against the server total', () => {
    // 120 done tasks on the server, client holds 50 → more to load.
    expect(helpers.donePagingState({ total: 120, offset: 0, limit: 50 }, Array(50).fill(task('x'))))
      .toEqual({ total: 120, loaded: 50, hasMore: true })
    // Everything loaded → no more.
    expect(helpers.donePagingState({ total: 50, offset: 0, limit: 50 }, Array(50).fill(task('x'))))
      .toEqual({ total: 50, loaded: 50, hasMore: false })
    // Holding more than the server reports (history pruned) never over-reports.
    expect(helpers.donePagingState({ total: 10, offset: 0, limit: 50 }, Array(50).fill(task('x'))))
      .toEqual({ total: 10, loaded: 10, hasMore: false })
    // No pagination payload (older backend) → nothing more to load.
    expect(helpers.donePagingState(null, [task('x')]))
      .toEqual({ total: 1, loaded: 1, hasMore: false })
  })

  it('withMergedDoneColumn merges only the done column and preserves the rest of the payload', () => {
    const board = {
      columns: [
        { name: 'todo', tasks: [task('keep-todo')] },
        { name: 'done', tasks: [task('d1', 300)] },
      ],
      tenants: ['infra'],
      done_pagination: { total: 3, offset: 0, limit: 50 },
    }

    const merged = helpers.withMergedDoneColumn(board, [task('d2', 400)])
    expect(merged.tenants).toEqual(['infra'])
    expect(merged.columns.find((c) => c.name === 'todo')!.tasks).toEqual([task('keep-todo')])
    expect(merged.columns.find((c) => c.name === 'done')!.tasks.map((t) => t.id))
      .toEqual(['d2', 'd1'])
    // Original board untouched.
    expect(board.columns.find((c) => c.name === 'done')!.tasks).toHaveLength(1)
    // Null/shapeless payloads pass through.
    expect(helpers.withMergedDoneColumn(null, [])).toBeNull()
  })

  it('pruneExtraDoneTasks drops moved ids from the held extra pages and keeps the rest', () => {
    const extra = [task('d2', 400), task('d3', 300), task('d4', 200)]
    // Single move: only that id leaves the extras.
    expect(helpers.pruneExtraDoneTasks(extra, new Set(['d3'])).map((t) => t.id))
      .toEqual(['d2', 'd4'])
    // Bulk move: every moved id leaves, order of the survivors is kept.
    expect(helpers.pruneExtraDoneTasks(extra, new Set(['d2', 'd4'])).map((t) => t.id))
      .toEqual(['d3'])
    // Ids that are not held are a no-op; empty/missing id sets never mutate.
    expect(helpers.pruneExtraDoneTasks(extra, new Set(['nope']))).toEqual(extra)
    expect(helpers.pruneExtraDoneTasks(extra, new Set())).toEqual(extra)
    expect(helpers.pruneExtraDoneTasks(null, new Set(['d1']))).toEqual([])
    // Entries without an id survive (defensive: merge ignores them too).
    expect(helpers.pruneExtraDoneTasks([{ noId: true } as { id?: string }], new Set(['d1'])))
      .toEqual([{ noId: true }])
  })

  it('doneWindowKey scopes window counters per board so cross-board id collisions never meet', () => {
    // Task ids are unique only within one board's db (one kanban_db file per
    // board) — the key must carry the board so board A's late delete success
    // can never close board B's restore window for a colliding id.
    expect(helpers.doneWindowKey('default', 'd2')).toBe('default:d2')
    expect(helpers.doneWindowKey('board-b', 'd2')).toBe('board-b:d2')
    expect(helpers.doneWindowKey('default', 'd2')).not.toBe(helpers.doneWindowKey('board-b', 'd2'))
    // Missing board slug (never expected at runtime) still keys per taskId.
    expect(helpers.doneWindowKey(null, 'd2')).toBe(':d2')
    expect(helpers.doneWindowKey(undefined, 'd2')).toBe(':d2')
  })

  it('withOptimisticMove moves raw-column and extra-page cards into the destination', () => {
    const openTaskShape = (id: string) => ({ id, status: 'todo', title: id, completed_at: null })

    const board = {
      columns: [
        { name: 'todo', tasks: [openTaskShape('t1')] },
        { name: 'done', tasks: [task('d1', 300)] },
      ],
    }

    const extra = [task('d2', 200)]

    // Bulk: both a raw-column card (d1) and an extra-page-only card (d2).
    const moved = helpers.withOptimisticMove(board, new Set(['d1', 'd2']), 'todo', extra)
    const col = (name: string) => moved.columns.find((c: any) => c.name === name)
    expect(col('done').tasks.map((t: any) => t.id)).toEqual([])
    expect(col('todo').tasks.map((t: any) => t.id)).toEqual(['d1', 'd2', 't1']) // prepended
    expect(col('todo').tasks.map((t: any) => t.status)).toEqual(['todo', 'todo', 'todo'])
    // Original board untouched.
    expect(board.columns.find((c: any) => c.name === 'done')!.tasks).toHaveLength(1)

    // Single id that lives only in the extras lands in the destination too.
    const single = helpers.withOptimisticMove(board, new Set(['d2']), 'todo', extra)
    expect(single.columns.find((c: any) => c.name === 'done')!.tasks.map((t: any) => t.id)).toEqual(['d1'])
    expect(single.columns.find((c: any) => c.name === 'todo')!.tasks.map((t: any) => t.id)).toEqual(['d2', 't1'])

    // Missing destination column is a no-op on the payload (still prunes).
    const noDest = helpers.withOptimisticMove(
      { columns: [{ name: 'done', tasks: [task('d1', 300)] }] },
      new Set(['d1']), 'archive', [],
    )

    expect(noDest.columns.find((c: any) => c.name === 'done')!.tasks).toEqual([])

    // Shapeless payloads pass through; no ids → no change.
    expect(helpers.withOptimisticMove(null, new Set(['d1']), 'todo', [])).toBeNull()
    const unchanged = helpers.withOptimisticMove(board, new Set(), 'todo', extra)
    expect(unchanged.columns.find((c: any) => c.name === 'done')!.tasks).toHaveLength(1)
  })

  it('done page gate discards responses that land after a scope reset (race)', () => {
    const gate = helpers.createFetchGate()

    // Request starts under generation 0 and resolves before any switch — applied.
    const freshToken = gate.current()
    expect(gate.accepts(freshToken)).toBe(true)

    // Scope switch (board / tenant / archived filter) resets the gate: every
    // request that was in flight at reset time must be rejected, including
    // one that started before an earlier reset.
    const staleEarly = gate.current()
    expect(gate.reset()).toBe(1)
    const staleLate = gate.current()
    expect(gate.reset()).toBe(2)

    expect(gate.accepts(staleEarly)).toBe(false)
    expect(gate.accepts(staleLate)).toBe(false)

    // A request made AFTER the reset belongs to the current scope — applied.
    const currentToken = gate.current()
    expect(gate.accepts(currentToken)).toBe(true)

    // The next switch invalidates only the requests outstanding at that time.
    expect(gate.reset()).toBe(3)
    expect(gate.accepts(currentToken)).toBe(false)
    expect(gate.accepts(staleEarly)).toBe(false)
  })

  it('scope generation only moves on explicit bumps (restore guard semantics)', () => {
    const scope = helpers.createScopeGeneration()

    // A failed-write restore captured now stays valid — unlike the fetch
    // gate, NOTHING bumps the scope generation implicitly: same-scope
    // membership mutations and WS events about other cards must not suppress
    // the restore (the card is still done and would otherwise vanish).
    const writeScope = scope.current()
    expect(scope.accepts(writeScope)).toBe(true)

    // Only a real scope switch (board / tenant / archive filter) bumps it.
    scope.bump()
    expect(scope.accepts(writeScope)).toBe(false)

    // A restore captured under the new scope is valid again.
    const nextScope = scope.current()
    expect(scope.accepts(nextScope)).toBe(true)
    expect(scope.bump()).toBe(2)
    expect(scope.accepts(nextScope)).toBe(false)
  })
})
