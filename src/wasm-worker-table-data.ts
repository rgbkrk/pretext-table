/**
 * Creates a TableData backed by the WASM web worker.
 *
 * Similar to wasm-table-data.ts but all WASM calls go through the worker proxy.
 * The main thread only does DOM rendering.
 *
 * EXPERIMENT NOTES:
 * - The synchronous getCell/getCellRaw methods are the hard part.
 *   The table engine calls these synchronously during render.
 *   We prefetch viewport data into a cache (same as wasm-table-data.ts)
 *   but the prefetch itself is now async (worker round-trip).
 * - Sort and filter operations return Uint32Array via transferable buffers.
 * - Summary computation happens entirely in the worker.
 *
 * Key limitation: sortColumn() and filterRows() are synchronous in the
 * TableData interface but async with workers. We handle this by making
 * them return a promise-backed result — the table engine needs to be
 * adapted to await these, OR we cache sort/filter results eagerly.
 *
 * For this experiment, we use a "sync bridge" pattern: we pre-compute
 * sort indices and cache them, and the synchronous sortColumn() returns
 * from cache. Filter/summary recomputation is async and triggers re-render.
 */

import { tableFromIPC } from 'apache-arrow'
import type { WasmWorkerProxy } from './wasm-worker-proxy'
import type { TableData, Column, ColumnType, ColumnFilter } from './table'
import type { FilterSpecJson } from './predicate'
import { formatCell } from './accumulators'
import { autoWidth } from './auto-width'

/** Map WASM col_type strings to our ColumnType */
function mapColType(wasmType: string): ColumnType {
  switch (wasmType) {
    case 'numeric': return 'numeric'
    case 'boolean': return 'boolean'
    case 'timestamp': return 'timestamp'
    default: return 'categorical'
  }
}

export type WorkerTableHandle = {
  handle: number
  tableData: TableData
  columns: Column[]
  /** Async prefetch — must be awaited before render */
  prefetchViewportAsync: (dataRowIndices: number[]) => Promise<void>
}

/**
 * Build TableData from a worker-owned WASM store handle.
 *
 * This function is async because it queries the worker for column metadata.
 */
export async function createWorkerTableData(
  proxy: WasmWorkerProxy,
  handle: number,
): Promise<WorkerTableHandle> {
  const numRows = await proxy.numRows(handle)
  const numCols = await proxy.numCols(handle)
  const names = await proxy.colNames(handle)

  // Get column types in parallel
  const typePromises = Array.from({ length: numCols }, (_, c) => proxy.colType(handle, c))
  const wasmTypes = await Promise.all(typePromises)

  const columns: Column[] = []
  for (let c = 0; c < numCols; c++) {
    const colType = mapColType(wasmTypes[c])
    columns.push({
      key: names[c],
      label: names[c],
      width: autoWidth(names[c], colType),
      sortable: true,
      numeric: colType === 'numeric',
      columnType: colType,
    })
  }

  // Viewport cache (same pattern as wasm-table-data.ts)
  const cache = new Map<number, { strings: string[]; raws: unknown[] }>()

  async function prefetchViewportAsync(dataRowIndices: number[]): Promise<void> {
    if (dataRowIndices.length === 0) return

    const uncached = dataRowIndices.filter(r => !cache.has(r))
    if (uncached.length === 0) return

    const indices = new Uint32Array(uncached)
    const ipcBytes = await proxy.getViewportByIndices(handle, indices)
    const table = tableFromIPC(ipcBytes)

    for (let i = 0; i < uncached.length; i++) {
      const dataRow = uncached[i]
      const strings: string[] = []
      const raws: unknown[] = []

      for (let c = 0; c < numCols; c++) {
        const col = table.getChildAt(c)!
        const val = col.get(i)
        const colType = columns[c].columnType

        if (val == null) {
          strings.push('')
          raws.push(null)
        } else if (colType === 'boolean') {
          const boolVal = typeof val === 'boolean' ? val : Boolean(val)
          strings.push(boolVal ? 'Yes' : 'No')
          raws.push(boolVal)
        } else if (colType === 'timestamp') {
          const numVal = typeof val === 'bigint' ? Number(val) : Number(val)
          strings.push(formatCell('timestamp', numVal))
          raws.push(numVal)
        } else if (colType === 'numeric') {
          const numVal = typeof val === 'bigint' ? Number(val) : Number(val)
          strings.push(String(val))
          raws.push(numVal)
        } else {
          strings.push(String(val))
          raws.push(val)
        }
      }

      cache.set(dataRow, { strings, raws })
    }
  }

  // Sort index cache: pre-computed when sort is requested
  // The table engine expects sortColumn to be synchronous, so we use a
  // "request then re-render" pattern: sortColumn() triggers async work
  // and returns a placeholder, then the engine is notified to re-render.
  let cachedSortIndices: Uint32Array | null = null

  const tableData: TableData = {
    columns,
    rowCount: numRows,
    getCell(row: number, col: number): string {
      const cached = cache.get(row)
      if (cached) return cached.strings[col]
      // No fallback — viewport should always be prefetched.
      // Return empty string to avoid blocking the main thread.
      return ''
    },
    getCellRaw(row: number, col: number): unknown {
      const cached = cache.get(row)
      if (cached) return cached.raws[col]
      return null
    },
    columnSummaries: columns.map(() => null),

    // Sort: synchronous interface backed by cached async result.
    // The caller must call prefetchSort() before expecting valid results.
    sortColumn(_colIndex: number, _ascending: boolean): Uint32Array {
      if (cachedSortIndices) return cachedSortIndices
      // If no cached result, return identity (unsorted)
      const identity = new Uint32Array(numRows)
      for (let i = 0; i < numRows; i++) identity[i] = i
      return identity
    },

    // Filter: similar pattern — synchronous interface, async backing
    filterRows(filters: (ColumnFilter | null)[]): Uint32Array {
      // This is a synchronous fallback — the real filtering should be
      // done via prefetchFilter() before this is called
      const specs: FilterSpecJson[] = []
      for (let c = 0; c < filters.length; c++) {
        const f = filters[c]
        if (!f) continue
        switch (f.kind) {
          case 'range':
            specs.push({ kind: 'range', col: c, min: f.min, max: f.max })
            break
          case 'set':
            specs.push({ kind: 'set', col: c, values: Array.from(f.values) })
            break
          case 'boolean':
            specs.push({ kind: 'boolean', col: c, value: f.value })
            break
        }
      }
      // Return empty — the async path should handle this
      return new Uint32Array(0)
    },

    // Cast operations — these modify worker state
    castColumn(colIndex: number, targetType: ColumnType) {
      // Fire and forget — the async version should be used
      proxy.castColumn(handle, colIndex, targetType).then(() => {
        cache.clear()
        columns[colIndex].columnType = targetType
        columns[colIndex].numeric = targetType === 'numeric'
      })
    },
    undoCastColumn(colIndex: number): ColumnType {
      // Sync stub — returns current type, async updates later
      const current = columns[colIndex].columnType
      proxy.undoCastColumn(handle, colIndex).then(originalType => {
        cache.clear()
        columns[colIndex].columnType = originalType as ColumnType
        columns[colIndex].numeric = originalType === 'numeric'
      })
      return current
    },
    isColumnCast(_colIndex: number): boolean {
      // This needs to be sync — cache the result
      return false // TODO: cache from worker
    },
  }

  return { handle, tableData, columns, prefetchViewportAsync }
}

/**
 * Compute summaries from the worker and update tableData.
 * Fully async — returns when all summaries are computed.
 */
export async function updateWorkerSummaries(
  proxy: WasmWorkerProxy,
  handle: number,
  tableData: TableData,
  columns: Column[],
  pandasIndexCols?: Set<string>,
): Promise<void> {
  const numRows = await proxy.numRows(handle)
  const BIN_COUNT = 25

  tableData.rowCount = numRows

  // Compute all column summaries in parallel
  const summaryPromises = columns.map(async (col, c) => {
    switch (col.columnType) {
      case 'categorical': {
        const counts = await proxy.storeValueCounts(handle, c)
        const allCategories = counts.map(({ label, count }) => ({
          label, count,
          pct: Math.round((count / numRows) * 1000) / 10,
        }))
        const topCategories = allCategories.slice(0, 3)
        const othersCount = counts.slice(3).reduce((s, e) => s + e.count, 0)
        const othersPct = Math.round((othersCount / numRows) * 1000) / 10
        const lengths = counts.map(({ label }) => label.length).sort((a, b) => a - b)
        const medianTextLength = lengths.length > 0 ? lengths[Math.floor(lengths.length / 2)] : 0
        return {
          kind: 'categorical' as const,
          uniqueCount: counts.length,
          topCategories,
          othersCount,
          othersPct,
          allCategories,
          medianTextLength,
        }
      }
      case 'boolean': {
        const [trueCount, falseCount, nullCount] = await proxy.storeBoolCounts(handle, c)
        return {
          kind: 'boolean' as const,
          trueCount,
          falseCount,
          nullCount,
          total: numRows,
        }
      }
      case 'numeric':
      case 'timestamp': {
        const bins = await proxy.storeHistogram(handle, c, BIN_COUNT)
        if (bins.length === 0) return null
        const totalInBins = bins.reduce((s, b) => s + b.count, 0)
        const nullCount = numRows - totalInBins
        const summary: {
          kind: 'numeric' | 'timestamp';
          min: number; max: number;
          bins: typeof bins;
          uniqueCount?: number;
          nullCount?: number;
          isIndex?: boolean;
        } = {
          kind: col.columnType as 'numeric' | 'timestamp',
          min: bins[0].x0,
          max: bins[bins.length - 1].x1,
          bins,
          nullCount: nullCount > 0 ? nullCount : undefined,
        }
        if (col.columnType === 'numeric') {
          const nonZeroBins = bins.filter(b => b.count > 0).length
          if (nonZeroBins <= 10) {
            summary.uniqueCount = nonZeroBins
          }
          const isPandasIndex = pandasIndexCols?.has(col.key) ?? false
          const isIndexName = /^(unnamed[: _]*\d*|index|_?id|rowid|row_?id|row_?num)$/i.test(col.key)
          if (isPandasIndex || isIndexName) {
            summary.isIndex = true
          }
        }
        return summary
      }
    }
  })

  const summaries = await Promise.all(summaryPromises)
  tableData.columnSummaries = summaries
}
