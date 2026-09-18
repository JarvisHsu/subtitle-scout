import { describe, it, expect } from 'vitest'
import { titleFromDir, searchCandidates, verifyEvidence, yearFromDir, yearFolderTypoOk, applyYearFolderTypoGate, hasSeasonToken } from './identify.js'
import type { FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'

describe('titleFromDir（目录名 → 标题）', () => {
  it('标准电影：Pulp Fiction (1994) → Pulp Fiction', () => {
    expect(titleFromDir('Pulp Fiction (1994)')).toBe('Pulp Fiction')
  })
  it('带 tmdb 标签：后室 (2026) {tmdb-1083381} → 后室', () => {
    expect(titleFromDir('后室 (2026) {tmdb-1083381}')).toBe('后室')
  })
  it('无年份：SPY x FAMILY → SPY x FAMILY', () => {
    expect(titleFromDir('SPY x FAMILY')).toBe('SPY x FAMILY')
  })
  it('中文剧：绝命毒师 (2008) → 绝命毒师', () => {
    expect(titleFromDir('绝命毒师 (2008)')).toBe('绝命毒师')
  })
  // 2026-08-27 实测（用户第一次真人跑 setup）：中文环境的文件管理器常产出全角括号，
  // 半角字符类认不出 U+FF08/U+FF09，目录整体识别失败。混用（一半全角一半半角）更糟：
  // 只吞掉一半，留下孤儿括号。
  it('全角括号：Invasion（2021）→ Invasion', () => {
    expect(titleFromDir('Invasion（2021）')).toBe('Invasion')
  })
  it('混用括号：Invasion（2021) → Invasion（不留孤儿括号）', () => {
    expect(titleFromDir('Invasion（2021)')).toBe('Invasion')
    expect(titleFromDir('Invasion (2021）')).toBe('Invasion')
  })
  it('中文标题 + 全角括号：流浪地球（2019）→ 流浪地球', () => {
    expect(titleFromDir('流浪地球（2019）')).toBe('流浪地球')
  })
  it('全角方括号【】（[] 的中文形态）：流浪地球【2019】→ 流浪地球', () => {
    expect(titleFromDir('流浪地球【2019】')).toBe('流浪地球')
  })
  it('全角括号 + tmdb 标签：标签剥离不受影响', () => {
    expect(titleFromDir('后室（2026）{tmdb-1083381}')).toBe('后室')
  })
})

// 2026-08-13 补：`searchCandidates` 此前被 import 却**零断言**（清理时由 noUnusedLocals
// 抓出）。它不是可删的多余 import——它是生产活体：identifyWorker 的 prompt 里那行
// `Search candidates: ${candidates.join(' | ')}` 就是它的产出，agent 拿它去搜 TMDB。
// 一个决定"识别 agent 拿什么词去搜"的函数在本文件里一条覆盖都没有，属于测试漏洞而非死代码，
// 故补这一组，而不是把 import 删掉。
describe('searchCandidates（目录名 → TMDB 搜索候选）', () => {
  it('带年份：清洗后的标题排第一，原目录名作为第二候选保留', () => {
    // 顺序有语义：primary（titleFromDir 清洗过的）在前，agent 优先用它搜。
    expect(searchCandidates('Pulp Fiction (1994)')).toEqual(['Pulp Fiction', 'Pulp Fiction (1994)'])
  })
  it('无年份：清洗结果与原名相同 → 去重成一个候选（Set 去重，不产出重复搜索词）', () => {
    expect(searchCandidates('SPY x FAMILY')).toEqual(['SPY x FAMILY'])
  })
  it('带 tmdb 标签：标签被清掉，原名仍保留（万一 TMDB 认得完整形态）', () => {
    expect(searchCandidates('后室 (2026) {tmdb-1083381}')).toEqual(['后室', '后室 (2026) {tmdb-1083381}'])
  })
  it('空白目录名 → 空数组（不产出空字符串候选，否则 agent 会拿空串去搜）', () => {
    expect(searchCandidates('   ')).toEqual([])
  })
})

describe('verifyEvidence（双证据核验）', () => {
  it('名字 + 年份吻合 → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:680', title: 'Pulp Fiction', originalTitle: 'Pulp Fiction', year: 1994, mediaType: 'movie' },
      { dirName: 'Pulp Fiction (1994)', fileCount: 1, seasons: [], hasSeasonDirs: false },
      'Pulp Fiction',
    )).toEqual({ ok: true })
  })
  it('名字 + 类型（TV 目录 + 季目录）→ 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:1396', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008, mediaType: 'tv' },
      { dirName: 'Breaking Bad (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      'Breaking Bad',
    )).toEqual({ ok: true })
  })
  it('中文目录名配 TMDB 中文别名 → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:1396', title: 'Breaking Bad', originalTitle: 'Breaking Bad', year: 2008, mediaType: 'tv' },
      { dirName: '绝命毒师 (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      '绝命毒师',
      ['绝命毒师', '绝命毒师 第一季'],
    )).toEqual({ ok: true })
  })
  it('名字不匹配 → 拒绝', () => {
    expect(verifyEvidence(
      { id: 'tmdb:999', title: 'Wrong Show', originalTitle: 'Wrong Show', year: 2008, mediaType: 'tv' },
      { dirName: '绝命毒师 (2008)', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      '绝命毒师',
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })
  it('名字匹配但无独立证据 → 拒绝', () => {
    expect(verifyEvidence(
      { id: 'tmdb:680', title: 'Pulp Fiction', originalTitle: null, year: null, mediaType: 'movie' },
      { dirName: 'Pulp Fiction', fileCount: 50, seasons: [], hasSeasonDirs: false },
      'Pulp Fiction',
    )).toEqual({ ok: false, reason: expect.stringContaining('no independent') })
  })
})

// D-2 修复（2026-09-18，openspec `improve-media-recognition`）：标题门的"≥5 字符显著性"对含
// CJK 的标题是**错的门**——归一后的中文标题通常 2~4 字，永远够不到 5 字下限，于是包含匹配
// 从未在中文字幕上执行过，所有中文目录一律判 title mismatch。
// 生产实案（2026-09-16）：17 个"认不出来"的目录绝大多数是这个原因，约 160 条；
// `evidence-fail: title mismatch: candidate="Narcos" vs dir="[毒枭][全1-3季]…"`，
// 而 TMDB TV 63351 `Narcos` 的 zh 译名正是 `毒枭`——**目录名的字面前缀**。
// 修法：含 CJK 的候选只要求归一后互为子串（取消 5 字下限）；纯拉丁侧行为一字不改。
describe('verifyEvidence 的 CJK 标题门（D-2：取消对中文短标题的 5 字符下限）', () => {
  const narcos = {
    id: 'tmdb:63351', title: 'Narcos', originalTitle: 'Narcos',
    year: 2015, mediaType: 'tv' as const, episodeCount: 30,
  }

  it('🔴 生产实案：2 字中文译名 `毒枭` 是污染目录名的字面前缀 → 通过（旧门必拒）', () => {
    // 目录无年份、但带季目录 → 独立证据来自"类型"这一条；断言聚焦在
    // "短中文标题不再被 5 字门拦掉"，故用带季目录的形态让第二道有据可依。
    expect(verifyEvidence(
      narcos,
      { dirName: '[毒枭][全1-3季][1080p]', fileCount: 30, seasons: [1, 2, 3], hasSeasonDirs: true },
      '[毒枭][全1-3季][1080p]',
      ['毒枭'],
    )).toEqual({ ok: true })
  })

  it('4 字中文译名 `西部世界` 作为字面前缀 → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:63247', title: 'Westworld', originalTitle: 'Westworld', year: 2016, mediaType: 'tv', episodeCount: 36 },
      { dirName: '西部世界 第一季', fileCount: 10, seasons: [1], hasSeasonDirs: true },
      '西部世界 第一季',
      ['西部世界'],
    )).toEqual({ ok: true })
  })

  it('方向可逆：目录名是候选的子串也通过（`毒枭` ⊂ `毒枭 第一季`）', () => {
    expect(verifyEvidence(
      narcos,
      { dirName: '毒枭 第一季', fileCount: 10, seasons: [1], hasSeasonDirs: true },
      '毒枭 第一季',
      ['毒枭'],
    )).toEqual({ ok: true })
  })

  it('误放防线：2 字中文但**互不包含** → 仍然拒绝（`毒枭` vs `毒液`）', () => {
    expect(verifyEvidence(
      { id: 'tmdb:999', title: 'Venom', originalTitle: 'Venom', year: 2018, mediaType: 'movie' },
      { dirName: '毒枭 (2015)', fileCount: 10, seasons: [1], hasSeasonDirs: true },
      '毒枭',
      ['毒液'],
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })

  it('回归锁：纯拉丁短标题**保持**原行为（<5 字符仍不匹配）', () => {
    expect(verifyEvidence(
      { id: 'tmdb:1', title: 'Up', originalTitle: null, year: null, mediaType: 'tv', episodeCount: 1 },
      { dirName: 'Up (2009)', fileCount: 1, seasons: [1], hasSeasonDirs: true },
      'Up',
    )).toEqual({ ok: true }) // 相等分支命中，与本变更无关——保留作对照
    expect(verifyEvidence(
      { id: 'tmdb:2', title: 'It', originalTitle: null, year: null, mediaType: 'tv', episodeCount: 1 },
      { dirName: 'Its Always Sunny (2005)', fileCount: 1, seasons: [1], hasSeasonDirs: true },
      'Its Always Sunny',
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })

  it('CJK 侧放宽的是**标题门**，双证据条不放松：短中文标题 + 无任何结构证据 → 仍拒', () => {
    expect(verifyEvidence(
      { id: 'tmdb:63351', title: 'Narcos', originalTitle: 'Narcos', year: null, mediaType: 'movie', episodeCount: undefined },
      { dirName: '毒枭', fileCount: 50, seasons: [], hasSeasonDirs: false },
      '毒枭',
      ['毒枭'],
    )).toEqual({ ok: false, reason: expect.stringContaining('no independent') })
  })
})

// D-3 修复（2026-09-18，openspec `improve-media-recognition`）：把**高置信文件名**升为
// 一级标题证据。目录名会被发布组/网盘污染，而文件名往往干净——
// 生产实案 `G 爱G公寓5 (2020)`：目录名被注入 `G`，TMDB 的 zh 译名是 `爱情公寓`（不是目录名的
// 片段），于是"候选并入目录名比较"这种最弱形态照样 FAIL；而文件名 `Ipartment.S05E01…` 解析出
// 干净标题 `Ipartment`，与 TMDB 主标题 `iPartment` 归一后相等。
// 故标题证据做成**两条并列腿**：① 候选 vs 目录名  ② 候选 vs 高置信文件名标题。
describe('verifyEvidence 的文件名腿（D-3：高置信文件名升为一级标题证据）', () => {
  it('🔴 生产实案：目录名被注入 `G` 而文件名干净 → 目录名腿 FAIL、文件名腿 PASS', () => {
    const dir = 'G 爱G公寓5 (2020)'
    const facts = { dirName: dir, fileCount: 36, seasons: [5], hasSeasonDirs: true }
    // ① 只有目录名腿 → 拒绝（生产里这 36 个文件全被拒的原因）
    expect(verifyEvidence(
      { id: 'tmdb:84947', title: 'iPartment', originalTitle: 'iPartment', year: 2020, mediaType: 'tv' },
      facts,
      dir,
      ['爱情公寓'],
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
    // ② 补上文件名腿 → 通过
    expect(verifyEvidence(
      { id: 'tmdb:84947', title: 'iPartment', originalTitle: 'iPartment', year: 2020, mediaType: 'tv' },
      { ...facts, fileTitles: ['Ipartment'] },
      dir,
      ['爱情公寓'],
    )).toEqual({ ok: true })
  })

  it('另一实案：`Narcos.S01E01…` 的文件名标题与 TMDB 主标题相等', () => {
    expect(verifyEvidence(
      { id: 'tmdb:63351', title: 'Narcos', originalTitle: 'Narcos', year: 2015, mediaType: 'tv' },
      { dirName: '[毒枭][全1-3季][内嵌多国字幕][4K HDR][145G]', fileCount: 30, seasons: [1, 2, 3], hasSeasonDirs: true, fileTitles: ['Narcos'] },
      '[毒枭][全1-3季][内嵌多国字幕][4K HDR][145G]',
      ['毒枭'],
    )).toEqual({ ok: true })
  })

  it('🔴 误放防线：文件名腿**不**让无关候选通过（这正是它不依赖目录名的风险所在）', () => {
    expect(verifyEvidence(
      { id: 'tmdb:999', title: 'Completely Different Show', originalTitle: null, year: 2020, mediaType: 'tv' },
      { dirName: 'G 爱G公寓5 (2020)', fileCount: 36, seasons: [5], hasSeasonDirs: true, fileTitles: ['Ipartment'] },
      'G 爱G公寓5 (2020)',
      ['爱情公寓'],
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })

  it('双证据条不因文件名腿而放松：标题腿过了、但无任何结构证据 → 仍拒', () => {
    expect(verifyEvidence(
      { id: 'tmdb:84947', title: 'iPartment', originalTitle: null, year: null, mediaType: 'movie' },
      { dirName: 'G 爱G公寓5 (2020)', fileCount: 50, seasons: [], hasSeasonDirs: false, fileTitles: ['Ipartment'] },
      'G 爱G公寓5 (2020)',
      [],
    )).toEqual({ ok: false, reason: expect.stringContaining('no independent') })
  })

  it('fileTitles 缺席/空数组（旧调用点）→ 行为与 D-3 之前逐字一致', () => {
    const ev = { id: 'tmdb:680', title: 'Pulp Fiction', originalTitle: 'Pulp Fiction', year: 1994, mediaType: 'movie' as const }
    const base = { dirName: 'Pulp Fiction (1994)', fileCount: 1, seasons: [], hasSeasonDirs: false }
    expect(verifyEvidence(ev, base, 'Pulp Fiction')).toEqual({ ok: true })
    expect(verifyEvidence(ev, { ...base, fileTitles: [] }, 'Pulp Fiction')).toEqual({ ok: true })
  })
})

// D-4（2026-09-18）：目录名里的季/集标记 = "这是剧集"的独立结构证据，也参与类型推断。
// 误判方向很重要——把 movie 认成 tv 会让它被拿去查 tv 端点，正是要修的那个形状，
// 故**宁可漏认**（退回旧行为）也不误认：裸数字（年份 2004、编码 265、体积 521G）一律不算。
describe('hasSeasonToken（目录名 → 是否带季/集标记）', () => {
  it('中文季标记：全1-5季 / 全3季 / 第2季 / 第一季', () => {
    expect(hasSeasonToken('[爱情公寓][全1-5季+电影+番外篇][国语中字][4K高码][203G]')).toBe(true)
    expect(hasSeasonToken('苍穹浩瀚 全6季 4K.HDR&杜比视界')).toBe(true)
    expect(hasSeasonToken('某某剧 第2季')).toBe(true)
    expect(hasSeasonToken('某某剧 第一季')).toBe(true)
  })
  it('中文集数标记：全23集 / 共12集', () => {
    expect(hasSeasonToken('藏锋[杜比视界版本][全23集][国语配音+中文字幕]')).toBe(true)
    expect(hasSeasonToken('某剧 共12集')).toBe(true)
  })
  it('英文/缩写季标记：Season 3 / S01 / S01E01', () => {
    expect(hasSeasonToken('My Show Season 3 (2019)')).toBe(true)
    expect(hasSeasonToken('Show.S01.1080p')).toBe(true)
    expect(hasSeasonToken('Show.S01E01.1080p')).toBe(true)
  })
  it('🔴 误认防线：电影目录一律 false（裸数字不算季号）', () => {
    expect(hasSeasonToken('The.Batman.2022.2160p.UHD.BluRay.x265.10bit.HDR.DTS-HD.MA.TrueHD.7.1.Atmos-SWTYBLZ')).toBe(false)
    expect(hasSeasonToken('Troy.2004.DIRECTORS.CUT.Bluray.2160p.DTS-HDMA5.1.DoVi.HDR.x265.10bit-DreamHD')).toBe(false)
    expect(hasSeasonToken('Ice.Age.Collision.Course.2016.2160p.BluRay.REMUX.HEVC.DTS-HD.MA.TrueHD.7.1.Atmos-FGT')).toBe(false)
    expect(hasSeasonToken('The Mummy.2026.Remux.1080p.W')).toBe(false)
    expect(hasSeasonToken('龙餐馆')).toBe(false)
    expect(hasSeasonToken('狂赌之渊 (2017) {tmdb-72305}')).toBe(false)
  })
})

describe('yearFromDir', () => {
  it('标准年份', () => {
    expect(yearFromDir('Pulp Fiction (1994)')).toBe(1994)
    expect(yearFromDir('后室 (2026) {tmdb-1083381}')).toBe(2026)
  })
  it('无年份 → null', () => {
    expect(yearFromDir('SPY x FAMILY')).toBeNull()
  })
})

describe('normalize 的 × 变体（D×D vs DxD）', () => {
  it('High School D×D 与 High School DxD 匹配', () => {
    expect(verifyEvidence(
      { id: 'tmdb:45950', title: 'High School DxD', originalTitle: 'High School DxD', year: 2012, mediaType: 'tv' },
      { dirName: 'High School D×D', fileCount: 48, seasons: [1, 2, 3, 4], hasSeasonDirs: true },
      'High School D×D',
    )).toEqual({ ok: true })
  })
})

describe('verifyEvidence 的变音符号折叠（Amélie / Shōgun）', () => {
  it('Amélie vs Amelie → 通过（目录名常无变音）', () => {
    expect(verifyEvidence(
      { id: 'tmdb:194', title: 'Amélie', originalTitle: 'Le Fabuleux Destin d\'Amélie Poulain', year: 2001, mediaType: 'movie' },
      { dirName: 'Amelie (2001)', fileCount: 1, seasons: [], hasSeasonDirs: false },
      'Amelie',
    )).toEqual({ ok: true })
  })
  it('Shōgun vs Shogun → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:126308', title: 'Shōgun', originalTitle: 'Shōgun', year: 2024, mediaType: 'tv' },
      { dirName: 'Shogun (2024)', fileCount: 1, seasons: [1], hasSeasonDirs: true },
      'Shogun',
    )).toEqual({ ok: true })
  })
})

describe('verifyEvidence 的命名变体（模糊匹配）', () => {
  it('leetspeak：PLUR1BUS vs Pluribus → 通过', () => {
    expect(verifyEvidence(
      { id: 'tmdb:225171', title: 'Pluribus', originalTitle: 'Pluribus', year: 2025, mediaType: 'tv' },
      { dirName: 'PLUR1BUS', fileCount: 8, seasons: [1], hasSeasonDirs: true },
      'PLUR1BUS',
    )).toEqual({ ok: true })
  })
  it('完全无关的标题 → 拒绝（防幻觉）', () => {
    expect(verifyEvidence(
      { id: 'tmdb:999', title: 'SpongeBob', originalTitle: 'SpongeBob', year: 2024, mediaType: 'tv' },
      { dirName: 'Breaking Bad', fileCount: 62, seasons: [1, 2, 3, 4, 5], hasSeasonDirs: true },
      'Breaking Bad',
    )).toEqual({ ok: false, reason: expect.stringContaining('title mismatch') })
  })
})

describe('yearFolderTypoOk（目录年 vs TMDB 年差 1–2、同名无第二年）', () => {
  const casablancaHits = [
    { title: 'Casablanca', originalTitle: 'Casablanca', year: 1943 },
    { title: 'Casablanca: An Unlikely Classic', originalTitle: null, year: 2012 },
  ]

  it('Casablanca 1942 vs TMDB 1943、唯一整串同名 → true（副标题条目不算同名）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', casablancaHits)).toBe(true)
  })

  it('差 2 年同样 true', () => {
    expect(yearFolderTypoOk(1941, 1943, 'Casablanca', casablancaHits)).toBe(true)
  })

  it('年份完全一致 → false（不是 typo）', () => {
    expect(yearFolderTypoOk(1943, 1943, 'Casablanca', casablancaHits)).toBe(false)
  })

  it('差 ≥3 年 → false', () => {
    expect(yearFolderTypoOk(2013, 2023, 'The Conjuring', [
      { title: 'The Conjuring', originalTitle: null, year: 2023 },
    ])).toBe(false)
  })

  it('Dune 同名两个年份 → false（不得放行 1984/2021）', () => {
    expect(yearFolderTypoOk(1984, 2021, 'Dune', [
      { title: 'Dune', originalTitle: 'Dune', year: 1984 },
      { title: 'Dune', originalTitle: 'Dune', year: 2021 },
    ])).toBe(false)
  })

  it('同名两个年份且差 1 年 → false（独一性在 slack 窗口内仍否决）', () => {
    expect(yearFolderTypoOk(2020, 2021, 'Dune', [
      { title: 'Dune', originalTitle: 'Dune', year: 2020 },
      { title: 'Dune', originalTitle: 'Dune', year: 2021 },
    ])).toBe(false)
  })

  it('零同名 hits → false（fail-closed）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', [])).toBe(false)
  })

  it('dirYear 或 tmdbYear 缺席 → false', () => {
    expect(yearFolderTypoOk(null, 1943, 'Casablanca', casablancaHits)).toBe(false)
    expect(yearFolderTypoOk(1942, null, 'Casablanca', casablancaHits)).toBe(false)
  })

  it('claimedTitle 与 hits 无整串相等 → false', () => {
    expect(yearFolderTypoOk(2019, 2020, '寄生虫', [
      { title: 'Parasite', originalTitle: '기생충', year: 2020 },
    ])).toBe(false)
  })

  it('originalTitle 整串相等也算同名', () => {
    expect(yearFolderTypoOk(2019, 2020, 'Parasite', [
      { title: 'Gisaengchung', originalTitle: 'Parasite', year: 2020 },
    ])).toBe(true)
  })

  it('同名只有目录年、没有 TMDB 年 → false（独一性要对着绑定的 TMDB 年）', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', [
      { title: 'Casablanca', originalTitle: 'Casablanca', year: 1942 },
    ])).toBe(false)
  })

  it('同名 hit 年份为 null 不算第二年 → true', () => {
    expect(yearFolderTypoOk(1942, 1943, 'Casablanca', [
      { title: 'Casablanca', originalTitle: 'Casablanca', year: null },
    ])).toBe(true)
  })
})

function emptyReport(over: Partial<FindSubtitleBatchReport> = {}): FindSubtitleBatchReport {
  return { installed: [], no_safe_match: [], retry_later: [], hardsub_assumed: [], identity: null, ...over }
}

describe('applyYearFolderTypoGate', () => {
  const hits = [{ title: 'Casablanca', originalTitle: 'Casablanca', year: 1943 }]
  const bound = new Set(['tmdb:289'])

  it('已绑定 + identification-failed 年份 + typo ok → 从 no_safe_match 去掉并进 retry_later', () => {
    const report = emptyReport({
      no_safe_match: [{
        itemId: 'tmdb:289',
        reason: 'identification-failed: TMDB year 1943 does not match file year 1942; two-evidence bar not met',
      }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toEqual([])
    expect(out.retry_later[0]?.itemId).toBe('tmdb:289')
    expect(out.retry_later[0]?.reason).toMatch(/year-folder-typo/)
    expect(report.no_safe_match).toHaveLength(1)
    expect(out).not.toBe(report)
  })

  it('typo 不成立时原样返回', () => {
    const report = emptyReport({
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'identification-failed: year' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1984, tmdbYear: 2021, claimedTitle: 'Dune',
      hits: [
        { title: 'Dune', originalTitle: null, year: 1984 },
        { title: 'Dune', originalTitle: null, year: 2021 },
      ],
      boundItemIds: new Set(['tmdb:289']),
    })
    expect(out.no_safe_match).toHaveLength(1)
    expect(out.retry_later).toEqual([])
  })

  it('已装上则只剥 no_safe_match，不重复塞 retry_later', () => {
    const report = emptyReport({
      installed: [{
        itemId: 'tmdb:289', installedPath: '/x.srt', installedLanguage: 'zh',
        candidateProvider: 'assrt', candidateProviderId: '1', reason: 'ok',
      }],
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'identification-failed: year 1942' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toEqual([])
    expect(out.retry_later).toEqual([])
    expect(out.installed).toHaveLength(1)
  })

  it('真正源站没货（reason 不含 year/identification-failed）不动', () => {
    const report = emptyReport({
      no_safe_match: [{ itemId: 'tmdb:289', reason: 'no plausible candidate after search' }],
    })
    const out = applyYearFolderTypoGate(report, {
      dirYear: 1942, tmdbYear: 1943, claimedTitle: 'Casablanca', hits, boundItemIds: bound,
    })
    expect(out.no_safe_match).toHaveLength(1)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// 提案 3.4（2026-09-18）：`episodeCount` 结构证据腿。
//
// 🔴 验收标准不是"救回了那个实案"，而是「**救回它的同时，四条反例一条都没被误放**」
//    ——这条腿**只增加放行面、不减少**，所以反例断言才是它的真正护栏。
//    判据与反例表见 ops/servers/43.134.191.43/task-3.4-decision.md。
//
// 测试构造法：让**标题腿通过**（candidate.title === targetTitle），把年份设成与目录名不同、
// 且 dirFacts 无季子目录/无季标记 → 于是 ②③④ 与年份腿全部不命中，
// **只剩第 ⑤ 条腿能决定结果**。这样每条断言都精确地测第 ⑤ 条。
// ─────────────────────────────────────────────────────────────────────────────
describe('verifyEvidence · 第 ⑤ 条腿：单季最大集数（提案 3.4）', () => {
  const flat = (fileCount: number, dirName = 'iPartment') => ({
    dirName, fileCount, seasons: [] as number[], hasSeasonDirs: false,
    fileTitles: [] as string[], dirHasSeasonToken: false,
  })
  const cand = (episodeCount?: number) => ({
    id: 'tmdb:68809', title: 'iPartment', originalTitle: 'iPartment',
    year: 2011,            // ≠ 目录名里的年份（若有）→ 年份腿不命中
    mediaType: 'tv' as const, episodeCount,
  })

  it('✅ 救回实案 `G 爱G公寓5 (2020)`：36 文件 vs 单季 36 集 → 过', () => {
    const r = verifyEvidence(cand(36), flat(36, 'G 爱G公寓5 (2020)'), 'iPartment', [])
    expect(r.ok).toBe(true)
  })

  it('🔴 反例一：同一目录绑到**单季 10 集**的另一部剧 → 必须拒（36 不在 [5,20]）', () => {
    const r = verifyEvidence(cand(10), flat(36, 'G 爱G公寓5 (2020)'), 'iPartment', [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('no independent structural evidence')
  })

  it('🔴 反例二：合集目录（2 文件）配单季 13 集的剧 → 必须拒（2 不在 [7,26]）', () => {
    const r = verifyEvidence(cand(13), flat(2, '惩罚者 两部合集 4K REMUX原盘'), 'iPartment', [])
    expect(r.ok).toBe(false)
  })

  it('🔴 反例三：垃圾目录（1 文件）配任何多集剧 → 必须拒（下界挡住了它）', () => {
    for (const ep of [1, 5, 10, 40]) {
      const r = verifyEvidence(cand(ep), flat(1, '龙餐馆'), 'iPartment', [])
      expect(r.ok).toBe(false)
    }
  })

  it('🔴 反例四：movie **永不**走这条腿（episodeCount 再匹配也不放行）', () => {
    const movieCand = { ...cand(36), mediaType: 'movie' as const }
    // movie + 36 文件：④要求 fileCount ≤ 10，故也不命中 → 必须拒
    expect(verifyEvidence(movieCand, flat(36, 'iPartment'), 'iPartment', []).ok).toBe(false)
  })

  it('🔴 episodeCount 缺席（季表取不到）→ 行为与改动前**逐字一致**（腿不参与）', () => {
    const r = verifyEvidence(cand(undefined), flat(36, 'G 爱G公寓5 (2020)'), 'iPartment', [])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toBe('no independent structural evidence (year/type/episodes)')
  })

  it('边界：正好 0.5× 与 2× 都算同数量级（含边界，不是开区间）', () => {
    expect(verifyEvidence(cand(72), flat(36, 'x'), 'iPartment', []).ok).toBe(true)   // 36 === 0.5×72
    expect(verifyEvidence(cand(18), flat(36, 'x'), 'iPartment', []).ok).toBe(true)   // 36 === 2×18
    expect(verifyEvidence(cand(73), flat(36, 'x'), 'iPartment', []).ok).toBe(false)  // 36 < ceil(36.5)=37
    expect(verifyEvidence(cand(17), flat(36, 'x'), 'iPartment', []).ok).toBe(false)  // 36 > 34
  })
})