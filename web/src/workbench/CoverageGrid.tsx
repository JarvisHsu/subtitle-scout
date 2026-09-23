// web/src/workbench/CoverageGrid.tsx —— 一部作品的覆盖情况**画出来**：
//  · 剧集流 → 计数行（四档数字）+ 逐格状态方块（flex-wrap 网格）
//  · 电影流（isSingleFileGrid）→ 退化成一枚状态丸，不铺格子网格（一部电影只有一格，
//    铺一个孤零零的方块比一枚丸更难认）
//  · 空数组 → 返回 null（沉默不占位——没 target 就没有覆盖情况可画）
//
// 计数与形态判定全在 targetState.ts 的纯函数里，这里只负责渲染。四档文案走 wb_grid_*，
// pendingSource 为 0 时不追加那一段（多数剧集所有集都有源，恒挂「0 暂缺」是噪声）。
import { useT, type TKey } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { countStates, isSingleFileGrid, type Target } from './targetState.js'

/**
 * 工具名 → 人话。**查不到就照实回显工具名本身**，绝不落回一个泛泛的"处理中"：
 * 工具集合是后端的事（`findSubtitleWorker.tools.ts` 加一个工具，前端不会自动知道），
 * 显示 `some_new_tool` 让人看得见"有个动作我没见过"，比显示"正在处理"这种抹平一切的空话
 * 有用得多（本仓对"把不知道的说成知道"有红线）。
 *
 * 用 `en` 表探键而不是 `t(key)` 后判空：`t` 的键类型是 `keyof typeof en`（静态字面量联合），
 * 传运行期字符串既过不了类型检查、返回 undefined 时也没有兜底。
 */
function stepLabel(t: (k: TKey) => string, step: string): string {
  const key = `wb_detail_${step}`
  if (!(key in en)) return step
  return t(key as TKey)
}

/** 毫秒 → 人读的短时（`12s` / `1m20s` / `1h02m`）。**不做四舍五入到好看**：秒级就是秒级。 */
function humanMs(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * REQ-1a（2026-09-23）：覆盖格下方那行「**正在做什么**」。
 *
 * ── 为什么取"最近动过的那一格"而不是"所有 active 格" ──────────────────────────
 * 覆盖格是**作品级**的（一部剧 24 格），而 agent 一次只处理一个文件；把 24 格的细节一起铺开
 * 等于把界面变成日志文件（R-F10 的判据："把系统的辛苦展示给用户看是反效果"）。
 * 故只显示**最近有动作的那一格**——它就是"现在正在发生的事"。
 *
 * ── 一条 detail 都没有时返回 null ────────────────────────────────────────────
 * 老后端不带 `detail`、或这一个作品还没动过任何文件 ⇒ **什么都不画**，不写"正在准备"之类的
 * 空话（本仓对"看起来像进度的假数据"有红线：宁可不说，不许编）。
 */
function DetailLine({ t, target }: { t: (k: TKey) => string; target: Target }) {
  const d = target.detail
  if (!d || (d.step === null && d.ms === 0 && d.searched === 0)) return null
  // tool 名 → 人话；未知工具**照实显示工具名**（比编一个"处理中"更有用），只有确实没有工具名才用兜底。
  const what = d.step === null ? t('wb_detail_unknown') : stepLabel(t, d.step)
  const bits = [d.step === null ? '' : target.label, what].filter((x) => x !== '')
  if (d.source !== null) bits.push(d.source)
  if (d.note !== null) bits.push(d.note)
  if (d.ms > 0) bits.push(humanMs(d.ms))
  if (d.searched > 1) bits.push(`${t('wb_detail_searched')} ${d.searched}`)
  return (
    <div className="wb-grid-detail" data-testid="wb-grid-detail">
      {bits.join(' · ')}
    </div>
  )
}

/** 最近有动作的那一格：优先 active（正在发生），否则取 detail 最新的一条。 */
function currentTarget(targets: Target[]): Target | null {
  const active = targets.find((x) => x.state === 'active' && x.detail)
  if (active) return active
  return targets.find((x) => x.detail) ?? null
}

export function CoverageGrid({ targets }: { targets: Target[] }) {
  const { t } = useT()
  if (targets.length === 0) return null

  const cur = currentTarget(targets)

  // 电影流：一枚状态丸，按唯一那格着色。data-state 供样式取色（与格子同一套 [data-state=…]）。
  if (isSingleFileGrid(targets)) {
    const only = targets[0]!
    return (
      <>
        <span className="wb-grid-pill" data-testid="wb-grid-pill" data-state={only.state} title={only.label} />
        {cur !== null && <DetailLine t={t} target={cur} />}
      </>
    )
  }

  const c = countStates(targets)
  // 计数行：形如 `31 installed · 1 in progress · 6 pending`，pendingSource>0 时追加 `· N unavailable`。
  // t() 不插值，数字与译文用 JS 拼（同 wb_ticker 的调用方口径）。
  const parts = [
    `${c.installed} ${t('wb_grid_installed')}`,
    `${c.active} ${t('wb_grid_active')}`,
    `${c.pending} ${t('wb_grid_pending')}`,
  ]
  if (c.pendingSource > 0) parts.push(`${c.pendingSource} ${t('wb_grid_pending_source')}`)

  return (
    <div className="wb-grid-wrap">
      <div className="wb-grid-count" data-testid="wb-grid-count">{parts.join(' · ')}</div>
      <div className="wb-grid">
        {targets.map((tg) => (
          <span
            key={tg.key}
            className="wb-grid-cell"
            data-testid="wb-grid-cell"
            data-state={tg.state}
            title={tg.label}
          >
            {/* 二级 testid（带 key）供定位具体一格；一级 wb-grid-cell 供计总数。 */}
            <span data-testid={`wb-grid-cell-${tg.key}`} data-state={tg.state} title={tg.label} className="wb-grid-cell-inner" />
          </span>
        ))}
      </div>
      {cur !== null && <DetailLine t={t} target={cur} />}
    </div>
  )
}
