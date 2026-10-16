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
})
