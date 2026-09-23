// web/src/workbench/CoverageGrid.test.tsx —— 覆盖格**画出来之后**长什么样。
// 纯函数（countStates / isSingleFileGrid）由 targetState.test.ts 守；这里锁渲染纪律：
//  · 剧集流：计数行（四档数字）+ 每格一枚状态方块（data-state 供样式画色/虚线）
//  · 电影流退化：一枚状态丸（wb-grid-pill），不铺格子网格
//  · 空数组：整段不渲染（沉默不占位）
import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { CoverageGrid } from './CoverageGrid.js'
import type { Target } from './targetState.js'

afterEach(cleanup)

function renderGrid(targets: Target[]) {
  return render(<I18nProvider initialLang="en"><CoverageGrid targets={targets} /></I18nProvider>)
}

/** 造 n 格某状态的 target（key 唯一，label 随 key）。 */
function make(n: number, state: Target['state'], prefix: string): Target[] {
  return Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, label: `${prefix}${i}`, state }))
}

describe('CoverageGrid · 剧集流：格子网格 + 计数行', () => {
  it('38 格按状态渲染，计数行含各档数字（31 已装 / 1 进行中 / 6 待处理）', () => {
    const targets = [
      ...make(31, 'installed', 'i'),
      ...make(1, 'active', 'a'),
      ...make(6, 'pending', 'p'),
    ]
    renderGrid(targets)
    expect(screen.getAllByTestId('wb-grid-cell')).toHaveLength(38)
    const count = screen.getByTestId('wb-grid-count').textContent ?? ''
    expect(count).toContain('31')
    expect(count).toContain('1')
    expect(count).toContain('6')
  })

  it('🔴 installed 计数正确反映在计数行（数字来自 countStates，不是写死）', () => {
    renderGrid([...make(3, 'installed', 'i'), ...make(2, 'pending', 'p')])
    expect(screen.getByTestId('wb-grid-count').textContent).toContain('3')
  })

  it('pending-source 格挂 data-state=pending-source（供样式画虚线边框）', () => {
    renderGrid([
      { key: 's01e01', label: 'E01', state: 'installed' },
      { key: 's01e02', label: 'E02', state: 'pending-source' },
    ])
    const cell = screen.getByTestId('wb-grid-cell-s01e02')
    expect(cell).toHaveAttribute('data-state', 'pending-source')
  })

  it('每格带 data-testid=wb-grid-cell-{key} 与 title=label', () => {
    renderGrid([{ key: 's01e03', label: 'Episode 3', state: 'active' }])
    const cell = screen.getByTestId('wb-grid-cell-s01e03')
    expect(cell).toHaveAttribute('data-state', 'active')
    expect(cell).toHaveAttribute('title', 'Episode 3')
  })
})

describe('CoverageGrid · 电影流退化：单枚状态丸', () => {
  it('单格 movie → wb-grid-pill 出现、wb-grid-cell 零个', () => {
    renderGrid([{ key: 'movie', label: 'Movie', state: 'active' }])
    expect(screen.getByTestId('wb-grid-pill')).toBeInTheDocument()
    expect(screen.queryAllByTestId('wb-grid-cell')).toHaveLength(0)
  })

  it('状态丸按唯一那格的 state 着色（data-state）', () => {
    renderGrid([{ key: 'movie', label: 'Movie', state: 'installed' }])
    expect(screen.getByTestId('wb-grid-pill')).toHaveAttribute('data-state', 'installed')
  })
})

describe('CoverageGrid · REQ-1a「这个文件现在在做什么」', () => {
  const withDetail = (over: Partial<NonNullable<Target['detail']>> = {}): NonNullable<Target['detail']> => ({
    step: 'download_candidate', source: 'subhd', note: '下载失败：服务器内部错误，请稍后再试。',
    ms: 24242, steps: ['search_source', 'download_candidate'], sources: ['subhd'], searched: 1,
    ...over,
  })

  it('🔴 有 detail → 画出当前动作行（集号 · 动作 · 源站 · 人话 · 耗时）', () => {
    renderGrid([
      { key: 's1e7', label: 'S01E07', state: 'active', detail: withDetail() },
      { key: 's1e8', label: 'S01E08', state: 'pending' },
    ])
    const line = screen.getByTestId('wb-grid-detail').textContent ?? ''
    expect(line).toContain('S01E07')
    expect(line).toContain('downloading')        // en 文案（用例用 en 渲染）
    expect(line).toContain('subhd')              // 源站照原样（不是我们编的译名）
    expect(line).toContain('下载失败：服务器内部错误，请稍后再试。')  // 人话理由**不翻译**（是事实）
    expect(line).toContain('24s')                // 耗时
  })

  it('🔴 没有任何 detail（老后端/还没动）→ 一行都不画，不许编"正在准备"', () => {
    renderGrid([
      { key: 's1e7', label: 'S01E07', state: 'pending' },
      { key: 's1e8', label: 'S01E08', state: 'pending' },
    ])
    expect(screen.queryByTestId('wb-grid-detail')).toBeNull()
  })

  it('🔴 只显示**最近动过的那一格**（优先 active），不把 24 格细节铺成日志', () => {
    renderGrid([
      { key: 's1e1', label: 'S01E01', state: 'pending', detail: withDetail({ step: 'search_source', note: '找到 44 个候选', source: null, ms: 5000 }) },
      { key: 's1e2', label: 'S01E02', state: 'active', detail: withDetail({ step: 'get_candidate', source: 'zimuku', note: null, ms: 900 }) },
    ])
    const lines = screen.getAllByTestId('wb-grid-detail')
    expect(lines, '只许有一行').toHaveLength(1)
    expect(lines[0]!.textContent).toContain('S01E02')
    expect(lines[0]!.textContent).toContain('zimuku')
  })

  it('工具名未知 → 照实显示工具名（比编一个动作更有用）', () => {
    renderGrid([{ key: 'movie', label: '', state: 'active', detail: withDetail({ step: 'some_new_tool', source: null, note: null, ms: 1000 }) }])
    const line = screen.getByTestId('wb-grid-detail').textContent ?? ''
    expect(line).toContain('some_new_tool')
  })

  it('耗时按档位人读（秒 / 分秒 / 时分），不四舍五入到好看', () => {
    const cases: Array<[number, string]> = [[45_000, '45s'], [80_000, '1m20s'], [3_720_000, '1h02m']]
    for (const [ms, want] of cases) {
      cleanup()
      renderGrid([{ key: 'movie', label: '', state: 'active', detail: withDetail({ ms, source: null, note: null }) }])
      expect(screen.getByTestId('wb-grid-detail').textContent).toContain(want)
    }
  })

  it('电影流：状态丸 + 动作行并存（不因退化成一枚丸就丢掉细节）', () => {
    renderGrid([{ key: 'movie', label: '', state: 'active', detail: withDetail({ step: 'search_source', source: null, note: '找到 44 个候选', ms: 5077 }) }])
    expect(screen.getByTestId('wb-grid-pill')).toBeInTheDocument()
    expect(screen.getByTestId('wb-grid-detail').textContent).toContain('找到 44 个候选')
  })

  it('searched > 1 才追加"已搜 N"（只搜过一次时不追加，避免噪音）', () => {
    cleanup()
    renderGrid([{ key: 'movie', label: '', state: 'active', detail: withDetail({ searched: 1, source: null, note: null }) }])
    expect(screen.getByTestId('wb-grid-detail').textContent).not.toContain('searched 1')
    cleanup()
    renderGrid([{ key: 'movie', label: '', state: 'active', detail: withDetail({ searched: 3, source: null, note: null }) }])
    expect(screen.getByTestId('wb-grid-detail').textContent).toContain('searched 3')
  })
})

describe('CoverageGrid · 空数组沉默', () => {
  it('空数组 → 容器不渲染（返回 null）', () => {
    const { container } = renderGrid([])
    expect(container.firstChild).toBeNull()
  })
})
