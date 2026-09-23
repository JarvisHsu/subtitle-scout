// web/src/workbench/detailLine.ts —— REQ-1a / REQ-1c **共用**的那行渲染的格式化部分。
//
// ── 为什么单独一个文件 ───────────────────────────────────────────────────────
// 直播覆盖格（`CoverageGrid`，只显示当前那一格）与事后回看卡（`LastRunCard`，列出每一格）
// 用的是**同一个后端派生**产出的同一个形状。格式化若各写一份，两处显示就会慢慢分叉
// （本仓 D7/C30：「留两份实现必漂移」）。故纯格式化收在这里，两边都从这儿取。
import { en } from '../i18n/en.js'
import type { TKey } from '../i18n/useT.js'

/** 毫秒 → 人读的短时（`12s` / `1m20s` / `1h02m`）。**不四舍五入到好看**：秒级就是秒级。 */
export function humanMs(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

/**
 * 工具名 → 人话。**查不到就照实回显工具名本身**，绝不落回一个泛泛的"处理中"：
 * 工具集合是后端的事（`findSubtitleWorker.tools.ts` 加一个工具，前端不会自动知道），
 * 显示 `some_new_tool` 让人看得见"有个动作我没见过"，比"正在处理"这种抹平一切的空话有用
 * 得多（本仓对"把不知道的说成知道"有红线）。
 *
 * 用 `en` 表探键而不是 `t(key)` 后判空：`t` 的键类型是 `keyof typeof en`（静态字面量联合），
 * 传运行期字符串既过不了类型检查、返回 undefined 时也没有兜底。
 */
export function stepLabel(t: (k: TKey) => string, step: string | null): string {
  if (step === null) return t('wb_detail_unknown')
  const key = `wb_detail_${step}`
  return key in en ? t(key as TKey) : step
}

/** 逐文件那行的正文：`动作 · 源站 · 人话理由 · 耗时`（调用方自己决定要不要在前面加集号）。 */
export function formatDetailLine(
  t: (k: TKey) => string,
  d: { step: string | null; source: string | null; note: string | null; ms: number; searched: number },
): string {
  const bits: Array<string | null> = [stepLabel(t, d.step), d.source, d.note, d.ms > 0 ? humanMs(d.ms) : null]
  // "已搜 N"只在真搜过不止一次时追加——恒挂一句「已搜 1」是噪声。
  if (d.searched > 1) bits.push(`${t('wb_detail_searched')} ${d.searched}`)
  return bits.filter((x) => x !== null && x !== '').join(' · ')
}
