// web/src/workbench/LastRunCard.tsx —— REQ-1c（2026-09-23）：**事后可回看**。
//
// ── 它解决的缺口（用户原话）─────────────────────────────────────────────────
// REQ-1a 把"正在发生的事"放上了活动卡，但那是内存快照：任务跑完、或者刷新/第二天回来，
// 就只剩聚合数字了。这张卡读 **DB**（`runs.trace_json` + `files`），所以关掉浏览器再回来
// 仍然看得到"最近一次到底做了什么"。
//
// ── 与 REQ-1a 的关系：同一形状、同一个派生、同一套格式化 ──────────────────────
// 逐文件明细用的就是覆盖格那套 `detail`（后端两边共用一个派生函数），行内文案由
// `detailLine.ts` 统一格式化——两处显示因此**不可能分叉**。
//
// ── 诚实性（本仓 §4.4）─────────────────────────────────────────────────────
//  · `run: null`（还没跑过）→ 一句"还没有跑过"：**不是**错误态、也不是空列表；
//  · 请求失败 → 说"没问到"并给重试，**绝不**显示成"没有记录"（那是两句不同的话）；
//  · 文件对不回当前库（已被删/改名）→ 说清"这一轮跑了，但明细对不上当前库"，不假装没跑过。
import { useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useT, type TKey } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { localizeErrorValue } from '../lib/errorText.js'
import { formatDetailLine } from './detailLine.js'
import { Button } from '../components/ui/button.js'
import type { LastSubtitleRunDTO } from '../api/types.js'

/** decision（后端的事实）→ 一句人话。**不认识的取值照实回显**，不硬塞进任何一档。 */
function decisionLabel(decision: string | null, t: (k: TKey) => string): string {
  if (decision === null) return t('wb_last_decision_unknown')
  const key = `wb_last_decision_${decision}`
  return key in en ? t(key as TKey) : decision
}

/** 本地时刻。用**浏览器本地时区**（用户看的表），不是 UTC。 */
function stamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function LastRunCard({ reloadNonce = 0 }: { reloadNonce?: number }) {
  const { t, lang } = useT()
  const [data, setData] = useState<LastSubtitleRunDTO | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retry, setRetry] = useState(0)

  useEffect(() => {
    const ctrl = new AbortController()
    setLoading(true)
    api.lastSubtitleRun(ctrl.signal)
      .then((d) => { setData(d); setError(null) })
      // 错误一律先经 localizeError 变成**一句话**再存：直接把 unknown 塞进 state 再在渲染里
      // 判型，会让"没有错误"与"错误是个怪东西"两种状态在 JSX 里混作一谈。
      .catch((e) => { if (!ctrl.signal.aborted) setError(localizeErrorValue(e, lang)) })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false) })
    return () => ctrl.abort()
  }, [reloadNonce, retry, lang])

  const head = <div className="wb-section-head">{t('wb_last_head')}</div>

  // 错误态**优先**于空态：接口坏了与"没有记录"必须说成两句不同的话。
  if (error !== null) {
    return (
      <div className="wb-last-run" data-testid="wb-last-run">
        {head}
        <div className="wb-card-sub" data-testid="wb-last-error">
          {t('wb_last_error')}：{error}
        </div>
        <Button variant="secondary" onClick={() => setRetry((n) => n + 1)}>{t('wb_retry')}</Button>
      </div>
    )
  }
  if (loading && data === null) {
    return (
      <div className="wb-last-run" data-testid="wb-last-run">
        {head}
        <div className="wb-card-sub" aria-busy="true">{t('wb_loading')}</div>
      </div>
    )
  }
  // `run: null` = 后端明确回答"还没有跑过"（不是请求失败）。
  // ⚠️ 判据写成 `!data?.run` 而不是 `data.run === null`：响应体若不是这个形状（老后端 /
  // 测试替身 / 代理塞了个别的 JSON），`data.run` 会是 undefined 甚至 data 本身是 undefined，
  // 直接解引用会把整个活动页炸掉——而这一段的违约表现本该只是"少显示一张卡"。
  if (!data?.run) {
    return (
      <div className="wb-last-run" data-testid="wb-last-run">
        {head}
        <div className="wb-card-sub" data-testid="wb-last-none">{t('wb_last_none')}</div>
      </div>
    )
  }

  const r = data.run
  return (
    <div className="wb-last-run" data-testid="wb-last-run">
      {head}
      <div className="wb-last-meta">
        <span data-testid="wb-last-when">{stamp(r.startedAt)}</span>
        <span data-testid="wb-last-decision" data-decision={r.decision ?? 'null'}>
          {decisionLabel(r.decision, t)}
        </span>
        {/* runs.detail 是那一轮的一句话结语（如 `The Mummy 超时: timeout`）——**原样显示**：
            它是后端的事实，不经前端改写（同"人话理由不翻译"的既有口径）。 */}
        {r.detail !== null && r.detail !== '' && <span data-testid="wb-last-summary">{r.detail}</span>}
      </div>

      {r.files.length === 0 ? (
        // 跑了、但文件名对不回当前库（已被删/改名）——如实说，不假装没跑过，也不编明细。
        <div className="wb-card-sub" data-testid="wb-last-nofiles">{t('wb_last_nofiles')}</div>
      ) : (
        <ul className="wb-last-files">
          {r.files.map((f) => (
            <li key={`${f.key}:${f.filename}`} data-testid={`wb-last-file-${f.key}`}>
              <span className="wb-last-file-name">
                {f.label === '' ? f.filename : `${f.label} · ${f.filename}`}
              </span>
              <span className="wb-last-file-what" data-testid={`wb-last-detail-${f.key}`}>
                {f.detail === null ? t('wb_last_noaction') : formatDetailLine(t, f.detail)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
