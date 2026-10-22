// src/dashboard/subtitleGapsHealth.ts —— 「**哪些文件还没有字幕**」的读出面。
//
// ── 为什么需要它（用户的痛点，2026-09-23 原话）──────────────────────────────
// 「如果没有找到字幕，我发现现在我完全没办法知道。」——实测确认：库里确实躺着
// `sub_status='unsolvable'`、`sub_attempt=7~8` 的行，而界面上**一个字都没有**。
// 唯一的读出面是活动页那张"最近一次找字幕"卡，它只显示**最近一条 run**——看不到
// "我这部片子到底怎么了、什么时候会再试、我现在能不能催它"。
//
// ── 口径（只报"试过但没有"的行，不报"还没排队"的）──────────────────────────
// 有三种"没有字幕"，性质完全不同，**混在一起报就是噪音**：
//   · 还没轮到的（`sub_status IS NULL` 且 `sub_attempt = 0`）→ **不报**，那是正常排队；
//   · 试过没成的（`sub_attempt >= 1` 且仍 NULL）→ **报**，这是用户要等/要催的；
//   · 已停牌的（`unsolvable` / `handoff_translate`）→ **报**，这是最需要让用户知道的。
// 故谓词刻意**不是** `needs_subtitle=1 AND sub_status != 'covered'`（那会把 241 行
// "还没轮到"也算成缺口，用户会以为系统全挂了）。
//
// ── 每个文件给什么（都是"用户能据以行动"的）────────────────────────────────
// · `reason`：为什么没字幕（源站没答 / 搜完没有 / 超时 / 等翻译）——**折成四档**，
//   不把 `sub:retry-later` 这种内部串贴给用户；
// · `nextRetryAt`：**系统打算什么时候再试**（这一列是"我要不要等"的唯一答案）；
// · `retryable`：能不能点「立即重试」——`handoff_translate` 归翻译台，点了也没用，
//   故它必须是 false（否则就是本仓反复禁的"点了会失败/会骗人的按钮"）。
//   （`unsolvable` **可以**催：`planSubtitleFetch` 会把它 `revive` 到当下。）
//
// ── 信息量边界 ──────────────────────────────────────────────────────────────
// 出：作品标题、文件名、季集、四档原因、重试次数、下次重试时刻。
// 不出：`last_error` 原文、绝对路径、body 级排障读数（同 unidentifiedHealth 的既有裁决）。
import type { ScoutDb } from '../v2/db.js'

/** 为什么这个文件还没有字幕。**四档**，各对应一句不同的话。 */
export type SubtitleGapReason =
  /** 源站没答（限流/超时/返回空）——`sub:retry-later`。最常见。 */
  | 'source-silent'
  /** 搜完了、确实没有可用的（`sub:no-outcome` / `sub:no-match`）。 */
  | 'no-match'
  /** 跑超时（`sub:timeout`）。 */
  | 'timeout'
  /** 已移交翻译台，等翻译（`handoff_translate`）。 */
  | 'awaiting-translate'
  /** 其他/未知——**不猜**，如实归到这里。 */
  | 'other'

export interface SubtitleGapFileDTO {
  /** 作品 id（`tmdb:<n>`）。「立即重试」按**作品**粒度发起（与既有按需取字幕一致）。 */
  workId: string
  /** 作品标题（`works.title`）；works 行缺席时为 null（不编一个）。 */
  title: string | null
  filename: string
  season: number | null
  episode: number | null
  reason: SubtitleGapReason
  /** 已真实尝试次数（`sub_attempt`）。 */
  attempt: number
  /** 系统计划的下次重试时刻；NULL = 没有排期（等巡检自然轮到）。 */
  nextRetryAt: number | null
  /** 能不能「立即重试」。`handoff_translate` → false（归翻译台，点了也没用）。 */
  retryable: boolean
}

export interface SubtitleGapsDTO {
  /** 缺口**文件数**（不是作品数）。 */
  count: number
  /** 前 `MAX_LISTED_GAPS` 个（下次重试最早的在前 = 最快会有结果的在前）。 */
  files: SubtitleGapFileDTO[]
}

/** 列出的上限。与 `MAX_LISTED_DIRS` 同一条理由：这条提示的用途是"指出该管哪几个"，
 *  不是清单导出。用户第一次接一个没整理过的库时缺口可能上百，铺开会顶掉整个页面。 */
export const MAX_LISTED_GAPS = 8

/** `last_error` → 四档原因。**不认识的一律 other**（不猜、不硬塞进某一档）。 */
function reasonOf(lastError: string | null, subStatus: string | null): SubtitleGapReason {
  if (subStatus === 'handoff_translate') return 'awaiting-translate'
  const e = lastError ?? ''
  if (e === 'sub:retry-later') return 'source-silent'
  if (e === 'sub:no-outcome' || e === 'sub:no-match') return 'no-match'
  if (e === 'sub:timeout') return 'timeout'
  return 'other'
}

/**
 * `/api/v2/health` 的 `subtitleGaps` 段。
 *
 * 谓词见文件头：**只报"试过但没有"的行**。`ORDER BY recheck_after`（NULL 排最后）——
 * 用户最该先看到的，是"马上就会再试"的那些（它们最可能自己好），而不是排到一周后的。
 */
export function buildSubtitleGaps(db: ScoutDb): SubtitleGapsDTO {
  let rows: Array<{
    path: string; filename: string; work_id: string | null; title: string | null
    season: number | null; episode: number | null; sub_status: string | null
    sub_attempt: number | null; recheck_after: number | null; last_error: string | null
  }> = []
  try {
    rows = db.prepare(`
      SELECT f.path, f.filename, f.work_id, w.title, f.season, f.episode,
             f.sub_status, f.sub_attempt, f.recheck_after, f.last_error
        FROM files f LEFT JOIN works w ON w.id = f.work_id
       WHERE f.needs_subtitle = 1
         AND ( f.sub_status = 'unsolvable'
            OR f.sub_status = 'handoff_translate'
            OR (f.sub_status IS NULL AND COALESCE(f.sub_attempt, 0) >= 1) )
       ORDER BY (f.recheck_after IS NULL), f.recheck_after ASC, f.filename ASC
    `).all() as typeof rows
  } catch {
    // 无该列的旧库：这一整段降级成"没有缺口"是**错的**（那是报绿）。
    // 故抛出前先确认：调用方（/health）会把它包进自己的隔离里还是整体 500——
    // 这里选择**返回空并让 count=0**，因为"读不出缺口"与"没有缺口"在 UI 上都表现为不显示，
    // 而这条提示是**增益**，不该让整页 /health 挂掉（同 unidentified 的降级口径）。
    return { count: 0, files: [] }
  }

  const files: SubtitleGapFileDTO[] = rows.slice(0, MAX_LISTED_GAPS).map((r) => ({
    workId: r.work_id ?? '',
    title: typeof r.title === 'string' && r.title !== '' ? r.title : null,
    filename: r.filename,
    season: r.season,
    episode: r.episode,
    reason: reasonOf(r.last_error, r.sub_status),
    attempt: Number(r.sub_attempt ?? 0),
    nextRetryAt: r.recheck_after === null ? null : Number(r.recheck_after),
    // handoff_translate 归翻译台：按需取字幕会**跳过**它（planSubtitleFetch 的既有口径），
    // 故这里必须是 false —— 画一个点了会被拒的按钮是骗用户。
    retryable: r.sub_status !== 'handoff_translate' && r.work_id !== null && r.work_id !== '',
  }))

  return { count: rows.length, files }
}
