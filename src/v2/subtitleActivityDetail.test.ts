// REQ-1a 派生层的用例。**所有 fixture 都照抄生产 `runs.trace_json` 的真实形状**
// （见 evidence/req1a-trace-shape.mjs 的输出），不是我自己编的"应该长什么样"。
import { describe, expect, it } from 'vitest'
import type { TraceEvent } from '../core/traceBus.js'
import {
  accumulateDetail, deriveSubtitleActivityDetail, detailFromEvent, detailViewFor,
} from './subtitleActivityDetail.js'

const at = (seq: number): number => 1_700_000_000_000 + seq

function ev(tool: string, args: unknown, result: unknown, tookMs = 100, seq = 0): TraceEvent {
  return {
    runKey: 'job-subtitle:tmdb:121860',
    seq,
    tool,
    argsSummary: typeof args === 'string' ? args : JSON.stringify(args),
    resultSummary: typeof result === 'string' ? result : JSON.stringify(result),
    tookMs,
    at: at(seq),
  }
}

// 生产事实：search_source 带 season/episode；download_candidate 的 args 里有 videoFilename 与 itemId
const FILES = [
  { filename: '[Kakegurui Twin ep07]V2.mp4', season: 1, episode: 7 },
  { filename: '[Kakegurui Twin ep08]V2.mp4', season: 1, episode: 8 },
]

const SEARCH_S1E7 = ev('search_source', { queries: ['狂赌之渊：双'], season: 1, episode: 7 }, { count: 44, result_set_id: 'r1' }, 5077, 1)
const DOWNLOAD_E7 = ev('download_candidate', {
  candidateId: 'subhd:kA7BFK', fileIndex: null, videoFilename: '[Kakegurui Twin ep07]V2.mp4', itemId: 'tmdb:121860/s1e7',
}, { error: 'subhd prepare-download failed: {"success":false,"message":"服务器内部错误，请稍后再试。"}' }, 24242, 2)
const DOWNLOAD_E8_OK = ev('download_candidate', {
  candidateId: 'zimuku:192411', fileIndex: '3', videoFilename: '[Kakegurui Twin ep08]V2.mp4', itemId: null,
}, { stagedFileId: 'x', fileList: [] }, 8000, 3)
const SEARCH_SAFE = ev('check_episode_code_safety', { filename: '[Kakegurui Twin ep07]V2.mp4', season: 2, episode: 12 },
  { safe: false, expectedCode: 'S02E12' }, 96629, 4)

describe('REQ-1a 派生：谁能指向"某个文件"', () => {
  it('search_source 带 season/episode → 只认它指的那一集（不认别的集）', () => {
    expect(detailFromEvent(SEARCH_S1E7, FILES[0]!)).not.toBeNull()
    expect(detailFromEvent(SEARCH_S1E7, FILES[1]!), 'ep07 的搜索不许算到 ep08 头上').toBeNull()
  })

  it('search_source 报出候选数（生产实测 count=44）', () => {
    expect(detailFromEvent(SEARCH_S1E7, FILES[0]!)?.note).toBe('找到 44 个候选')
  })

  it('download_candidate 用 videoFilename 定位文件，源站取自 candidateId 前缀', () => {
    const v = detailFromEvent(DOWNLOAD_E7, FILES[0]!)
    expect(v?.source).toBe('subhd')
    expect(detailFromEvent(DOWNLOAD_E7, FILES[1]!), 'ep07 的下载不许算到 ep08 头上').toBeNull()
  })

  it('🔴 下载失败要给出**人话理由**（把 provider 的 JSON message 取出来，不留 curl 命令行）', () => {
    expect(detailFromEvent(DOWNLOAD_E7, FILES[0]!)?.note).toBe('下载失败：服务器内部错误，请稍后再试。')
  })

  it('🔴 下载成功不写 note（成功由格子变 installed 表达，复述是噪音）', () => {
    expect(detailFromEvent(DOWNLOAD_E8_OK, FILES[1]!)?.note).toBeNull()
  })

  it('source 与 note 同一口径：本条没告诉我们 → 保留上一次知道的（不许抹成空白）', () => {
    let d = accumulateDetail(undefined, { step: 'download_candidate', source: 'subhd', note: '下载失败：x', ms: 10 }, 'download_candidate')
    // 后继动作既没有源站也没有摘要（如装盘）——两样都该保留
    d = accumulateDetail(d, { step: 'install_subtitle', source: null, note: null, ms: 5 }, 'install_subtitle')
    expect(d.source).toBe('subhd')
    expect(d.note).toBe('下载失败：x')
    expect(d.step).toBe('install_subtitle')
  })

  it('check_episode_code_safety 用自己的 filename 定位，判不安全时说出应为什么', () => {
    expect(detailFromEvent(SEARCH_SAFE, FILES[0]!)?.note).toBe('季集号不安全（应为 S02E12）')
  })

  it('🔴 识别类工具（search_tmdb/get_tmdb_details/read_doc/finalize）不许冒充文件动作', () => {
    for (const tool of ['search_tmdb', 'get_tmdb_details', 'read_doc', 'finalize', 'write_identified_media']) {
      expect(detailFromEvent(ev(tool, {}, {}), FILES[0]!), `${tool} 不该指向文件`).toBeNull()
    }
  })

  it('args 不是 JSON（真实边界）→ 不抛错、返回 null', () => {
    expect(detailFromEvent(ev('download_candidate', 'not json at all', {}), FILES[0]!)).toBeNull()
    expect(detailFromEvent(ev('search_source', '', ''), FILES[0]!)).toBeNull()
  })
})

function expectDetail(m: Map<string, any>, key: string) {
  const d = m.get(key)
  expect(d, `缺少 ${key} 的 detail`).toBeDefined()
  return d
}

describe('REQ-1a 派生：按文件汇总', () => {
  it('🔴 逐文件各归各：ep07 的失败与 ep08 的成功不许串格', () => {
    const m = deriveSubtitleActivityDetail([SEARCH_S1E7, DOWNLOAD_E7, DOWNLOAD_E8_OK], FILES, 'tmdb:121860')
    const d7 = expectDetail(m, 's1e7')
    const d8 = expectDetail(m, 's1e8')
    expect(d7.step).toBe('download_candidate')
    expect(d7.source).toBe('subhd')
    expect(d7.note).toBe('下载失败：服务器内部错误，请稍后再试。')
    expect(d8.step).toBe('download_candidate')
    expect(d8.source).toBe('zimuku')
    expect(d8.note).toBeNull()
  })

  it('累计耗时是**干活时间**（各次 tookMs 之和），不是墙上时间', () => {
    const m = deriveSubtitleActivityDetail([SEARCH_S1E7, DOWNLOAD_E7], FILES, 'tmdb:121860')
    expect(expectDetail(m, 's1e7').ms).toBe(5077 + 24242)
  })

  it('steps 去重保序、sources 去重保序，searched 只数 search_source', () => {
    const again = ev('download_candidate', {
      candidateId: 'subhd:kA7BFK', videoFilename: '[Kakegurui Twin ep07]V2.mp4',
    }, { error: 'x' }, 1000, 5)
    const m = deriveSubtitleActivityDetail([SEARCH_S1E7, DOWNLOAD_E7, again], FILES, 'tmdb:121860')
    const d = expectDetail(m, 's1e7')
    expect(d.steps).toEqual(['search_source', 'download_candidate'])
    expect(d.sources).toEqual(['subhd'])
    expect(d.searched).toBe(1)
  })

  it('一个动作都没有的文件 → 全 null / 空数组（**不许编**"正在搜索"）', () => {
    const m = deriveSubtitleActivityDetail([SEARCH_S1E7], FILES, 'tmdb:121860')
    const d8 = expectDetail(m, 's1e8')
    expect(d8.step).toBeNull()
    expect(d8.source).toBeNull()
    expect(d8.note).toBeNull()
    expect(d8.ms).toBe(0)
    expect(d8.steps).toEqual([])
  })

  it('电影（无季集）→ key 是 movie', () => {
    const movie = [{ filename: 'The Mummy.2026.Remux.1080p.W.mkv', season: null, episode: null }]
    const dl = ev('download_candidate', { candidateId: 'subhd:58pnuQ', videoFilename: movie[0]!.filename }, { error: 'e' })
    const m = deriveSubtitleActivityDetail([dl], movie, 'tmdb:1662599')
    expect([...m.keys()]).toEqual(['movie'])
    expect(expectDetail(m, 'movie').source).toBe('subhd')
  })
})

describe('REQ-1a 实时桥接（增量口径）', () => {
  it('🔴 实时增量与事后全量**必须算出同一个答案**（两份实现必漂移的防线）', () => {
    // ⚠️ 顺序照真实时间轴：搜索在前、下载在后。上一次我把 SEARCH_SAFE 放在最后，
    //    于是它（无源站、无摘要）成了"最近一条"——那暴露出的正是 source 与 note
    //    两个字段该不该"缺席保留"的口径不一致，已按同一口径修掉。
    const events = [SEARCH_S1E7, DOWNLOAD_E7]
    // 全量：**每个文件都有一条**（没有动作的文件给全 null —— 前端据此画"还没动"）
    const full = deriveSubtitleActivityDetail(events, FILES, 'tmdb:121860')
    // 增量：只在有事件命中时才建条目
    const inc = new Map<string, any>()
    for (const e of events) {
      const view = detailViewFor(e, FILES, 'tmdb:121860')
      if (view === null) continue
      inc.set(view.key, accumulateDetail(inc.get(view.key), view.event, view.tool))
    }

    // 契约不是"两个 Map 形状相同"（全量多出"从没动过"的格子，那是它的职责），
    // 而是**对同一个 key，两边算出的 detail 逐字段一致**。生产里 targetsState 预置了全部 key，
    // 增量结果并进去之后与全量同形 —— 这里就断言那个"同形"。
    expect([...inc.keys()].sort()).toEqual(['s1e7'])
    for (const [key, d] of inc) {
      expect(full.get(key), `全量里缺 ${key}`).toEqual(d)
    }
    // 反向确认：全量确实为"没动过"的文件留了空格子（否则上面那条会因为 full 为空而假绿）
    expect(full.get('s1e8')?.steps).toEqual([])
    expect(full.get('s1e8')?.step).toBeNull()
    expect(inc.has('s1e8')).toBe(false)
  })

  it('桥接对"不指向文件"的事件返回 null（一格都不许碰）', () => {
    expect(detailViewFor(ev('read_doc', { name: 'x' }, {}), FILES, 'w')).toBeNull()
    expect(detailViewFor(DOWNLOAD_E7, [{ filename: 'other.mkv', season: 9, episode: 9 }], 'w')).toBeNull()
  })

  it('累积时 note 缺席**保留**上一条（装盘这类无摘要事件不该把人话抹掉）', () => {
    let d = accumulateDetail(undefined, { step: 'download_candidate', source: 'subhd', note: '下载失败：x', ms: 10 }, 'download_candidate')
    expect(d.note).toBe('下载失败：x')
    d = accumulateDetail(d, { step: 'install_subtitle', source: null, note: null, ms: 5 }, 'install_subtitle')
    expect(d.note).toBe('下载失败：x')
    expect(d.source).toBe('subhd')
    expect(d.ms).toBe(15)
    expect(d.steps).toEqual(['download_candidate', 'install_subtitle'])
  })
})
