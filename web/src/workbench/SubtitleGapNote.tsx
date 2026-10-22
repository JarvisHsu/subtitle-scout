// web/src/workbench/SubtitleGapNote.tsx —— 「**哪些文件还没有字幕**」的可见形态
// + 每个文件一个「立即重试」。
//
// ── 它解决的那句话（用户 2026-09-23 原话）────────────────────────────────────
// 「如果没有找到字幕，我发现现在我完全没办法知道。」
// 「如果没有找到字幕，我需要立即重试或者进行翻译。」
// 所以这条提示必须同时答两件事：**是什么**（哪个文件、为什么、什么时候再试）
// 和 **我能做什么**（立即重试）。
//
// ── 为什么按钮按**作品**粒度重试而不是按文件 ────────────────────────────────
// 既有的按需取字幕（`POST /api/v2/subtitle/fetch`）的入参就是 `{ workId, season?, episode? }`，
// 一次跑一个作品的整条流水线。按文件发请求会需要一条**新的**流水线入口，而那正是
// openspec 12.1 明令 MUST NOT 的事（"不许新建第二条流水线"）。故：一个文件一个按钮，
// 但落到同一个已存在的入口（同一作品的多个文件点任一个，效果相同——文案里说明）。
//
// ── 为什么 `awaiting-translate` 不给按钮 ────────────────────────────────────
// 那一档归**翻译台**，`planSubtitleFetch` 会明确跳过它（`translate-workbench`）。
// 画一个点了会被拒的按钮就是骗用户（同 UnidentifiedNote 对"零按钮"的那段论证）。
// 那里改成如实说明"等翻译台"。
//
// ── Carbon 双通道（R-F11 拒绝投影）──────────────────────────────────────────
// 文字自己把话说全（去掉 CSS 信息量一个字不少）；形状复用 `root-health-mark` 那一族；
// 颜色只是第三重。
import { useState } from 'react'
import { useT, type TKey } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { api } from '../api/client.js'
import type { SubtitleGapFileDTO, SubtitleGapsDTO } from '../api/types.js'

/** 四档原因 → 一句人话。**不认识的取值照实回显**（同 stepLabel 的既有口径）。
 *  后端给的是 hyphen 形（`source-silent`），词表键用下划线（JS 对象字面量里 hyphen 要加引号，
 *  而这一族键是拼出来的，故统一成下划线）。 */
function reasonLabel(reason: string, t: (k: TKey) => string): string {
  const key = `subgap_reason_${reason.replace(/-/g, '_')}`
  return key in en ? t(key as TKey) : reason
}

/** 一个文件的人话标签：`S01E07` 或文件名；电影没有季集就给文件名。 */
function fileLabel(f: SubtitleGapFileDTO): string {
  if (f.season != null && f.episode != null) {
    return `S${String(f.season).padStart(2, '0')}E${String(f.episode).padStart(2, '0')}`
  }
  return f.filename.length > 34 ? `${f.filename.slice(0, 33)}…` : f.filename
}

/**
 * 没字幕的文件提示。`count === 0` 或 DTO 缺席 → 返回 null（沉默即好消息 / 不知道就不说话）。
 *
 * @param onRetried 重试请求被受理后调用（调用方传 `reloadHealth`）。
 */
export function SubtitleGapNote({
  gaps, onRetried,
}: {
  gaps: SubtitleGapsDTO | null | undefined
  onRetried?: () => void
}) {
  const { t } = useT()
  // 正在提交的作品 id（防连点）；每个作品一条。
  const [busy, setBusy] = useState<string | null>(null)
  // 已经受理过的作品：立刻给出反馈（不等 /health 轮询）。
  const [accepted, setAccepted] = useState<Record<string, string>>({})

  if (!gaps || gaps.count === 0) return null
  const { count, files } = gaps
  const hidden = count - files.length

  const retry = async (f: SubtitleGapFileDTO) => {
    if (busy !== null) return
    setBusy(f.workId)
    try {
      const r = await api.subtitleFetch(f.workId, f.season, f.episode)
      // 受理回执分三种（与 triggerInspect 同一套口径）：accepted / accepted_starting / already_running。
      // 只有前两种是"真的排上了"；already_running 也要如实说（用户会奇怪为什么没变化）。
      const key = r.outcome === 'accepted' ? 'subgap_accepted'
        : r.outcome === 'accepted_starting' ? 'subgap_accepted_starting'
          : 'subgap_already_running'
      setAccepted((prev) => ({ ...prev, [f.workId]: key }))
      onRetried?.()
    } catch (e) {
      // 被拒（409）时后端的 message 就是 reason 枚举——按它选一句人话，**不贴枚举原文**。
      const msg = e instanceof Error ? e.message : ''
      const known: Record<string, TKey> = {
        'already-covered': 'subgap_reject_covered',
        'no-subtitle-needed': 'subgap_reject_no_need',
        'translate-workbench': 'subgap_reject_translate',
        'not-judged': 'subgap_reject_not_judged',
        'work-not-found': 'subgap_reject_work_gone',
        'no-video-files': 'subgap_reject_no_files',
      }
      const hit = Object.keys(known).find((k) => msg.includes(k))
      setAccepted((prev) => ({ ...prev, [f.workId]: hit ? known[hit]! : 'subgap_retry_failed' }))
    } finally {
      setBusy(null)
    }
  }

  return (
    <span
      className="root-health-line"
      data-kind="unknown"
      data-testid="wb-subgap-line"
      role="status"
      aria-live="polite"
    >
      <span className="root-health-mark root-health-mark-hollow" aria-hidden="true" />
      {' '}
      {t('subgap_note').replace('{n}', String(count))}
      {': '}
      <span className="root-health-paths wb-unidentified-paths">
        {files.map((f, i) => {
          const done = accepted[f.workId]
          return (
            <span key={`${f.workId}#${f.filename}#${i}`}>
              {i > 0 && ', '}
              {done !== undefined
                // 已被受理/被拒：换成一句结果，不再显示按钮（避免连点与"看不出有没有生效"）。
                ? <span data-testid={`wb-subgap-result-${i}`}>{t(done as TKey)}</span>
                : f.retryable
                  ? (
                    <button
                      type="button"
                      className="wb-unidentified-dir"
                      data-testid={`wb-subgap-retry-${i}`}
                      disabled={busy !== null}
                      title={`${reasonLabel(f.reason, t)} · ${t('subgap_retry_hint')}`}
                      onClick={() => { void retry(f) }}
                    >{fileLabel(f)}</button>
                  )
                  // 不可催（等翻译台）：渲成纯文本 + 说明，**不画点了会被拒的按钮**。
                  : <span data-testid={`wb-subgap-plain-${i}`}>{fileLabel(f)}（{t('subgap_reason_awaiting_translate')}）</span>}
            </span>
          )
        })}
      </span>
      {hidden > 0 && (
        <span data-testid="wb-subgap-more">{t('unidentified_more').replace('{n}', String(hidden))}</span>
      )}
    </span>
  )
}
