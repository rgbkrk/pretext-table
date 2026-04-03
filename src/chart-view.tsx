/**
 * Chart view — renders a full Semiotic chart from TableData.
 * Auto-detects the best chart type based on column types.
 */
import { createRoot, type Root } from 'react-dom/client'
import { BarChart } from 'semiotic/ordinal'
import { Scatterplot } from 'semiotic/xy'
import type { TableData } from './table'

type ChartSpec = {
  type: 'bar' | 'scatter' | 'none'
  xCol: number
  yCol: number
  xLabel: string
  yLabel: string
}

/** Pick the best default chart from column types */
function suggestChart(data: TableData): ChartSpec {
  const cols = data.columns
  const numericCols = cols.map((c, i) => ({ ...c, idx: i })).filter(c => c.columnType === 'numeric')
  const catCols = cols.map((c, i) => ({ ...c, idx: i })).filter(c => c.columnType === 'categorical')

  // 1 categorical + 1 numeric → bar chart
  if (catCols.length > 0 && numericCols.length > 0) {
    return {
      type: 'bar',
      xCol: catCols[0].idx,
      yCol: numericCols[0].idx,
      xLabel: catCols[0].label,
      yLabel: numericCols[0].label,
    }
  }

  // 2+ numeric → scatter
  if (numericCols.length >= 2) {
    return {
      type: 'scatter',
      xCol: numericCols[0].idx,
      yCol: numericCols[1].idx,
      xLabel: numericCols[0].label,
      yLabel: numericCols[1].label,
    }
  }

  return { type: 'none', xCol: 0, yCol: 0, xLabel: '', yLabel: '' }
}

function ChartView({ data, width, height }: {
  data: TableData
  width: number
  height: number
}) {
  const spec = suggestChart(data)
  const sampleSize = Math.min(500, data.rowCount)

  if (spec.type === 'none') {
    return <div style={{ padding: 40, textAlign: 'center', color: 'var(--muted)' }}>
      No suitable columns for charting
    </div>
  }

  if (spec.type === 'bar') {
    // Aggregate: count by category
    const counts = new Map<string, number>()
    for (let r = 0; r < sampleSize; r++) {
      const cat = data.getCell(r, spec.xCol)
      if (!cat) continue
      counts.set(cat, (counts.get(cat) || 0) + 1)
    }
    const chartData = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([label, count]) => ({ category: label, count }))

    return <BarChart
      data={chartData}
      categoryAccessor="category"
      valueAccessor="count"
      width={width}
      height={height}
      margin={{ top: 20, right: 20, bottom: 60, left: 60 }}
      color="var(--accent)"
      showGrid
      showCategoryTicks
      title={`${spec.xLabel} (top 20)`}
    />
  }

  if (spec.type === 'scatter') {
    const points: { x: number; y: number }[] = []
    for (let r = 0; r < sampleSize; r++) {
      const xRaw = data.getCellRaw(r, spec.xCol)
      const yRaw = data.getCellRaw(r, spec.yCol)
      if (xRaw == null || yRaw == null) continue
      const x = Number(xRaw)
      const y = Number(yRaw)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push({ x, y })
    }

    return <Scatterplot
      data={points}
      xAccessor="x"
      yAccessor="y"
      width={width}
      height={height}
      margin={{ top: 20, right: 20, bottom: 60, left: 60 }}
      color="var(--accent)"
      pointRadius={2}
      showGrid
      xLabel={spec.xLabel}
      yLabel={spec.yLabel}
    />
  }

  return null
}

let chartRoot: Root | null = null

export function mountChartView(container: HTMLElement, data: TableData) {
  const width = container.clientWidth
  const height = Math.max(400, container.clientHeight)

  if (!chartRoot) {
    chartRoot = createRoot(container)
  }
  chartRoot.render(<ChartView data={data} width={width} height={height} />)
}

export function unmountChartView() {
  if (chartRoot) {
    chartRoot.unmount()
    chartRoot = null
  }
}
