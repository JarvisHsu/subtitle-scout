// web/src/workbench/LastRunCard.test.tsx —— REQ-1c：事后回看卡。
//
// 这里锁的是「**刷新之后还能看到什么**」以及三种状态**不许互相冒充**：
//   · 有记录 → 逐文件明细（集号 · 动作 · 源站 · 人话理由 · 耗时）
//   · `run: null` → "还没有跑过"（后端明确回答"没有"，不是错误）
//   · 请求失败 → "没能问到"（**绝不许**显示成"没有记录"——本仓 §4.4）
import { describe, it, expect, afterEach, vi, beforeEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { LastRunCard } from './LastRunCard.js'
import { api } from '../api/client.js'
import type { LastSubtitleRunDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

function renderCard() {
  return render(<I18nProvider initialLang="en"><LastRunCard /></I18nProvider>)
}

const withRun: LastSubtitleRunDTO = {
  run: {
    id: 274, startedAt: 1_760_000_000_000, finishedAt: 1_760_000_060_000,
    decision: 'error', detail: 'The Mummy 超时: timeout', traceEvents: 20,
    files: [
      {
        key: 's1e7', label: 'S01E07', filename: 'ep07.mkv',
        detail: { step: 'download_candidate', source: 'subhd', note: '下载失败：服务器内部错误', ms: 24_242, steps: ['download_candidate'], sources: ['subhd'], searched: 1 },
      },
      {
        key: 's1e8', label: 'S01E08', filename: 'ep08.mkv',
        detail: { step: 'search_source', source: null, note: '找到 44 个候选', ms: 5_077, steps: ['search_source'], sources: [], searched: 3 },
      },
    ],
  },
}

describe('LastRunCard · 有记录', () => {
  beforeEach(() => { vi.spyOn(api, 'lastSubtitleRun').mockResolvedValue(withRun) })

  it('🔴 逐文件明细：两格各归各（A 的失败不许贴到 B 头上）', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-file-s1e7')).toBeInTheDocument())
    // 集号在**文件名行**上（`S01E07 · ep07.mkv`），动作行只说"在做什么"。
    expect(screen.getByTestId('wb-last-file-s1e7').textContent).toContain('S01E07')
    const e7 = screen.getByTestId('wb-last-detail-s1e7').textContent ?? ''
    expect(e7).toContain('downloading')
    expect(e7).toContain('subhd')
    expect(e7).toContain('下载失败：服务器内部错误')
    expect(e7).toContain('24s')

    const e8 = screen.getByTestId('wb-last-detail-s1e8').textContent ?? ''
    expect(e8).toContain('searching sources')
    expect(e8).toContain('找到 44 个候选')
    expect(e8).not.toContain('subhd')
  })

  it('头部给时刻 + decision 的人话 + runs.detail 原样', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-decision')).toBeInTheDocument())
    expect(screen.getByTestId('wb-last-decision').textContent).toBe('errored')
    // runs.detail 是后端事实，**原样显示**（不翻译、不改写）
    expect(screen.getByTestId('wb-last-summary').textContent).toBe('The Mummy 超时: timeout')
  })

  it('searched 只在 >1 时追加（已搜 3 出现、已搜 1 不出现）', async () => {
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-detail-s1e8')).toBeInTheDocument())
    expect(screen.getByTestId('wb-last-detail-s1e8').textContent).toContain('searched 3')
    expect(screen.getByTestId('wb-last-detail-s1e7').textContent).not.toContain('searched 1')
  })

  it('🔴 不认识的 decision 照实回显（不硬塞进任何一档）', async () => {
    vi.spyOn(api, 'lastSubtitleRun').mockResolvedValue({
      run: { ...withRun.run!, decision: 'brand_new_decision', files: [] },
    })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-decision')).toBeInTheDocument())
    expect(screen.getByTestId('wb-last-decision').textContent).toBe('brand_new_decision')
  })

  it('文件对不回当前库（files 为空）→ 说清"跑了但对不上"，不假装没跑过', async () => {
    vi.spyOn(api, 'lastSubtitleRun').mockResolvedValue({
      run: { ...withRun.run!, files: [] },
    })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-nofiles')).toBeInTheDocument())
    expect(screen.queryByTestId('wb-last-none')).toBeNull()
  })

  it('detail 为 null 的那一格说"没有可回看的动作"（不编一个动作）', async () => {
    vi.spyOn(api, 'lastSubtitleRun').mockResolvedValue({
      run: {
        ...withRun.run!,
        files: [{ key: 'movie', label: '', filename: 'x.mkv', detail: null }],
      },
    })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-detail-movie')).toBeInTheDocument())
    expect(screen.getByTestId('wb-last-detail-movie').textContent).toBe('No action recorded for this run')
  })
})

describe('LastRunCard · 空态与错误态**不许互相冒充**（§4.4）', () => {
  it('run: null（还没跑过）→ 空态文案，且**不是**错误态', async () => {
    vi.spyOn(api, 'lastSubtitleRun').mockResolvedValue({ run: null })
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-none')).toBeInTheDocument())
    expect(screen.queryByTestId('wb-last-error')).toBeNull()
  })

  it('🔴 请求失败 → 错误态（**绝不许**显示成"还没有跑过"）', async () => {
    vi.spyOn(api, 'lastSubtitleRun').mockRejectedValue(new Error('boom'))
    renderCard()
    await waitFor(() => expect(screen.getByTestId('wb-last-error')).toBeInTheDocument())
    expect(screen.queryByTestId('wb-last-none'), '接口坏了不能说成没有记录').toBeNull()
  })
})
