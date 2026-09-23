// web/src/workbench/UnidentifiedNote.tsx —— 「有几个目录我认不出来」的**可见形态**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 病 A 第 7 例的最后一跳
// ══════════════════════════════════════════════════════════════════════════════
// 链条：daemonV2.scanOnce 写 `files`（新文件 `work_id` NULL）→ identifyScheduler 按
//   `work_id IS NULL` 取件识别 → 识别不出则退避、`tmdb-404` 则**永久退出队列**
//   → `buildUnidentifiedHealth` 汇总（谓词刻意含 404 那批）→ `/api/v2/health` 的
//     `unidentified` → **本组件**（第一个把它画出来的地方）。
// 此前这条链的终点是"什么都没有"：用户媒体库里有文件永远不被处理，他无从得知。
//
// ── 为什么落在活动页状态条，而不是新页面 / 媒体库 / 通知页 ────────────────────
// ① **不新增第四个页面**（三页产品：活动 / 通知 / 媒体库 + 设置）。
// ② **不进媒体库页**：R-F2「识别失败的孤儿不露出」的作用域正是那一页的海报墙。
//    且结构上也做不到——卡片要标题/海报/年份/季集网格，那些全来自 `works` 行，
//    识别失败时它们不存在。
// ③ **不进通知页**：那一页是「成果流水」（R-F3 保留一周的 found 事件）。
//    "有东西认不出来"是一个**持续状态**，不是一次性成果——塞进倒序流水里，
//    它会在用户下次刷新时被新成果推走，而问题还在。
// ④ **不占显眼位置**（R-F1 的精神：识别耗时短、用户能做的只有改文件名）。故它与
//    `RootHealthNote` 同形、并列在状态条里：一个标记 + 一句话，**零为 0 时不占一个字**。
//
// ══════════════════════════════════════════════════════════════════════════════
// 🔴 2026-09-18：**本组件第一次有了一个动作**（提案第 8 组）
// ══════════════════════════════════════════════════════════════════════════════
// 本文件此前有一整段「为什么不给任何按钮」的论证（R-F1），否掉了「重新识别」与「忽略」
// 两个候选，理由是：
//
//   > 这条提示对应的动作在**用户的机器上**，界面上没有任何按钮能替他做，
//   > 画一个只会是打不通的按钮。
//
// **那个前提现在不成立了**：D-5 落地了 `POST /api/v2/identify/bind`——服务端多了一条
// 用户能触发的、真正有用的动作（把目录人工指定到某个 TMDB 作品）。提案第 8 组明文要求
// 在这里给出入口，所以本组件按新前提**推翻 R-F1 的"零按钮"结论**。
//
// ⚠️ 但 R-F1 否掉的那两个按钮**依然是对的，不许加回来**：
//   · 「重新识别」——拿同一批没变过的字节再跑一遍同一个 agent，真实效果是让用户付费重摇
//     LLM（identifyScheduler 已每天自动重试）。
//   · 「忽略」——要往库里写一条"用户说这个不用管"，那正是 R-F1 禁的「改」。
//   新增的这个入口与它们的区别是：它**改变了输入**（告诉系统这个目录是谁），而不是
//   重跑或压制。下一个人若要再加按钮，先回答"它改变了什么输入"。
//
// ── Carbon 双通道（R-F11 拒绝投影）────────────────────────────────────────
// ① 文字自己把话说全（去掉全部 CSS 信息量一个字不少）；
// ② 形状：**空心方块**，复用 `root-health-mark` 那一族——刻意不发明第三种形状。
// ③ 颜色只是第三重（走 `unknown` 那档的 muted 灰）。
import { useState } from 'react'
import { useT } from '../i18n/useT.js'
import type { UnidentifiedHealthDTO } from '../api/types.js'
import { IdentifyBindDialog } from './IdentifyBindDialog.js'

/**
 * 认不出来的目录提示。**`dirCount === 0` → 返回 null（整段不渲染）**。
 *
 * `unidentified` 为 undefined/null（`/health` 还没回来，或这一页没拿到）时同样返回 null：
 * 不知道就不说话——绝不因为"没拿到"而报一句"都认出来了"（那是 fail-open 报绿，
 * 正是这整条链要防的那句假话，同 RootHealthNote 的既有论证）。
 *
 * @param onBound 绑定成功后调用（调用方传 `reloadHealth`）。不传时仍可用，只是要等下一次
 *   `/health` 轮询才看到那一行消失——**不静默假装成功**是这里的底线。
 */
export function UnidentifiedNote({
  unidentified, onBound,
}: {
  unidentified: UnidentifiedHealthDTO | null | undefined
  onBound?: () => void
}) {
  const { t } = useT()
  // 🔴 存的是**收窄后的形状**（handle 确定是 string），不是整个 DTO：`handle` 在类型上是
  // 可选的（老后端可能没有），而弹窗要求它一定有。存整个 DTO 会把"这是哪个分支选中的"
  // 这条信息丢掉，于是 `binding.handle` 又变回 `string | undefined`——收窄活不过 setState。
  const [binding, setBinding] = useState<{ dirName: string; handle: string } | null>(null)

  if (!unidentified) return null
  const { dirCount, dirs } = unidentified
  if (dirCount === 0) return null

  // 🔴 尾巴按 `dirCount - dirs.length` 算，**不是** `dirCount > MAX_LISTED_DIRS`：
  // 上限是后端的常量，前端复述一份必然漂移（C30 老教训）。差值 > 0 就说"另外还有 N 个"，
  // 后端把上限改成 20 时这里自动正确。
  const hiddenCount = dirCount - dirs.length

  // P6（2026-09-23）：按**实际处境**选一句话，不再用一句通用话误导两种人。
  // 判据来自后端的 `reason`；老后端没有这个字段 ⇒ 一律按 `transient`（最不吓人、也最不需要
  // 用户动手的那一档），**不**退回旧那句"去改名"——那句正是本次要修掉的那个误导。
  const reasons = new Set(dirs.map((d) => d.reason ?? 'transient'))
  const reasonKey = reasons.has('exhausted') && reasons.has('transient')
    ? 'unidentified_reason_mixed'
    : reasons.has('exhausted') ? 'unidentified_reason_exhausted' : 'unidentified_reason_transient'

  return (
    <>
      {/* role="status" + aria-live="polite"：这是一条**背景事实**，不是对用户操作的回应，
          也不是需要抢读的故障（role="alert" 留给真正打断用户的东西）。同 RootHealthNote。 */}
      <span
        className="root-health-line"
        data-kind="unknown"
        data-testid="wb-unidentified-line"
        role="status"
        aria-live="polite"
      >
        <span className="root-health-mark root-health-mark-hollow" aria-hidden="true" />
        {' '}
        {t('unidentified_note')}
        {': '}
        {/* 目录名走 mono——同守备目录路径那套"技术性读数"的排印语言。
            **必须列出来**：用户有好几个目录认不出来时，只说"有 3 个"等于让他挨个去猜。
            这不是排障细节，这是这条提示唯一可操作的部分（同 root-health-paths 的裁决）。
            ⚠️ 出的是**目录名**（后端已剥掉挂载点前缀），不是绝对路径。
            🔴 2026-09-18：这"唯一可操作的部分"现在**真的可操作了**——每个名字是一个按钮，
            点开就是「指定作品」。此前它只是一段文字，而提示本身在说"去改目录名"。 */}
        <span className="root-health-paths wb-unidentified-paths">
          {dirs.map((d, i) => {
            // 🔴 先取成局部 const 再用：TS 的类型收窄**活不过箭头闭包**（`d` 是 map 回调的
            // 参数，编译器当它可变，`d.handle` 在 onClick 里又变回 `string | undefined`）。
            // 这不是洁癖——真实症状是 tsc 报 `string | undefined` 不能赋给弹窗的 `handle: string`，
            // 而单元测试照样绿（vitest 走 esbuild，不做类型检查），只有 `tsc --noEmit` 看得见。
            const handle = d.handle
            return (
              <span key={`${d.dirName}#${i}`}>
                {i > 0 && ', '}
                {handle
                  ? (
                    <button
                      type="button"
                      className="wb-unidentified-dir"
                      data-testid={`wb-unidentified-dir-${i}`}
                      aria-label={t('bind_open').replace('{dir}', d.dirName)}
                      onClick={() => setBinding({ dirName: d.dirName, handle })}
                    >{d.dirName}</button>
                  )
                  // 🔴 降级：`handle` 缺席（老后端 / 尚未接线）→ **渲成纯文本，不渲按钮**。
                  // 渲一个点了会 400 的按钮是在骗用户；而整条提示照旧显示，因为
                  // "有几个目录认不出来"这个结论不依赖 handle（见 api/contracts.ts 里
                  // 为什么不把它声明成致命字段）。这就是契约层的降级路径。
                  : <span data-testid={`wb-unidentified-plain-${i}`}>{d.dirName}</span>}
              </span>
            )
          })}
        </span>
        {/* 截断尾巴。`dirs` 只有前 8 个，总数一律读 dirCount——拿 dirs.length 当总数
            会在超过上限时对用户**少报**，而那正是这条提示最该说清楚的时刻。 */}
        {hiddenCount > 0 && (
          <span data-testid="wb-unidentified-more">
            {t('unidentified_more').replace('{n}', String(hiddenCount))}
          </span>
        )}
        {' '}
        {/* P6：处境那句。放在目录名**之后**——先给"是哪些"，再给"该怎么办"。
            Carbon 双通道：文字自己把话说全（去掉这一句，用户就不知道该不该动手）。 */}
        <span data-testid="wb-unidentified-reason">{t(reasonKey)}</span>
      </span>

      {/* 弹窗渲染在 `<span role="status">` **外面**：live region 里放可交互的模态是错的
          （读屏会把弹窗内容也当状态播报），且模态本身要 portal 到 body。 */}
      {binding && (
        <IdentifyBindDialog
          open
          onOpenChange={(v) => { if (!v) setBinding(null) }}
          dirName={binding.dirName}
          handle={binding.handle}
          onBound={() => { setBinding(null); onBound?.() }}
        />
      )}
    </>
  )
}
