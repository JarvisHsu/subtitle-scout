// src/agent/identifyWorker.schemas.test.ts —— 识别 finalize 契约的用例。
//
// 这一条修的是一个**结构性必经**的拒收：prompt 明许 `tmdbId=null`，而 schema 只收数字串。
// 修之前生产里**每一条"认不出"的目录都必然**被判无效（runs.id=275/276 是现场读数），
// 模型的 reason（含"文件名是 Moana 2026、目录名是乱码"这种关键信息）被整段丢掉。
import { describe, it, expect } from 'vitest'
import { IdentifyFinalizeSchema } from './identifyWorker.schemas.js'
import { identifySystemPrompt } from './identifyWorker.js'

/** 认不出的真实形态（照抄生产 runs.id=275 的 raw args）。 */
const CANNOT_IDENTIFY = {
  identity: {
    tmdbId: null,
    title: 'AUDIO LIST ENG LATINO SPANISH FRENCH (CA)',
    reason:
      "The directory name is an audio-language listing descriptor, not a work title. "
      + "The only file suggests TMDB movie id 1108427 (Moana, 2026) but write_identified_media "
      + "rejected the binding with 'evidence-fail: title mismatch'.",
  },
}

describe('identify finalize：认不出（tmdbId=null）是**合法结论**', () => {
  it('🔴 tmdbId=null 必须被收下——prompt 第 156 行明许它', () => {
    const r = IdentifyFinalizeSchema.safeParse(CANNOT_IDENTIFY)
    expect(r.success, '认不出被拒收 = 这一轮的结论整段作废，这正是生产里的病').toBe(true)
    if (r.success) {
      expect(r.data.identity.tmdbId).toBeNull()
      // reason 必须**原样**留存：它是"为什么认不出"唯一的解释面
      expect(r.data.identity.reason).toContain('1108427')
    }
  })

  it('🔴 串编码的 null 哨兵也要折叠成 null（真模型会这么送）', () => {
    for (const sentinel of ['None', 'null', '']) {
      const r = IdentifyFinalizeSchema.safeParse({
        identity: { tmdbId: sentinel, title: '', reason: 'no match' },
      })
      expect(r.success, `哨兵 ${JSON.stringify(sentinel)} 被拒了`).toBe(true)
      if (r.success) expect(r.data.identity.tmdbId).toBeNull()
    }
  })

  it('🔴 整个 tmdbId 键省略（模型直接不给）也不许炸这一轮', () => {
    const r = IdentifyFinalizeSchema.safeParse({
      identity: { title: 'x', reason: 'no match' },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.identity.tmdbId).toBeNull()
  })

  it('title 为空串也收下（认不出时本来就没有标题，硬要一个就是向模型索要它拿不到的数据）', () => {
    const r = IdentifyFinalizeSchema.safeParse({ identity: { tmdbId: null, title: '', reason: 'r' } })
    expect(r.success).toBe(true)
  })
})

describe('identify finalize：**不许**放宽成"什么都收"', () => {
  it('认出来了 → 纯数字串照旧通过', () => {
    const r = IdentifyFinalizeSchema.safeParse({
      identity: { tmdbId: '1108427', title: 'Moana', reason: 'title + year match' },
    })
    expect(r.success).toBe(true)
    if (r.success) expect(r.data.identity.tmdbId).toBe('1108427')
  })

  it('🔴 非数字串照旧**拒收**（tmdbId 的形状没变）', () => {
    for (const bad of ['tmdb:1108427', 'abc', '12a', '-1']) {
      const r = IdentifyFinalizeSchema.safeParse({
        identity: { tmdbId: bad, title: 'x', reason: 'r' },
      })
      expect(r.success, `${bad} 不该被收下`).toBe(false)
    }
  })

  it('🔴 reason 缺失照旧拒收（"认不出"必须带理由，否则又是一片沉默）', () => {
    const r = IdentifyFinalizeSchema.safeParse({ identity: { tmdbId: null, title: 'x' } })
    expect(r.success).toBe(false)
  })

  it('整体形状不对（identity 都不给）照旧拒收', () => {
    expect(IdentifyFinalizeSchema.safeParse({}).success).toBe(false)
    expect(IdentifyFinalizeSchema.safeParse({ identity: 'nope' }).success).toBe(false)
  })
})

describe('🔴 契约一致性：prompt 说的与 schema 收的必须是同一件事', () => {
  it('prompt 明许 tmdbId=null ⇒ schema 必须收 null（本次修的正是这条不自洽）', () => {
    const prompt = identifySystemPrompt(false)
    // 这一句是 schema 必须放行 null 的**依据**；它被改写时本用例会提醒后来人同步 schema。
    expect(prompt).toMatch(/call finalize with tmdbId=null/i)
    const r = IdentifyFinalizeSchema.safeParse({
      identity: { tmdbId: null, title: '', reason: 'no TMDB match' },
    })
    expect(
      r.success,
      'prompt 让模型回 null 而 schema 拒收 null —— 这就是 job 34 itemId 那个缺陷类的第三次复发',
    ).toBe(true)
  })
})
