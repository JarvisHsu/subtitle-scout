// SubtitleGapNote 用例：这条提示对用户承诺两件事——**让我看见**、**让我催它**。
// 每条用例盯一个会破坏这两个承诺的失败模式。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { SubtitleGapNote } from './SubtitleGapNote.js'
import { api } from '../api/client.js'
import { en } from '../i18n/en.js'
import type { SubtitleGapsDTO } from '../api/types.js'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const gap = (o: Partial<SubtitleGapsDTO['files'][number]> = {}) => ({
  workId: 'tmdb:1', title: 'Show', filename: 'E07.mkv', season: 1, episode: 7,
  reason: 'source-silent' as const, attempt: 2, nextRetryAt: null, retryable: true, ...o,
})

function renderNote(gaps: SubtitleGapsDTO | null | undefined, onRetried?: () => void) {
  return render(
    <I18nProvider initialLang="en"><SubtitleGapNote gaps={gaps} onRetried={onRetried} /></I18nProvider>,
  )
}

describe('SubtitleGapNote · 沉默即好消息', () => {
  it('count=0 → 整段不渲染（全都有字幕的库不占屏）', () => {
    const { container } = renderNote({ count: 0, files: [] })
    expect(container.textContent).toBe('')
  })

  it('DTO 缺席（老后端/还没回来）→ 不渲染，**不报"全都有字幕"**', () => {
    const { container } = renderNote(undefined)
    expect(container.textContent).toBe('')
  })
})

describe('SubtitleGapNote · 让我看见', () => {
  it('说清有几个、并把文件名列出来（只说个数等于让用户挨个去猜）', () => {
    renderNote({ count: 2, files: [gap(), gap({ filename: 'E08.mkv', episode: 8 })] })
    const line = screen.getByTestId('wb-subgap-line').textContent ?? ''
    expect(line).toContain('2')
    expect(line).toContain('S01E07')
    expect(line).toContain('S01E08')
  })

  it('🔴 原因走人话，**不许**把内部串（sub:retry-later）贴给用户', () => {
    renderNote({ count: 1, files: [gap({ reason: 'source-silent' })] })
    const btn = screen.getByTestId('wb-subgap-retry-0')
    expect(btn.getAttribute('title') ?? '').toContain(en.subgap_reason_source_silent)
    expect(btn.getAttribute('title') ?? '').not.toContain('sub:')
  })

  it('截断时用 count 说"还有 N 个"（绝不用 files.length 当总数）', () => {
    renderNote({ count: 10, files: [gap()] })
    expect(screen.getByTestId('wb-subgap-more').textContent).toContain('9')
  })
})

describe('SubtitleGapNote · 让我催它', () => {
  it('🔴 点文件名 → 真的发起按需取字幕（按作品粒度，带季集）', async () => {
    const spy = vi.spyOn(api, 'subtitleFetch').mockResolvedValue({ outcome: 'accepted', targets: 1, skipped: 0 } as never)
    const onRetried = vi.fn()
    renderNote({ count: 1, files: [gap()] }, onRetried)
    fireEvent.click(screen.getByTestId('wb-subgap-retry-0'))
    await waitFor(() => expect(spy).toHaveBeenCalledWith('tmdb:1', 1, 7))
    await waitFor(() => expect(onRetried).toHaveBeenCalled())
  })

  it('🔴 受理后立刻给反馈（不等 /health 轮询），且按钮消失（防连点）', async () => {
    vi.spyOn(api, 'subtitleFetch').mockResolvedValue({ outcome: 'accepted', targets: 1, skipped: 0 } as never)
    renderNote({ count: 1, files: [gap()] })
    fireEvent.click(screen.getByTestId('wb-subgap-retry-0'))
    await waitFor(() => expect(screen.getByTestId('wb-subgap-result-0').textContent).toBe(en.subgap_accepted))
    expect(screen.queryByTestId('wb-subgap-retry-0')).toBeNull()
  })

  it('already_running 如实说，**不**说是"排上了"（两者对用户是不同的事）', async () => {
    vi.spyOn(api, 'subtitleFetch').mockResolvedValue({ outcome: 'already_running' } as never)
    renderNote({ count: 1, files: [gap()] })
    fireEvent.click(screen.getByTestId('wb-subgap-retry-0'))
    await waitFor(() => expect(screen.getByTestId('wb-subgap-result-0').textContent).toBe(en.subgap_already_running))
  })

  it('🔴 被拒时按 reason 给一句人话，**不贴枚举原文**', async () => {
    vi.spyOn(api, 'subtitleFetch').mockRejectedValue(new Error('translate-workbench'))
    renderNote({ count: 1, files: [gap()] })
    fireEvent.click(screen.getByTestId('wb-subgap-retry-0'))
    await waitFor(() => {
      expect(screen.getByTestId('wb-subgap-result-0').textContent).toBe(en.subgap_reject_translate)
    })
  })

  it('🔴 归翻译台的文件**不画按钮**（点了会被拒），改成文字说明', () => {
    renderNote({ count: 1, files: [gap({ reason: 'awaiting-translate', retryable: false })] })
    expect(screen.queryByTestId('wb-subgap-retry-0')).toBeNull()
    expect(screen.getByTestId('wb-subgap-plain-0').textContent).toContain(en.subgap_reason_awaiting_translate)
  })
})
