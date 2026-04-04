/**
 * Main-thread proxy for the WASM web worker.
 *
 * Wraps postMessage/onmessage in a promise-based API that mirrors
 * the PredicateModule interface. The worker owns all WASM memory;
 * the main thread only receives serialized results.
 *
 * EXPERIMENT: Key trade-offs documented here:
 * - Transferable buffers (Uint8Array, Uint32Array) avoid copies for large data
 * - JSON-serializable results (summaries, metadata) use structured clone
 * - Every call has ~0.1-0.5ms message overhead (postMessage round-trip)
 * - Sort indices and filter results can be large — transfer is essential
 */

import type { WorkerResponse } from './wasm-worker'

export class WasmWorkerProxy {
  private worker: Worker
  private nextId = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()

  constructor(worker: Worker) {
    this.worker = worker
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const p = this.pending.get(msg.id)
      if (!p) return
      this.pending.delete(msg.id)
      if (msg.type === 'error') {
        p.reject(new Error(msg.message))
      } else {
        p.resolve(msg.result)
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private send(msg: Record<string, any>, transfer?: Transferable[]): Promise<unknown> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ ...msg, id }, transfer ?? [])
    })
  }

  async init(wasmUrl: string): Promise<void> {
    await this.send({ type: 'init', wasmUrl })
  }

  async loadParquet(parquetBytes: Uint8Array): Promise<number> {
    return this.send({ type: 'load_parquet', parquetBytes }) as Promise<number>
  }

  async parquetMetadata(parquetBytes: Uint8Array): Promise<number[]> {
    return this.send({ type: 'parquet_metadata', parquetBytes }) as Promise<number[]>
  }

  async parquetSchemaMetadata(parquetBytes: Uint8Array): Promise<Record<string, string>> {
    return this.send({ type: 'parquet_schema_metadata', parquetBytes }) as Promise<Record<string, string>>
  }

  async loadParquetRowGroup(parquetBytes: Uint8Array, rowGroup: number, handle: number): Promise<number> {
    return this.send({ type: 'load_parquet_row_group', parquetBytes, rowGroup, handle }) as Promise<number>
  }

  async loadIpc(ipcBytes: Uint8Array): Promise<number> {
    return this.send({ type: 'load_ipc', ipcBytes }) as Promise<number>
  }

  async numRows(handle: number): Promise<number> {
    return this.send({ type: 'num_rows', handle }) as Promise<number>
  }

  async numCols(handle: number): Promise<number> {
    return this.send({ type: 'num_cols', handle }) as Promise<number>
  }

  async colNames(handle: number): Promise<string[]> {
    return this.send({ type: 'col_names', handle }) as Promise<string[]>
  }

  async colType(handle: number, col: number): Promise<string> {
    return this.send({ type: 'col_type', handle, col }) as Promise<string>
  }

  async storeValueCounts(handle: number, col: number): Promise<{ label: string; count: number }[]> {
    return this.send({ type: 'store_value_counts', handle, col }) as Promise<{ label: string; count: number }[]>
  }

  async storeHistogram(handle: number, col: number, numBins: number): Promise<{ x0: number; x1: number; count: number }[]> {
    return this.send({ type: 'store_histogram', handle, col, numBins }) as Promise<{ x0: number; x1: number; count: number }[]>
  }

  async storeBoolCounts(handle: number, col: number): Promise<number[]> {
    return this.send({ type: 'store_bool_counts', handle, col }) as Promise<number[]>
  }

  async storeSortIndices(handle: number, col: number, ascending: boolean): Promise<Uint32Array> {
    return this.send({ type: 'store_sort_indices', handle, col, ascending }) as Promise<Uint32Array>
  }

  async storeFilteredValueCounts(handle: number, col: number, mask: Uint8Array): Promise<{ label: string; count: number }[]> {
    return this.send({ type: 'store_filtered_value_counts', handle, col, mask }) as Promise<{ label: string; count: number }[]>
  }

  async storeFilteredHistogram(handle: number, col: number, mask: Uint8Array, numBins: number): Promise<{ x0: number; x1: number; count: number }[]> {
    return this.send({ type: 'store_filtered_histogram', handle, col, mask, numBins }) as Promise<{ x0: number; x1: number; count: number }[]>
  }

  async storeFilteredBoolCounts(handle: number, col: number, mask: Uint8Array): Promise<number[]> {
    return this.send({ type: 'store_filtered_bool_counts', handle, col, mask }) as Promise<number[]>
  }

  async storeFilterRows(handle: number, filters: unknown[]): Promise<Uint32Array> {
    return this.send({ type: 'store_filter_rows', handle, filters }) as Promise<Uint32Array>
  }

  async getViewportByIndices(handle: number, indices: Uint32Array): Promise<Uint8Array> {
    return this.send({ type: 'get_viewport_by_indices', handle, indices }) as Promise<Uint8Array>
  }

  async castColumn(handle: number, col: number, targetType: string): Promise<void> {
    await this.send({ type: 'cast_column', handle, col, targetType })
  }

  async hasOriginalColumn(handle: number, col: number): Promise<boolean> {
    return this.send({ type: 'has_original_column', handle, col }) as Promise<boolean>
  }

  async undoCastColumn(handle: number, col: number): Promise<string> {
    return this.send({ type: 'undo_cast_column', handle, col }) as Promise<string>
  }

  async free(handle: number): Promise<void> {
    await this.send({ type: 'free', handle })
  }

  terminate(): void {
    this.worker.terminate()
    // Reject all pending promises
    for (const [, p] of this.pending) {
      p.reject(new Error('Worker terminated'))
    }
    this.pending.clear()
  }
}

/** Singleton worker proxy, created on first use */
let proxy: WasmWorkerProxy | null = null

/**
 * Get or create the WASM worker proxy.
 * The worker is lazily initialized — init() must be called before use.
 */
export function getWorkerProxy(): WasmWorkerProxy {
  if (proxy) return proxy

  // Vite handles ?worker imports, creating the worker bundle automatically
  const worker = new Worker(
    new URL('./wasm-worker.ts', import.meta.url),
    { type: 'module' },
  )
  proxy = new WasmWorkerProxy(worker)
  return proxy
}

/**
 * Initialize the WASM module inside the worker.
 * Must be called once before any other proxy methods.
 */
export async function initWorker(): Promise<WasmWorkerProxy> {
  const p = getWorkerProxy()
  // Resolve the WASM JS URL — same logic as predicate.ts ensureModule()
  const wasmUrl = import.meta.env.DEV
    ? new URL('../crates/nteract-predicate/pkg/nteract_predicate.js', import.meta.url).href
    : `${window.location.origin}${import.meta.env.BASE_URL}wasm/nteract_predicate.js`
  await p.init(wasmUrl)
  return p
}
