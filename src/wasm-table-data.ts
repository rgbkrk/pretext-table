/**
 * Creates a TableData backed by the nteract-predicate WASM data store.
 *
 * Data lives in WASM memory — no JS string[][]/unknown[][] materialization.
 * getCell/getCellRaw call into WASM synchronously (module must be pre-loaded).
 */
import { getModuleSync } from './predicate'
import type { TableData, Column, ColumnType } from './table'
import { formatCell } from './accumulators'

/** Map WASM col_type strings to our ColumnType */
function mapColType(wasmType: string): ColumnType {
  switch (wasmType) {
    case 'numeric': return 'numeric'
    case 'boolean': return 'boolean'
    case 'timestamp': return 'timestamp'
    default: return 'categorical'
  }
}

/** Guess a reasonable default width for a column */
function autoWidth(name: string, colType: ColumnType): number {
  if (colType === 'boolean') return 100
  if (colType === 'timestamp') return 140
  if (colType === 'numeric') return 120
  return Math.max(100, Math.min(250, name.length * 12 + 40))
}

export type WasmTableHandle = {
  handle: number
  tableData: TableData
  columns: Column[]
}

/**
 * Build a TableData from a WASM store handle.
 * The module must already be initialized (call ensureModule() first).
 */
export function createWasmTableData(handle: number): WasmTableHandle {
  const mod = getModuleSync()

  const numRows = mod.num_rows(handle)
  const numCols = mod.num_cols(handle)
  const names: string[] = mod.col_names(handle)

  const columns: Column[] = []
  for (let c = 0; c < numCols; c++) {
    const wasmType = mod.col_type(handle, c)
    const colType = mapColType(wasmType)
    columns.push({
      key: names[c],
      label: names[c],
      width: autoWidth(names[c], colType),
      sortable: true,
      numeric: colType === 'numeric',
      columnType: colType,
    })
  }

  const tableData: TableData = {
    columns,
    rowCount: numRows,
    getCell(row: number, col: number): string {
      if (mod.is_null(handle, row, col)) return ''
      const colType = columns[col].columnType
      if (colType === 'boolean') {
        // WASM returns "Yes"/"No" for booleans already
        return mod.get_cell_string(handle, row, col)
      }
      if (colType === 'timestamp') {
        // Format timestamp from f64 epoch ms
        const v = mod.get_cell_f64(handle, row, col)
        if (Number.isFinite(v)) {
          return formatCell('timestamp', v)
        }
        return mod.get_cell_string(handle, row, col)
      }
      return mod.get_cell_string(handle, row, col)
    },
    getCellRaw(row: number, col: number): unknown {
      if (mod.is_null(handle, row, col)) return null
      const colType = columns[col].columnType
      if (colType === 'numeric' || colType === 'timestamp') {
        return mod.get_cell_f64(handle, row, col)
      }
      if (colType === 'boolean') {
        return mod.get_cell_string(handle, row, col) === 'Yes'
      }
      return mod.get_cell_string(handle, row, col)
    },
    columnSummaries: columns.map(() => null),
  }

  return { handle, tableData, columns }
}
