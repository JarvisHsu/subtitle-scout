import { describe, it, expect } from 'vitest'
import { findExternalSidecar, languageForTag, KNOWN_LANGUAGE_TAGS, listSidecarLanguages, listTargetSidecarNames } from './sidecar.js'
import { tagsForLanguage } from '../agent/languages.js'

// P0(zimuku 单源大考前置,2026-07-19):BCP-47 地区变体 tag 的语言换算与探测接线。
// 区码→简繁:CN/SG=简体(zh-Hans),TW/HK=繁体(zh-Hant);小写形态=Bazarr 装机遗留惯例。
describe('languageForTag — BCP-47 地区变体', () => {
  it.each([
    ['zh-CN', 'zh-Hans'], ['zh-cn', 'zh-Hans'],
    ['zh-SG', 'zh-Hans'], ['zh-sg', 'zh-Hans'],
    ['zh-TW', 'zh-Hant'], ['zh-tw', 'zh-Hant'],
    ['zh-HK', 'zh-Hant'], ['zh-hk', 'zh-Hant'],
  ])('%s → %s', (tag, lang) => {
    expect(languageForTag(tag)).toBe(lang)
  })

  it('KNOWN_LANGUAGE_TAGS(传播 EEXIST 分支的"认不认识"判据)包含全部地区变体', () => {
    for (const t of ['zh-CN', 'zh-cn', 'zh-TW', 'zh-tw', 'zh-HK', 'zh-hk', 'zh-SG', 'zh-sg']) {
      expect(KNOWN_LANGUAGE_TAGS).toContain(t)
    }
  })
})

describe('findExternalSidecar × tagsForLanguage 接线(P0 生产场景)', () => {
  it('盘上只有 .zh-CN.srt(agent 白名单装机形态) → 目标含 zh 命中,语言 zh-Hans', () => {
    const disk = new Set(['/media/T/ep1.zh-CN.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-CN.srt', language: 'zh-Hans' })
  })

  it('盘上只有 .zh-cn.srt(Bazarr 遗留小写) → 同样命中', () => {
    const disk = new Set(['/media/T/ep1.zh-cn.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-cn.srt', language: 'zh-Hans' })
  })

  it('繁体区码 .zh-TW.srt → 语言换算 zh-Hant', () => {
    const disk = new Set(['/media/T/ep1.zh-TW.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit).toEqual({ path: '/media/T/ep1.zh-TW.srt', language: 'zh-Hant' })
  })

  it('规范形态优先:.zh-Hans.srt 与 .zh-CN.srt 并存 → 返回 zh-Hans 那份(tag 序在前)', () => {
    const disk = new Set(['/media/T/ep1.zh-Hans.srt', '/media/T/ep1.zh-CN.srt'])
    const hit = findExternalSidecar('/media/T/ep1.mkv', tagsForLanguage('zh'), p => disk.has(p))
    expect(hit!.path).toBe('/media/T/ep1.zh-Hans.srt')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// R-F15 缺口②：listSidecarLanguages——记录**全部**外挂字幕语言，不只当前目标语言。
//
// 用户原话：「关于资源的字幕情况，需要在一开始就记录下来，每个资源有哪些字幕，这样在用户
// 更换目标语言后，数据库能反应过来。」
//
// 与 findExternalSidecar 的**语义分工**（两者刻意并存，不是新旧替换）：
//  · findExternalSidecar 回答「当前目标语言的字幕在不在」——单个布尔判据，服务 sub_status。
//  · listSidecarLanguages 回答「这个视频旁边一共有哪些语言的字幕」——与当前配置**无关**的
//    磁盘事实（同 KNOWN_LANGUAGE_TAGS 头注释确立的口径：认不认识这个 tag ≠ 用户现在要不要
//    这个语言）。正因为与配置无关，换目标语言后才能不重新扫盘就重判。
//
// 机制换成 readdir 而不是继续逐个 fileExists：目标语言之外的语言无法枚举 tag（"所有语言"
// 没有有限 tag 集），且现状"15 tag × 4 ext = 60 次 stat/文件"在未命中时全额付费——而未命中
// 恰恰是"需要找字幕"那批（生产主力）。实测（本地 tmpfs，24 个视频的季目录、无中字）：
// 逐个 existsSync 1440 次 syscall / 5.82ms，readdir+缓存 1 次 / 0.22ms，快 26 倍。
// ─────────────────────────────────────────────────────────────────────────────
describe('🔴 listSidecarLanguages（R-F15 缺口② · 记录全部外挂字幕语言）', () => {
  const readdirOf = (names: string[]) => () => names

  it('🔴 目标是 zh，但盘上只有 .en.srt → 照样记下 en（核心：非目标语言也必须被看见）', () => {
    // 这一条就是缺口②的本体。修复前系统只搜 tagsForLanguage('zh')，那条 .en.srt 完全隐形，
    // 用户把目标改成 en 之后会**重新找一遍**一个磁盘上早就有的字幕（烧付费 LLM）。
    const langs = listSidecarLanguages('/media/T/ep1.mkv', readdirOf(['ep1.mkv', 'ep1.en.srt']))
    expect(langs).toEqual(['en'])
  })

  it('🔴 一个视频旁边多条不同语言字幕 → 全部记录（去重 + 稳定排序）', () => {
    const langs = listSidecarLanguages('/media/T/ep1.mkv', readdirOf([
      'ep1.mkv', 'ep1.zh-Hans.srt', 'ep1.en.srt', 'ep1.ja.ass', 'ep1.ko.vtt',
    ]))
    expect(langs).toEqual(['en', 'ja', 'ko', 'zh-Hans'])
  })

  it('🔴 三字母/别名 tag 折回主语言码（eng→en、jpn→ja、chs→zh-Hans）', () => {
    // 复用 languageForTag 这一份既有换算表，不另写第二份——本仓已因"留两份漂移实现"栽过
    // （C30 两处标签集各漏一半）。注意 chs/cht 正是 langOf 折不动的那两个（langOf('chs')
    // 返回 'chs' 而非 'zh'），只靠 langOf 会漏判，故走 LANGUAGE_BY_TAG。
    const langs = listSidecarLanguages('/media/T/ep1.mkv', readdirOf([
      'ep1.mkv', 'ep1.eng.srt', 'ep1.jpn.srt', 'ep1.chs.srt', 'ep1.cht.srt',
    ]))
    expect(langs).toEqual(['en', 'ja', 'zh-Hans', 'zh-Hant'])
  })

  it('🔴 无语言标记的裸字幕 `ep1.srt` → 计为 und，不冒充任何语言', () => {
    // 不许把它猜成目标语言：那正是"把中间量说成结论量"。und 是诚实的"有一条字幕但不知道
    // 什么语言"，重判时它不满足任何目标语言 → 不会让系统误以为已覆盖。
    expect(listSidecarLanguages('/media/T/ep1.mkv', readdirOf(['ep1.mkv', 'ep1.srt']))).toEqual(['und'])
  })

  it('🔴 别的视频的字幕不许误归属（C30 的 `X.1080p.zh.srt` 误归给 `X.mkv`）', () => {
    // stem 必须整段精确匹配到下一个点，不能用 startsWith(stem + '.') 之后放任中间段。
    const langs = listSidecarLanguages('/media/T/ep1.mkv', readdirOf([
      'ep1.mkv', 'ep1.en.srt', 'ep1.1080p.zh.srt', 'ep10.ja.srt', 'ep2.ko.srt',
    ]))
    expect(langs).toEqual(['en'])
  })

  it('🔴 非字幕扩展名一律不计（.nfo/.jpg/.mkv 本身）', () => {
    const langs = listSidecarLanguages('/media/T/ep1.mkv', readdirOf([
      'ep1.mkv', 'ep1.en.nfo', 'ep1.zh-Hans.jpg', 'ep1.en.srt',
    ]))
    expect(langs).toEqual(['en'])
  })

  it('🔴 目录读不了（FUSE 抖动抛错）→ 返回 null，不是 []', () => {
    // 三态契约与 streamProbe / embedded_langs 一脉相承：null=没观察到，[]=观察过确认零条。
    // 折叠成 [] 会把一次挂载抖动记成"这个视频一条字幕都没有"，换语言重判时据此重新找一遍。
    const langs = listSidecarLanguages('/media/T/ep1.mkv', () => { throw new Error('EIO') })
    expect(langs).toBeNull()
  })

  it('🔴 目录里确实一条字幕都没有 → []（观察过、确认为空，与 null 严格区分）', () => {
    expect(listSidecarLanguages('/media/T/ep1.mkv', readdirOf(['ep1.mkv']))).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// #1 修复（2026-09-18）：onListing sink 与 listTargetSidecarNames。
//
// 存在理由是一条**性能契约**：清理编号重复字幕需要知道"原件叫什么文件名"，
// 而 listSidecarLanguages 只返回语言集合、把文件名丢了。让调用方自己再 readdir 一次，
// 就把"一趟 readdir 产出多个结论"的收益抵消掉了（本文件上方用 26 倍实测论证过这条）。
// 所以用 sink 把同一份清单交出来、在内存里挑。
// ─────────────────────────────────────────────────────────────────────────────
describe('onListing sink 与 listTargetSidecarNames', () => {
  const listingOf = (names: string[]) => () => names

  it('sink 拿到与语言判定**同一份**清单（不是再读一次目录）', () => {
    const names = ['ep1.mkv', 'ep1.zh-Hans.ass', 'ep1.en.srt']
    let calls = 0
    let captured: string[] | null = null

    const langs = listSidecarLanguages('/media/T/ep1.mkv', () => { calls++; return names }, (n) => { captured = n })

    expect(calls).toBe(1)                       // 🔴 只 readdir 一次
    expect(captured).toEqual(names)
    expect(langs).toEqual(['en', 'zh-Hans'])
  })

  it('目录读不了时不调 sink（没观察到就没有清单可交）', () => {
    let called = false
    const langs = listSidecarLanguages('/media/T/ep1.mkv', () => { throw new Error('EIO') }, () => { called = true })
    expect(langs).toBeNull()
    expect(called).toBe(false)
  })

  it('sink 是可选的（既有调用点一字不改）', () => {
    expect(listSidecarLanguages('/media/T/ep1.mkv', listingOf(['ep1.zh-Hans.ass']))).toEqual(['zh-Hans'])
  })

  it('listTargetSidecarNames 只挑**规范件**：编号重复品不算目标字幕（它是兄弟，由清理负责）', () => {
    const names = [
      'ep1.mkv',
      'ep1.zh-Hans.ass',      // ✅ 目标
      'ep1.zh-Hant.srt',      // ✅ 繁体也算 zh（coverageValuesFor 的既有值域）
      'ep1.en.srt',           // ✗ 别的语言
      'ep2.zh-Hans.ass',      // ✗ 别的视频
      'ep1.zh-Hans(1).ass',   // ✗ 它的 tag 是 `zh-Hans(1)`——不是语言标记
    ]
    const got = listTargetSidecarNames('/media/T/ep1.mkv', names, new Set(['zh-Hans', 'zh-Hant']))
    expect(got).toEqual(['ep1.zh-Hans.ass', 'ep1.zh-Hant.srt'])

    // 🔴 这里要看清两层关系，否则会误以为漏了重复品（我第一版期望就写错了）：
    //   · 本函数回答"**有哪些**目标语言字幕" → 只出规范件（`ep1.zh-Hans.ass`）
    //   · 重复品 `ep1.zh-Hans(1).ass` 是**那个规范件的兄弟**，由 cleanupNumberedDuplicates
    //     拿着同一份清单、按 `<规范件名>(n)<ext>` 正则找到并逐字节比对后清除
    //   · 所以"重复品不在本函数的返回值里"是**正确行为**，不是遗漏：把它当成一条独立的
    //     目标字幕，清理逻辑就会去给它找一个并不存在的"原件"。
    expect(got).not.toContain('ep1.zh-Hans(1).ass')
  })

  it('tag 含点（多段）的条目仍不归本视频（C30 口径在抽取函数里只留一份）', () => {
    const names = ['ep1.zh-Hans.ass', 'ep1.zh-Hans.forced.ass']
    expect(listTargetSidecarNames('/media/T/ep1.mkv', names, new Set(['zh-Hans'])))
      .toEqual(['ep1.zh-Hans.ass'])
  })

  it('无后缀标记（`ep1.ass`，语言未定）在目标集含 und 时被挑中', () => {
    expect(listTargetSidecarNames('/media/T/ep1.mkv', ['ep1.ass'], new Set(['und']))).toEqual(['ep1.ass'])
    expect(listTargetSidecarNames('/media/T/ep1.mkv', ['ep1.ass'], new Set(['zh-Hans']))).toEqual([])
  })

  it('空清单 → 空结果（不抛）', () => {
    expect(listTargetSidecarNames('/media/T/ep1.mkv', [], new Set(['zh-Hans']))).toEqual([])
  })
})
