import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import DatabaseWorkspace from '../index.vue'
import { useDatabaseWorkspaceStore } from '@/store/databaseWorkspaceStore'

vi.hoisted(() => {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear()
    }
  })
})

// markdownRenderer imports monaco-editor/esm/vs/editor/editor.all.js which calls
// document.queryCommandSupported — not available in jsdom. Stub it out entirely.
vi.mock('@views/components/AiTab/components/format/markdownRenderer.vue', () => ({
  default: { template: '<div class="markdown-renderer-stub"></div>' }
}))

// Replace the real Monaco-backed SQL editor with a textarea stub so we don't
// have to boot Monaco inside jsdom.
vi.mock('../components/SqlMonacoEditor.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: { modelValue: { type: String, default: '' } },
      emits: ['update:modelValue', 'run'],
      setup(props, { emit, expose }) {
        const getText = () => (props as { modelValue?: string }).modelValue ?? ''
        expose({
          getText,
          getSelectedText: () => '',
          getTextUntilCursor: () => getText(),
          getCurrentStatement: () => getText(),
          insertAtCursor: (text: string) => emit('update:modelValue', `${getText()}${text}`),
          replaceSelection: (text: string) => emit('update:modelValue', text),
          replaceAll: (text: string) => emit('update:modelValue', text),
          focus: () => {}
        })
        return () =>
          h('textarea', {
            class: 'fake-monaco',
            value: (props as { modelValue?: string }).modelValue,
            onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value)
          })
      }
    })
  }
})

// Mirror icon names used across the SQL workspace so we don't fail on missing
// exports while booting Ant Design icons in jsdom.
vi.mock('@ant-design/icons-vue', () => {
  const make = (name: string) => ({
    name,
    template: `<span class="${name.toLowerCase()}" />`
  })
  return {
    AlignLeftOutlined: make('AlignLeftOutlined'),
    BulbOutlined: make('BulbOutlined'),
    CaretDownOutlined: make('CaretDownOutlined'),
    CaretRightOutlined: make('CaretRightOutlined'),
    CaretUpOutlined: make('CaretUpOutlined'),
    CloseOutlined: make('CloseOutlined'),
    DatabaseOutlined: make('DatabaseOutlined'),
    DownOutlined: make('DownOutlined'),
    FilterOutlined: make('FilterOutlined'),
    FolderOpenOutlined: make('FolderOpenOutlined'),
    FolderOutlined: make('FolderOutlined'),
    LinkOutlined: make('LinkOutlined'),
    PauseCircleOutlined: make('PauseCircleOutlined'),
    PlayCircleOutlined: make('PlayCircleOutlined'),
    PlusOutlined: make('PlusOutlined'),
    ReloadOutlined: make('ReloadOutlined'),
    RightOutlined: make('RightOutlined'),
    SaveOutlined: make('SaveOutlined'),
    SearchOutlined: make('SearchOutlined'),
    SettingOutlined: make('SettingOutlined'),
    StepForwardOutlined: make('StepForwardOutlined'),
    SwapOutlined: make('SwapOutlined'),
    TableOutlined: make('TableOutlined'),
    TeamOutlined: make('TeamOutlined'),
    DisconnectOutlined: make('DisconnectOutlined'),
    ThunderboltOutlined: make('ThunderboltOutlined'),
    VerticalAlignBottomOutlined: make('VerticalAlignBottomOutlined')
  }
})

// vue-i18n: just return the key to keep assertions deterministic.
vi.mock('vue-i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('vue-i18n')>()
  return {
    ...actual,
    useI18n: () => ({
      t: (key: string, args?: Record<string, unknown>) => {
        if (args && args.count !== undefined) return `${key}:${args.count}`
        return key
      }
    })
  }
})

const mountWorkspace = () =>
  mount(DatabaseWorkspace, {
    global: {
      stubs: {
        'a-input': {
          props: ['value'],
          emits: ['update:value'],
          template: '<input class="a-input" :value="value" @input="$emit(\'update:value\', $event.target.value)" />'
        },
        'a-input-password': {
          props: ['value'],
          emits: ['update:value'],
          template: '<input class="a-input-password" type="password" :value="value" @input="$emit(\'update:value\', $event.target.value)" />'
        },
        'a-input-number': {
          props: ['value'],
          emits: ['update:value'],
          template: '<input class="a-input-number" type="number" :value="value" @input="$emit(\'update:value\', Number($event.target.value))" />'
        },
        'a-select': {
          props: ['value'],
          emits: ['update:value'],
          template: '<div class="a-select"><slot /></div>'
        },
        'a-select-option': {
          template: '<div class="a-select-option"><slot /></div>'
        },
        'a-button': {
          template: '<button class="a-button" @click="$emit(\'click\')"><slot /></button>',
          emits: ['click']
        },
        'a-modal': {
          props: ['open'],
          template: '<div v-if="open" class="a-modal"><slot /></div>'
        }
      },
      mocks: {
        $t: (key: string, args?: Record<string, unknown>) => {
          if (args && args.count !== undefined) return `${key}:${args.count}`
          return key
        }
      }
    }
  })

describe('SqlWorkspace integration', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Attach the IPC surface without replacing the jsdom window object:
    // replacing it would destroy constructors such as Event that
    // @vue/test-utils uses to synthesize DOM events.
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      dbAssetList: vi.fn(async () => []),
      dbAssetExecuteQuery: vi.fn(async () => ({
        ok: true,
        columns: ['a'],
        rows: [{ a: 1 }],
        rowCount: 1,
        durationMs: 7
      }))
    }
  })

  it('+ button opens a new Query tab', async () => {
    const wrapper = mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    await wrapper.find('.db-tabs__add').trigger('click')
    expect(store.activeTab).toMatchObject({ kind: 'sql', title: 'Query 1' })
  })

  it('Run creates a result tab and appends a history entry on success', async () => {
    mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    store.setSqlTabContext(store.activeTab!.id, 'a1', 'db1')
    store.activeTab!.sql = 'SELECT 1'
    await nextTick()

    await store.runSqlOnActiveTab('all', 'SELECT 1')

    expect(store.activeTab!.resultTabs).toHaveLength(1)
    expect(store.activeTab!.history).toHaveLength(1)
    expect(store.activeTab!.history![0].status).toBe('ok')
  })

  // Regression: after Run resolves, the result tab's UI must reflect the
  // final 'ok' / 'error' status without requiring the user to switch tabs
  // away and back. The previous bug: the action kept a local reference to
  // the raw `resultTab` object it pushed into `tab.resultTabs`; Vue/Pinia
  // proxy-wraps the array slot, so field writes via the local variable
  // bypassed the reactive proxy and templates only updated once an
  // unrelated re-render pulled a fresh reference out of the proxied array.
  it('updates the result tab UI to ok immediately after Run resolves', async () => {
    const wrapper = mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    store.setSqlTabContext(store.activeTab!.id, 'a1', 'db1')
    await nextTick()

    await store.runSqlOnActiveTab('all', 'SELECT 1')
    await nextTick()

    // Status in the reactive store must be 'ok'. This catches the case
    // where the local variable was mutated but the proxied array element
    // was left at 'running'.
    const statusInStore = store.activeTab!.resultTabs![0].status
    expect(statusInStore).toBe('ok')

    // DOM-level assertion: the "running" placeholder must not be rendered,
    // and the result grid must be mounted.
    const runningEl = wrapper.find('.sql-workspace__status')
    // An empty match is fine; a rendered element whose text maps to the
    // sqlRunning i18n key is the failure signal.
    if (runningEl.exists()) {
      expect(runningEl.text()).not.toContain('database.sqlRunning')
    }
    expect(wrapper.findComponent({ name: 'DatabaseResultPane' }).exists()).toBe(true)
  })

  it('updates the result tab UI to error immediately after a failed Run', async () => {
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      dbAssetList: vi.fn(async () => []),
      dbAssetExecuteQuery: vi.fn(async () => ({ ok: false, errorMessage: 'boom' }))
    }
    const wrapper = mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    store.setSqlTabContext(store.activeTab!.id, 'a1', 'db1')
    await nextTick()

    await store.runSqlOnActiveTab('all', 'SELECT 1')
    await nextTick()

    expect(store.activeTab!.resultTabs![0].status).toBe('error')
    expect(store.activeTab!.resultTabs![0].error).toBe('boom')
    const errorEl = wrapper.find('.sql-workspace__status--error')
    expect(errorEl.exists()).toBe(true)
    expect(errorEl.text()).toContain('boom')
  })

  const baseDbAsset = {
    id: 'a1',
    name: 'conn-1',
    group_id: null,
    group_name: null,
    db_type: 'postgresql' as const,
    host: '10.0.0.1',
    port: 5432,
    database_name: 'db1',
    schema_name: 'public',
    environment: 'Dev',
    ssl_mode: null,
    username: 'root',
    hasPassword: true,
    status: 'connected' as const
  }

  const seedErroredSqlResult = () => {
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    const tab = store.activeTab!
    store.setSqlTabContext(tab.id, 'a1', 'db1')
    tab.sql = 'select * from missing_table'
    tab.resultTabs = [
      {
        id: 'res-error',
        seq: 1,
        idx: 1,
        title: '#1-1 select bad',
        sql: 'select * from missing_table',
        status: 'error',
        columns: [],
        rows: [],
        rowCount: 0,
        durationMs: 1,
        error: 'relation missing_table does not exist',
        startedAt: Date.now()
      }
    ]
    tab.activeResultTabId = 'res-error'
    return { store, tab }
  }

  it('applies diagnose SQL to the originating tab when the source SQL is unchanged', async () => {
    let doneCb: ((ev: { reqId: string; action: string; ok: boolean; result?: { sql?: string } }) => void) | undefined
    let startedReq: { reqId: string } | undefined
    const start = vi.fn(async (req: unknown) => {
      startedReq = req as { reqId: string }
      return { ok: true, reqId: startedReq.reqId }
    })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      dbAssetList: vi.fn(async () => [baseDbAsset]),
      dbAssetExecuteQuery: vi.fn(),
      dbAi: {
        start,
        onStream: vi.fn(() => () => {}),
        onDone: vi.fn((cb: typeof doneCb) => {
          doneCb = cb
          return () => {}
        })
      }
    }
    const wrapper = mountWorkspace()
    await flushPromises()
    const { tab } = seedErroredSqlResult()
    await nextTick()

    await wrapper.find('.sql-workspace__ai-fix-btn').trigger('click')
    await flushPromises()
    doneCb?.({ reqId: startedReq!.reqId, action: 'diagnose', ok: true, result: { sql: 'select * from existing_table' } })
    await nextTick()

    expect(start).toHaveBeenCalledTimes(1)
    expect(tab.sql).toBe('select * from existing_table')
  })

  it('does not overwrite SQL edited after diagnose starts', async () => {
    let doneCb: ((ev: { reqId: string; action: string; ok: boolean; result?: { sql?: string } }) => void) | undefined
    let startedReq: { reqId: string } | undefined
    const start = vi.fn(async (req: unknown) => {
      startedReq = req as { reqId: string }
      return { ok: true, reqId: startedReq.reqId }
    })
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      dbAssetList: vi.fn(async () => [baseDbAsset]),
      dbAssetExecuteQuery: vi.fn(),
      dbAi: {
        start,
        onStream: vi.fn(() => () => {}),
        onDone: vi.fn((cb: typeof doneCb) => {
          doneCb = cb
          return () => {}
        })
      }
    }
    const wrapper = mountWorkspace()
    await flushPromises()
    const { tab } = seedErroredSqlResult()
    await nextTick()

    await wrapper.find('.sql-workspace__ai-fix-btn').trigger('click')
    await flushPromises()
    tab.sql = 'select * from user_edited_table'
    doneCb?.({ reqId: startedReq!.reqId, action: 'diagnose', ok: true, result: { sql: 'select * from existing_table' } })
    await nextTick()

    expect(start).toHaveBeenCalledTimes(1)
    expect(tab.sql).toBe('select * from user_edited_table')
    expect(wrapper.find('.sql-workspace__diagnose-error').text()).toContain('database.dbAi.diagnoseSqlChanged')
  })

  // -- Client-side pagination / sort / filter in the result grid ------------

  // Seed a sql tab whose active result already has `count` rows of shape
  // { a: <number> } so the grid has something to slice, sort, and filter.
  const seedResultTab = (count: number) => {
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    const tab = store.activeTab!
    store.setSqlTabContext(tab.id, 'a1', 'db1')
    const rows = Array.from({ length: count }, (_, i) => ({ a: i + 1 }))
    const resultTabId = 'res-seed'
    tab.resultTabs = [
      {
        id: resultTabId,
        seq: 1,
        idx: 1,
        title: `#1-1 select a`,
        sql: 'select a',
        status: 'ok',
        columns: ['a'],
        rows,
        rowCount: rows.length,
        durationMs: 3,
        error: null,
        startedAt: Date.now()
      }
    ]
    tab.activeResultTabId = resultTabId
    return { store, tab, resultTabId, rows }
  }

  it('renders DataGridToolbar with the correct total when a result is active', async () => {
    const wrapper = mountWorkspace()
    seedResultTab(250)
    await nextTick()
    const toolbar = wrapper.findComponent({ name: 'DataGridToolbar' })
    expect(toolbar.exists()).toBe(true)
    expect(toolbar.props('total')).toBe(250)
    expect(toolbar.props('pageSize')).toBe(100)
    expect(toolbar.props('page')).toBe(1)
  })

  it('changing page size re-paginates rows and keeps the page in range', async () => {
    const wrapper = mountWorkspace()
    seedResultTab(250)
    await nextTick()

    const toolbar = wrapper.findComponent({ name: 'DataGridToolbar' })
    const pane = wrapper.findComponent({ name: 'DatabaseResultPane' })
    // Default page size 100 → first page has 100 rows.
    expect((pane.props('rows') as unknown[]).length).toBe(100)

    toolbar.vm.$emit('changePageSize', 50)
    await nextTick()
    // 250 rows / 50 per page → 5 pages; still on page 1, first slice is 50.
    expect(toolbar.props('pageSize')).toBe(50)
    expect((pane.props('rows') as unknown[]).length).toBe(50)
  })

  it('sort and filter events drive client-side reshape of displayRows', async () => {
    const wrapper = mountWorkspace()
    seedResultTab(10) // rows a = 1..10
    await nextTick()
    const pane = wrapper.findComponent({ name: 'DatabaseResultPane' })

    // Sort descending by "a" → first row's a should be 10.
    pane.vm.$emit('sort', 'a', 'desc')
    await nextTick()
    const sorted = pane.props('rows') as Array<{ a: number }>
    expect(sorted[0].a).toBe(10)

    // Filter to a == "5" (string comparison, per matchesFilter).
    pane.vm.$emit('applyFilter', 'a', { column: 'a', operator: 'eq', value: '5' })
    await nextTick()
    const filtered = pane.props('rows') as Array<{ a: number }>
    expect(filtered.length).toBe(1)
    expect(filtered[0].a).toBe(5)
  })

  it('hides DataGridToolbar on the Overview pseudo tab', async () => {
    const wrapper = mountWorkspace()
    const { store, resultTabId } = seedResultTab(5)
    // Seeded state puts us on the real result tab; flip to Overview.
    store.setActiveResultTab(store.activeTab!.id, 'overview')
    void resultTabId
    await nextTick()
    const toolbar = wrapper.findComponent({ name: 'DataGridToolbar' })
    expect(toolbar.exists()).toBe(false)
  })

  it('applies a like filter emitted from the result grid', async () => {
    const wrapper = mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    const tab = store.activeTab!
    store.setSqlTabContext(tab.id, 'a1', 'db1')
    tab.resultTabs = [
      {
        id: 'res-like',
        seq: 1,
        idx: 1,
        title: '#1-1 select name',
        sql: 'select name',
        status: 'ok',
        columns: ['name'],
        rows: [{ name: 'foo-one' }, { name: 'bar-two' }, { name: 'FOO-three' }, { name: 'baz' }],
        rowCount: 4,
        durationMs: 1,
        error: null,
        startedAt: Date.now()
      }
    ]
    tab.activeResultTabId = 'res-like'
    await nextTick()

    const pane = wrapper.findComponent({ name: 'DatabaseResultPane' })
    pane.vm.$emit('applyFilter', 'name', { column: 'name', operator: 'like', value: 'foo' })
    await nextTick()

    const rows = pane.props('rows') as Array<{ name: string }>
    // matchesFilter is case-insensitive substring for `like`, so both
    // 'foo-one' and 'FOO-three' pass; 'bar-two' and 'baz' are filtered out.
    expect(rows.map((r) => r.name).sort()).toEqual(['FOO-three', 'foo-one'])
  })

  it('exposes a loadDistinct function that returns unique non-null column values', async () => {
    const wrapper = mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    const tab = store.activeTab!
    store.setSqlTabContext(tab.id, 'a1', 'db1')
    tab.resultTabs = [
      {
        id: 'res-distinct',
        seq: 1,
        idx: 1,
        title: '#1-1 distinct',
        sql: 'select color',
        status: 'ok',
        columns: ['color'],
        rows: [{ color: 'red' }, { color: 'blue' }, { color: 'red' }, { color: null }, { color: 'green' }, { color: 'blue' }],
        rowCount: 6,
        durationMs: 1,
        error: null,
        startedAt: Date.now()
      }
    ]
    tab.activeResultTabId = 'res-distinct'
    await nextTick()

    const pane = wrapper.findComponent({ name: 'DatabaseResultPane' })
    const loadDistinct = pane.props('loadDistinct') as (col: string) => Promise<string[]>
    expect(typeof loadDistinct).toBe('function')
    const values = await loadDistinct('color')
    expect(values).toEqual(['red', 'blue', 'green'])
  })

  // Toolbar button 2 (Run Current Statement) runs the statement under the
  // cursor — in the stub, that maps to the full editor text (the stub's
  // `getCurrentStatement` returns the same thing as `getText`). We verify by
  // inspecting the sql string the store handed to the IPC layer.
  it('Run Current Statement button sends the statement under the cursor', async () => {
    const executeSpy = vi.fn(async () => ({
      ok: true,
      columns: ['a'],
      rows: [{ a: 1 }],
      rowCount: 1,
      durationMs: 1
    }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      dbAssetList: vi.fn(async () => []),
      dbAssetExecuteQuery: executeSpy
    }

    const wrapper = mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    const tab = store.activeTab!
    store.setSqlTabContext(tab.id, 'a1', 'db1')
    tab.sql = 'SELECT 42'
    await nextTick()

    await wrapper.find('.sql-toolbar__run-current').trigger('click')
    await nextTick()

    expect(executeSpy).toHaveBeenCalledTimes(1)
    const firstCall = executeSpy.mock.calls[0] as unknown as Array<{ sql: string }>
    expect(firstCall[0].sql).toBe('SELECT 42')
  })

  // Toolbar button 3 (Explain) prefixes the current statement with EXPLAIN.
  it('Explain button prefixes the current statement with EXPLAIN', async () => {
    const executeSpy = vi.fn(async () => ({
      ok: true,
      columns: [],
      rows: [],
      rowCount: 0,
      durationMs: 1
    }))
    ;(window as unknown as { api: Record<string, unknown> }).api = {
      dbAssetList: vi.fn(async () => []),
      dbAssetExecuteQuery: executeSpy
    }

    const wrapper = mountWorkspace()
    const store = useDatabaseWorkspaceStore()
    store.openNewSqlTab()
    const tab = store.activeTab!
    store.setSqlTabContext(tab.id, 'a1', 'db1')
    tab.sql = 'SELECT 1'
    await nextTick()

    await wrapper.find('.sql-toolbar__explain').trigger('click')
    await nextTick()

    expect(executeSpy).toHaveBeenCalledTimes(1)
    const firstCall = executeSpy.mock.calls[0] as unknown as Array<{ sql: string }>
    expect(firstCall[0].sql).toBe('EXPLAIN SELECT 1')
  })
})
