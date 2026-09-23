// src/agent/identifyWorker.schemas.ts —— 识别 worker 的 finalize 契约。
//
// ── 为什么单独抽一个文件（2026-09-23）───────────────────────────────────────
// 这个 schema 原来内联在 `identifyWorker.ts` 的 `makeReasoningAgent({ schema })` 调用里，
// **没有任何测试能碰到它**——于是它和同一文件里的 prompt 讲了**互相矛盾**的两句话，
// 而这件事在生产里挂了很久没人发现（见下）。抽成常量之后 `.safeParse` 可以直接测。
//
// ── 🔴 这里修的是一个**反复复发**的缺陷类：「向模型索要系统没给它的数据」──────────
// 缺陷形态：prompt 明确让模型在某个合法情形下回 `null`，而 finalize 的 schema 拒收 null
// ⇒ 整份结论校验失败、`execute()` 永不运行、这一轮的工作**全部作废**，只剩一句被截断的错误。
//
// 本仓已记的同型前例（`findSubtitleWorker.schemas.ts:118`，2026-07-28 job 34）：
//   "系统亲手把 null 递给模型，finalize 却拒收它递回来的"——68 次 install 全成，
//   因为一个 `itemId: null` 整份报告被拒、152 秒收割成果全灭。
//
// 本次（第三例，生产实测 2026-09-23）：
//   `identifySystemPrompt` 明写
//     "If a directory truly cannot be identified (no TMDB match), call finalize with tmdbId=null"
//   而 schema 是 `tmdbId: z.string().regex(/^\d+$/)` ⇒ **null 必被拒**。
//   后果比前例更重：**每一条"诚实地承认认不出"的目录都必然走这条路**——不是偶发，
//   而是**结构性必经**。生产读数（runs.id=275/276）：
//     `[identity.tmdbId] Invalid input: expected string, received null`
//   于是"认不出"的目录长期积压、列表清不掉，而真正的诊断（模型那段 reason，
//   里面已经写清"文件名是 Moana 2026 / 目录名是乱码不是标题"）被整段丢掉。
//
// 结论：`tmdbId` 收 `string | null`。**认不出是合法结论，不是无效入参。**
// 注意**不许**放宽成"什么都收"：非空时仍必须是纯数字串（那是 TMDB id 的既有形状），
// 且 title/reason 照旧必填——只是不再要求"必须认出来"。
import { z } from 'zod'
import { nullableTolerant } from './coerce.js'

/**
 * identify worker 的 finalize 载荷。
 *
 * `tmdbId`：认出来了就是纯数字串；**认不出就是 null**（prompt 明许的那条路）。
 * 用 `nullableTolerant` 而不只是 `.nullable()`：真模型对"没有值"还会送
 * `"None"`/`"null"`/`""`，或**整个键省略**——那些同样必须折叠成 null 而不是炸掉这一轮
 * （同 `nullableTolerant` 头注释里已证的活体形态）。
 */
export const IdentifyFinalizeSchema = z.object({
  identity: z.object({
    tmdbId: nullableTolerant(z.string().regex(/^\d+$/)),
    // 认不出时 title 常为空串——**收下**，不设 `.min(1)`。认不出还硬要一个标题，
    // 就是又一次"向模型索要它拿不到的数据"。
    title: z.string(),
    // reason 必填且这是**有意的**：它是"认不出"这条结论唯一的解释面，
    // 放宽它等于把"为什么认不出"变成可选——那正是本次要修掉的那种沉默。
    reason: z.string(),
  }),
})

export type IdentifyFinalize = z.infer<typeof IdentifyFinalizeSchema>
