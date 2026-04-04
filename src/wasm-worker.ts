/**
 * Web Worker that owns the nteract-predicate WASM module.
 *
 * All WASM operations happen here, off the main thread.
 * The main thread communicates via postMessage with a request/response protocol.
 *
 * EXPERIMENT: This is exploratory. Key findings will be documented in the PR.
 *
 * Architecture notes:
 * - WASM memory lives entirely in the worker. Handles are opaque numbers.
 * - Data is serialized across the boundary as Uint8Array (transferable).
 * - For viewport access, the worker returns Arrow IPC bytes (transferable).
 * - Summaries are plain JSON objects (structured clone).
 */

// The worker needs to load the WASM module. In dev, Vite serves from crate source.
// In prod, it's at /wasm/nteract_predicate.js. We use importScripts or dynamic import.

type PredicateModule = {
  load_ipc(ipc_bytes: Uint8Array): number
  load_parquet(parquet_bytes: Uint8Array): number
  parquet_metadata(parquet_bytes: Uint8Array): Uint32Array
  parquet_schema_metadata(parquet_bytes: Uint8Array): Record<string, string>
  load_parquet_row_group(parquet_bytes: Uint8Array, row_group: number, handle: number): number
  cast_column(handle: number, col: number, target_type: string): void
  has_original_column(handle: number, col: number): boolean
  undo_cast_column(handle: number, col: number): string
  free(handle: number): void
  num_rows(handle: number): number
  num_cols(handle: number): number
  col_names(handle: number): string[]
  col_type(handle: number, col: number): string
  get_cell_string(handle: number, row: number, col: number): string
  get_cell_f64(handle: number, row: number, col: number): number
  is_null(handle: number, row: number, col: number): boolean
  store_value_counts(handle: number, col: number): { label: string; count: number }[]
  store_histogram(handle: number, col: number, num_bins: number): { x0: number; x1: number; count: number }[]
  store_bool_counts(handle: number, col: number): Uint32Array
  store_sort_indices(handle: number, col: number, ascending: boolean): Uint32Array
  store_filtered_value_counts(handle: number, col: number, mask: Uint8Array): { label: string; count: number }[]
  store_filtered_histogram(handle: number, col: number, mask: Uint8Array, num_bins: number): { x0: number; x1: number; count: number }[]
  store_filtered_bool_counts(handle: number, col: number, mask: Uint8Array): Uint32Array
  store_filter_rows(handle: number, filters: unknown[]): Uint32Array
  get_viewport_by_indices(handle: number, indices: Uint32Array): Uint8Array
}

let mod: PredicateModule | null = null

/** Message types from main thread → worker */
export type WorkerRequest =
  | { id: number; type: 'init'; wasmUrl: string }
  | { id: number; type: 'load_parquet'; parquetBytes: Uint8Array }
  | { id: number; type: 'parquet_metadata'; parquetBytes: Uint8Array }
  | { id: number; type: 'parquet_schema_metadata'; parquetBytes: Uint8Array }
  | { id: number; type: 'load_parquet_row_group'; parquetBytes: Uint8Array; rowGroup: number; handle: number }
  | { id: number; type: 'load_ipc'; ipcBytes: Uint8Array }
  | { id: number; type: 'num_rows'; handle: number }
  | { id: number; type: 'num_cols'; handle: number }
  | { id: number; type: 'col_names'; handle: number }
  | { id: number; type: 'col_type'; handle: number; col: number }
  | { id: number; type: 'store_value_counts'; handle: number; col: number }
  | { id: number; type: 'store_histogram'; handle: number; col: number; numBins: number }
  | { id: number; type: 'store_bool_counts'; handle: number; col: number }
  | { id: number; type: 'store_sort_indices'; handle: number; col: number; ascending: boolean }
  | { id: number; type: 'store_filtered_value_counts'; handle: number; col: number; mask: Uint8Array }
  | { id: number; type: 'store_filtered_histogram'; handle: number; col: number; mask: Uint8Array; numBins: number }
  | { id: number; type: 'store_filtered_bool_counts'; handle: number; col: number; mask: Uint8Array }
  | { id: number; type: 'store_filter_rows'; handle: number; filters: unknown[] }
  | { id: number; type: 'get_viewport_by_indices'; handle: number; indices: Uint32Array }
  | { id: number; type: 'cast_column'; handle: number; col: number; targetType: string }
  | { id: number; type: 'has_original_column'; handle: number; col: number }
  | { id: number; type: 'undo_cast_column'; handle: number; col: number }
  | { id: number; type: 'free'; handle: number }

/** Message types from worker → main thread */
export type WorkerResponse =
  | { id: number; type: 'ok'; result: unknown; transfer?: ArrayBuffer[] }
  | { id: number; type: 'error'; message: string }

const ctx = globalThis as unknown as Worker

async function initModule(wasmUrl: string): Promise<void> {
  // Dynamic import of the WASM JS glue code
  // In a worker, import.meta.url works, but we need the absolute URL
  const wasm = await import(/* @vite-ignore */ wasmUrl)
  await wasm.default()
  mod = wasm as unknown as PredicateModule
}

function ensureMod(): PredicateModule {
  if (!mod) throw new Error('WASM module not initialized in worker')
  return mod
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    let result: unknown
    const transfer: ArrayBuffer[] = []

    switch (msg.type) {
      case 'init': {
        await initModule(msg.wasmUrl)
        result = true
        break
      }
      case 'load_parquet': {
        result = ensureMod().load_parquet(msg.parquetBytes)
        break
      }
      case 'parquet_metadata': {
        const meta = ensureMod().parquet_metadata(msg.parquetBytes)
        // Copy to a plain array since Uint32Array backed by WASM memory
        result = Array.from(meta)
        break
      }
      case 'parquet_schema_metadata': {
        result = ensureMod().parquet_schema_metadata(msg.parquetBytes)
        break
      }
      case 'load_parquet_row_group': {
        result = ensureMod().load_parquet_row_group(msg.parquetBytes, msg.rowGroup, msg.handle)
        break
      }
      case 'load_ipc': {
        result = ensureMod().load_ipc(msg.ipcBytes)
        break
      }
      case 'num_rows': {
        result = ensureMod().num_rows(msg.handle)
        break
      }
      case 'num_cols': {
        result = ensureMod().num_cols(msg.handle)
        break
      }
      case 'col_names': {
        result = ensureMod().col_names(msg.handle)
        break
      }
      case 'col_type': {
        result = ensureMod().col_type(msg.handle, msg.col)
        break
      }
      case 'store_value_counts': {
        result = ensureMod().store_value_counts(msg.handle, msg.col)
        break
      }
      case 'store_histogram': {
        result = ensureMod().store_histogram(msg.handle, msg.col, msg.numBins)
        break
      }
      case 'store_bool_counts': {
        const counts = ensureMod().store_bool_counts(msg.handle, msg.col)
        result = Array.from(counts)
        break
      }
      case 'store_sort_indices': {
        const indices = ensureMod().store_sort_indices(msg.handle, msg.col, msg.ascending)
        // Transfer the buffer to avoid copying
        const copy = new Uint32Array(indices)
        transfer.push(copy.buffer as ArrayBuffer)
        result = copy
        break
      }
      case 'store_filtered_value_counts': {
        result = ensureMod().store_filtered_value_counts(msg.handle, msg.col, msg.mask)
        break
      }
      case 'store_filtered_histogram': {
        result = ensureMod().store_filtered_histogram(msg.handle, msg.col, msg.mask, msg.numBins)
        break
      }
      case 'store_filtered_bool_counts': {
        const counts = ensureMod().store_filtered_bool_counts(msg.handle, msg.col, msg.mask)
        result = Array.from(counts)
        break
      }
      case 'store_filter_rows': {
        const indices = ensureMod().store_filter_rows(msg.handle, msg.filters)
        const copy = new Uint32Array(indices)
        transfer.push(copy.buffer as ArrayBuffer)
        result = copy
        break
      }
      case 'get_viewport_by_indices': {
        const ipc = ensureMod().get_viewport_by_indices(msg.handle, msg.indices)
        // Copy out of WASM memory before transfer
        const copy = new Uint8Array(ipc)
        transfer.push(copy.buffer as ArrayBuffer)
        result = copy
        break
      }
      case 'cast_column': {
        ensureMod().cast_column(msg.handle, msg.col, msg.targetType)
        result = true
        break
      }
      case 'has_original_column': {
        result = ensureMod().has_original_column(msg.handle, msg.col)
        break
      }
      case 'undo_cast_column': {
        result = ensureMod().undo_cast_column(msg.handle, msg.col)
        break
      }
      case 'free': {
        ensureMod().free(msg.handle)
        result = true
        break
      }
    }

    const response: WorkerResponse = { id: msg.id, type: 'ok', result }
    ctx.postMessage(response, transfer)
  } catch (err) {
    const response: WorkerResponse = {
      id: msg.id,
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
    ctx.postMessage(response)
  }
}
