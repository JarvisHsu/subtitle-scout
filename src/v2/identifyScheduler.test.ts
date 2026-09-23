import { describe, it, expect } from 'vitest'
import { openDb } from './db.js'
import { runIdentifyWorkDir, listIdentifyQueue, type IdentifySchedulerDeps } from './identifyScheduler.js'
import { IDENTIFY_GATE_VERSION } from './identify.js'
import type { IdentifyReport } from '../agent/identifyWorker.js'

function mkDeps(db: ReturnType<typeof openDb>, runIdentifyImpl: () => Promise<IdentifyReport>): IdentifySchedulerDeps {
  return {
    db,
    runIdentify: async () => runIdentifyImpl(),
    worker: {
      model: {} as any,
      tmdb: { search: async () => [], getDetails: async () => null } as any,
    },
  }
}

/** #21b：接上 runs 的 deps（生产在 cli/index.ts 里就是这么接的）。 */
function mkDepsWithRuns(db: ReturnType<typeof openDb>, runIdentifyImpl: () => Promise<IdentifyReport>): IdentifySchedulerDeps {
  return {
    ...mkDeps(db, runIdentifyImpl),
    runs: {
      insert: (p) => {
        db.prepare(
          `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).run(p.jobId, p.startedAt, p.finishedAt, p.decision, p.detail, p.journalPath)
      },
    },
  }
}

describe('#21b：识别失败的**完整**原因必须留痕（不能被 100 字截断）', () => {
  const LONG = 'reasoning agent DID call the finalize tool, but its arguments failed schema validation — '
    + 'execute() never ran, so no structured decision was captured. '
    + 'Schema issues (first 2 of 3): [tmdbId] Expected number, received string; [mediaType] Invalid enum value. '
    + 'Raw finalize args: {"tmdbId":"121860","mediaType":"tv-series","title":"狂赌之渊"}'

  it('🔴 完整原因（含 zod 字段路径）落进 runs.detail —— 这正是生产里查不到的那一段', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/G【給@清｜梳】2026'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/1080p.mkv`, workDir, '1080p.mkv', 100, 1000, workDir, 1000)

    const deps = mkDepsWithRuns(db, () => { throw new Error(LONG) })
    await runIdentifyWorkDir(deps, {
      workDir, dirName: 'G【給@清｜梳】2026', fileCount: 1, seasons: [], hasSeasonDirs: false,
    })

    const run = db.prepare('SELECT decision, detail FROM runs ORDER BY id DESC LIMIT 1').get() as
      { decision: string; detail: string } | undefined
    expect(run, '必须留下一条 runs 行').toBeDefined()
    expect(run!.decision).toBe('identify-error')
    // 关键断言：**字段路径**必须在（100 字截断下它永远看不到——生产就是栽在这里）
    expect(run!.detail).toContain('[tmdbId]')
    expect(run!.detail).toContain('[mediaType]')
    expect(run!.detail).toContain('Invalid enum value')
    // 而 files.last_error 仍是**短**摘要（它是判据列，不许被长文本污染）
    const row = db.prepare('SELECT last_error FROM files WHERE work_dir = ?').get(workDir) as { last_error: string }
    expect(row.last_error.length).toBeLessThanOrEqual(100)
    expect(row.last_error).not.toContain('[tmdbId]')
    db.close()
  })

  it('🔴 没接 runs 的构造点行为不变（可选 deps，不记也不抛）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)

    const deps = mkDeps(db, () => { throw new Error(LONG) })
    const report = await runIdentifyWorkDir(deps, {
      workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false,
    })
    expect(report.tmdbId).toBeNull()
    expect((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(0)
    db.close()
  })

  it('🔴 runs.insert 抛错不许反噬识别轨（留痕是增益）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)

    const deps: IdentifySchedulerDeps = {
      ...mkDeps(db, () => { throw new Error('LLM timeout') }),
      runs: { insert: () => { throw new Error('runs table is on fire') } },
    }
    const report = await runIdentifyWorkDir(deps, {
      workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false,
    })
    // 退避轨照旧推进（这才是识别轨的本职）
    const row = db.prepare('SELECT attempt FROM files WHERE work_dir = ?').get(workDir) as { attempt: number }
    expect(row.attempt).toBe(1)
    expect(report.tmdbId).toBeNull()
    db.close()
  })
})

describe('🔴 agent 诚实地「认不出」→ 理由必须留痕（不许被固定标签盖掉）', () => {
  it('tmdbId=null + reason → files 留固定判据标签、runs 留完整理由', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/quark/影视/AUDIO LIST ENG LATINO SPANISH FRENCH (CA)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/Moana.2026.2160p.mkv`, workDir, 'Moana.2026.2160p.mkv', 100, 1000, workDir, 1000)

    const why = 'Directory name is an audio-language listing descriptor, not a work title. '
      + 'The only file suggests TMDB 1108427 (Moana, 2026) but write_identified_media rejected it '
      + "with 'evidence-fail: title mismatch'."
    const deps = mkDepsWithRuns(db, async () => ({ tmdbId: null, title: null, reason: why }))
    const report = await runIdentifyWorkDir(deps, {
      workDir, dirName: 'AUDIO LIST ENG LATINO SPANISH FRENCH (CA)',
      fileCount: 1, seasons: [], hasSeasonDirs: false,
    })

    // files.last_error 仍是**固定判据标签**（队列与 dashboard 读它，不许塞长文本）
    const row = db.prepare('SELECT last_error, next_retry_at FROM files WHERE work_dir = ?').get(workDir) as
      { last_error: string; next_retry_at: number }
    expect(row.last_error).toBe('identify-failed')
    expect(row.next_retry_at).toBeGreaterThan(Date.now())

    // 而 agent 的理由进了 runs——这是"为什么认不出"唯一的持久解释面
    const run = db.prepare(`SELECT decision, detail FROM runs WHERE decision = 'identify-no-match' ORDER BY id DESC LIMIT 1`).get() as
      { decision: string; detail: string } | undefined
    expect(run, '理由必须留痕——否则 schema 放宽了也还是看不到').toBeDefined()
    expect(run!.detail).toContain('1108427')
    expect(run!.detail).toContain(workDir)
    expect(report.reason).toBe(why)
    db.close()
  })

  it('reason 为空 → 不写空的 runs 行（不制造噪音）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)
    const deps = mkDepsWithRuns(db, async () => ({ tmdbId: null, title: null, reason: '' }))
    await runIdentifyWorkDir(deps, { workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false })
    expect((db.prepare('SELECT COUNT(*) AS n FROM runs').get() as { n: number }).n).toBe(0)
    db.close()
  })
})


describe('runIdentifyWorkDir（识别轨 catch-all）', () => {
  it('🔴 识别抛错 → next_retry_at 推进（不 30s 死循环）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)

    const deps = mkDeps(db, () => { throw new Error('LLM timeout') })
    const report = await runIdentifyWorkDir(deps, {
      workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false,
    })
    const row = db.prepare('SELECT attempt, next_retry_at, last_error FROM files WHERE work_dir = ?').get(workDir) as any
    expect(row.attempt).toBe(1)
    expect(row.next_retry_at).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    expect(row.next_retry_at).toBeLessThan(Date.now() + 28 * 60 * 60 * 1000)
    expect(row.last_error).toContain('LLM timeout')
    expect(report.tmdbId).toBeNull()
    db.close()
  })

  it('🔴 连续抛错 → 退避递增（attempt 阶梯）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Show'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/E01.mkv`, workDir, 'E01.mkv', 100, 1000, workDir, 1000)
    const deps = mkDeps(db, () => { throw new Error('err') })
    await runIdentifyWorkDir(deps, { workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false })
    await runIdentifyWorkDir(deps, { workDir, dirName: 'Show', fileCount: 1, seasons: [], hasSeasonDirs: false })
    const row = db.prepare('SELECT attempt, next_retry_at FROM files WHERE work_dir = ?').get(workDir) as any
    expect(row.attempt).toBe(2)
    // 巡检模型：全部 24h
    expect(row.next_retry_at).toBeGreaterThan(Date.now() + 20 * 60 * 60 * 1000)
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C5：识别时把 imdb 落进 works.provider_ids。
//
// 为什么这一步不能"等翻译流自己去查"：翻译抓源腿是**机械路径**（fetchSourceSub 内部任何网络
// 错都吞成"试下一候选"，绝不抛），它没有任何位置能承载一次 TMDB 往返的失败与退避。而识别
// 本来就已经在打 TMDB（getDetails），顺手多一个 external_ids 请求是同一次会话里最便宜的采集点。
//
// 为什么 imdb 缺席**不许**让识别失败：getExternalIds 的语义是 404→{imdbId:null}（真无数据）、
// 其余失败→抛 TmdbRequestFailedError（瞬时）。身份认定只依赖 getDetails 本体——这是
// tmdbCatalog / cli/index.ts 里 getChineseTitles/getOriginLanguage 的既有口径（两者都用
// `.catch(() => …)` 兜住）。若让 external_ids 的一次 5xx 把整次识别打回退避轨，
// 代价是一整个作品目录明天才重试、外加一次白烧的 LLM session。
// ─────────────────────────────────────────────────────────────────────────────
describe('runIdentifyWorkDir · works.provider_ids 落库（C5）', () => {
  const DETAILS = {
    id: 1, title: 'The Rig', originalTitle: 'The Rig', year: 2023,
    overview: null, posterPath: null, genreIds: null,
    originLanguage: 'en', chineseTitles: ['钻井危机'],
  }

  /** 播种一个"agent 已确认身份"的场景：目录名与 TMDB 标题一致才能过 verifyEvidence。 */
  function seed(db: ReturnType<typeof openDb>) {
    const workDir = '/media/TV/The Rig (2023)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/S02E06.mkv`, workDir, 'S02E06.mkv', 100, 1000, workDir, 2, 6, 1000)
    return workDir
  }

  function depsWith(
    db: ReturnType<typeof openDb>,
    workDir: string,
    externalIds: (mt: 'tv' | 'movie', id: string) => Promise<{ imdbId: string | null }>,
  ): IdentifySchedulerDeps {
    return {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'The Rig', reason: 'confirmed' }),
      worker: {
        model: {} as any,
        tmdb: {
          search: async () => [],
          getDetails: async () => DETAILS,
          getExternalIds: externalIds,
        } as any,
      },
    }
  }

  const item = (workDir: string) => ({
    workDir, dirName: 'The Rig (2023)', fileCount: 1, seasons: [2], hasSeasonDirs: true,
  })

  it('🔴 用例 6：识别成功 → works.provider_ids 含 imdb（JSON，照旧表既有口径）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    const calls: Array<[string, string]> = []
    const deps = depsWith(db, workDir, async (mt, id) => {
      calls.push([mt, id]); return { imdbId: 'tt14827638' }
    })
    await runIdentifyWorkDir(deps, item(workDir))

    // 前置：识别真的成功了（否则下面断言 provider_ids 为 NULL 也"通过"，是假绿）
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')

    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).not.toBeNull()
    // 形状锁死成 record（不是裸 'tt...' 串）：fetchSourceSub 的 imdbFromProviderIds 与
    // v2/findSubtitleWorkerTask 的 parseProviderIds 都按 `{imdb: string}` 解析，
    // 存成裸串两处都会静默返回 undefined —— 列有值、功能照旧退化，最难查的那种。
    expect(JSON.parse(row.provider_ids!)).toEqual({ tmdb: '1', imdb: 'tt14827638' })
    // 用的是 getDetails 那一次已经定下的 mediaType 与 id，不是二次推断
    expect(calls).toEqual([['tv', '1']])
    db.close()
  })

  it('🔴 getExternalIds 抛错 → 识别照常成功，provider_ids 落 NULL（增益不许反噬主线）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    const deps = depsWith(db, workDir, async () => { throw new Error('TMDB 503') })
    await runIdentifyWorkDir(deps, item(workDir))

    const bound = db.prepare('SELECT work_id, last_error FROM files WHERE work_dir = ?')
      .get(workDir) as { work_id: string | null; last_error: string | null }
    expect(bound.work_id).toBe('tmdb:1')       // 身份认定不依赖 external_ids
    expect(bound.last_error).toBeNull()        // 没被打进退避轨
    // 留 NULL 而不是 '{}' —— NULL 是回填 pass 的唯一取件凭据（C21）。写成 '{}' 就等于
    // 声称"查过了、TMDB 真没有"，这一行从此永远补不上 imdb（同 D18/D22 那个坑的第 N 次）。
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).toBeNull()
    db.close()
  })

  it('🔴 TMDB 真无 imdb（imdbId=null）→ provider_ids 仍落库（有 tmdb 键，非 NULL）', async () => {
    // 与上一条的分野：这里是**查过、确认没有**，不该让回填 pass 每天回来重查一遍
    // （identifyScheduler 的队列谓词永不再选它，但回填 pass 的谓词会——见 C21）。
    // 收敛靠"非 NULL"，故这一支必须写。
    const db = openDb(':memory:')
    const workDir = seed(db)
    const deps = depsWith(db, workDir, async () => ({ imdbId: null }))
    await runIdentifyWorkDir(deps, item(workDir))
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(JSON.parse(row.provider_ids!)).toEqual({ tmdb: '1' })
    db.close()
  })

  it('🔴 getExternalIds 未注入（旧构造点）→ 识别照常，不抛（optional 接线纪律）', async () => {
    // IdentifyWorkerDeps.tmdb 有几十个既有构造点（cli/index.ts、dispatcher.test、daemonV2.test…）。
    // 把 getExternalIds 做成必填会让它们全部编译不过；做成可选则"生产漏接线"是**静默**的
    // ——这条与 watchWiring.test.ts 逐个器官钉住接线是同一套分工：类型层留宽，接线层单钉。
    const db = openDb(':memory:')
    const workDir = seed(db)
    const deps: IdentifySchedulerDeps = {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'The Rig', reason: 'confirmed' }),
      worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => DETAILS } as any },
    }
    await runIdentifyWorkDir(deps, item(workDir))
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).toBeNull()
    db.close()
  })

  it('🔴 重识别同一作品 → 已有的 provider_ids 不被 INSERT OR REPLACE 洗成 NULL', async () => {
    // identifyScheduler 用的是 `INSERT OR REPLACE INTO works`，语义是**整行替换**。
    // 若某次重识别（用户重命名目录/手动重跑）拿不到 external_ids，REPLACE 会把上一次
    // 成功采到的 imdb 抹掉 —— 而回填 pass 的谓词是 `provider_ids IS NULL`，
    // 它会把这一行捡回来重查，不至于永久丢。但白烧一次 TMDB 且抓源腿在两轮之间退化。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(deps1(), item(workDir))
    function deps1() { return depsWith(db, workDir, async () => ({ imdbId: 'tt14827638' })) }
    // 第二次：external_ids 挂了
    await runIdentifyWorkDir(depsWith(db, workDir, async () => { throw new Error('503') }), item(workDir))
    const row = db.prepare('SELECT provider_ids FROM works WHERE id = ?').get('tmdb:1') as { provider_ids: string | null }
    expect(row.provider_ids).not.toBeNull()
    expect(JSON.parse(row.provider_ids!).imdb).toBe('tt14827638')
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 双语 overview（2026-09-01）：识别时把 /translations 白拿的 zh 简介落进 works.overview_zh。
// 写入点①/回填 pass 的分工、`in` 区分接线缺席、checked_at 单调——全部照 backdrop 口径，
// 论证见上组不重抄。三形态与 backdrop 组一一镜像。
describe('runIdentifyWorkDir · works.overview_zh 落库（双语简介写入点①）', () => {
  const BASE = {
    id: 1, title: 'The Rig', originalTitle: 'The Rig', year: 2023,
    overview: 'An oil rig crew...', posterPath: null, genreIds: null,
    originLanguage: 'en', chineseTitles: ['钻井危机'],
  }
  function seed(db: ReturnType<typeof openDb>) {
    const workDir = '/media/TV/The Rig (2023)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/S02E06.mkv`, workDir, 'S02E06.mkv', 100, 1000, workDir, 2, 6, 1000)
    return workDir
  }
  const item = (workDir: string) => ({
    workDir, dirName: 'The Rig (2023)', fileCount: 1, seasons: [2], hasSeasonDirs: true,
  })
  function depsWith(db: ReturnType<typeof openDb>, details: unknown): IdentifySchedulerDeps {
    return {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'The Rig', reason: 'confirmed' }),
      worker: {
        model: null as never,
        tmdb: {
          search: async () => [],
          getDetails: async () => details as never,
        },
      },
      log: () => {},
    } as unknown as IdentifySchedulerDeps
  }

  it('🔴 overviewZh 有值 → 落 overview_zh + checked_at', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, overviewZh: '钻井平台上的危机……' }), item(workDir))
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    const row = db.prepare('SELECT overview_zh, overview_zh_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { overview_zh: string | null; overview_zh_checked_at: number | null }
    expect(row.overview_zh).toBe('钻井平台上的危机……')
    expect(row.overview_zh_checked_at).not.toBeNull()
    db.close()
  })

  it('🔴 TMDB 真没有 zh 简介（overviewZh=null）→ 值落 NULL 但盖 checked 章（收敛凭据）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, overviewZh: null }), item(workDir))
    const row = db.prepare('SELECT overview_zh, overview_zh_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { overview_zh: string | null; overview_zh_checked_at: number | null }
    expect(row.overview_zh).toBeNull()
    expect(row.overview_zh_checked_at).not.toBeNull()
    db.close()
  })

  it('🔴 getDetails 没给 overviewZh 字段（旧构造点）→ 两列都 NULL 且不抛（optional 接线纪律）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, BASE), item(workDir))   // BASE 里没有 overviewZh
    const bound = db.prepare('SELECT work_id, last_error FROM files WHERE work_dir = ?')
      .get(workDir) as { work_id: string | null; last_error: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    expect(bound.last_error).toBeNull()
    const row = db.prepare('SELECT overview_zh, overview_zh_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { overview_zh: string | null; overview_zh_checked_at: number | null }
    expect(row.overview_zh).toBeNull()
    expect(row.overview_zh_checked_at).toBeNull()
    db.close()
  })
})

// v42 / R-F13：识别时把横版背景图落进 works.backdrop_path。
//
// 这是 backdrop_path 的**写入点①**。为什么只有回填 pass 不够（本仓病 A 的典型形态
// ——"只修一半"）：identifyScheduler 的队列谓词是 `files.work_id IS NULL`，识别成功后
// 那个目录永不再进识别队列；反过来只有回填 pass 而没有这一点，新识别的作品要等到
// **下一次 boot** 才拿到图（boot 可能几周一次），在那之前活动页对它退化成模糊海报。
// 两个写入点合起来才收敛，同 provider_ids（C5 写入点 + C21 回填 pass）的既有分工。
// ─────────────────────────────────────────────────────────────────────────────
describe('runIdentifyWorkDir · works.backdrop_path 落库（v42 / R-F13 写入点①）', () => {
  const BASE = {
    id: 1, title: 'The Rig', originalTitle: 'The Rig', year: 2023,
    overview: null, posterPath: null, genreIds: null,
    originLanguage: 'en', chineseTitles: ['钻井危机'],
  }

  function seed(db: ReturnType<typeof openDb>) {
    const workDir = '/media/TV/The Rig (2023)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, season, episode, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/S02E06.mkv`, workDir, 'S02E06.mkv', 100, 1000, workDir, 2, 6, 1000)
    return workDir
  }

  const item = (workDir: string) => ({
    workDir, dirName: 'The Rig (2023)', fileCount: 1, seasons: [2], hasSeasonDirs: true,
  })

  function depsWith(db: ReturnType<typeof openDb>, details: unknown): IdentifySchedulerDeps {
    return {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'The Rig', reason: 'confirmed' }),
      worker: {
        model: {} as any,
        tmdb: { search: async () => [], getDetails: async () => details } as any,
      },
    }
  }

  it('🔴 识别成功 → works.backdrop_path 落 TMDB 的 backdropPath（此前这一列被丢弃）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: '/bd.jpg' }), item(workDir))

    // 前置：识别真的成功了（否则下面断言列值也可能"通过"，是假绿）
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')

    const row = db.prepare('SELECT backdrop_path FROM works WHERE id = ?').get('tmdb:1') as { backdrop_path: string | null }
    expect(row.backdrop_path).toBe('/bd.jpg')
    db.close()
  })

  it('🔴 TMDB 真没有横版图（backdropPath=null）→ 图落 NULL，但落 checked_at（v43 收敛凭据）', async () => {
    // ⚠️ v43 语义变更（写入点①这一半）：探针**打通了**、TMDB 给的答案就是"没有横版图"，
    // 这是一个确定答案，必须落下 backdrop_checked_at。不落的话回填 pass 的谓词
    // （`backdrop_checked_at IS NULL`）每轮 boot 都会把这个刚识别完的作品捡回来重查 →
    // v43 修的队头阻塞原样从回填侧搬到识别侧（TMDB 真无图的新作品永远收敛不了）。
    // 图这一列仍然落 NULL，**刻意不写空串哨兵**（db.ts v42 的否决，v43 未推翻）。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: null }), item(workDir))
    const bound = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as { work_id: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    const row = db.prepare('SELECT backdrop_path, backdrop_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { backdrop_path: string | null; backdrop_checked_at: number | null }
    expect(row.backdrop_path).toBeNull()
    expect(row.backdrop_checked_at).not.toBeNull()   // ← v43 的实质
    db.close()
  })

  it('🔴 拿到图时也落 checked_at（收敛凭据与图同一条 INSERT）', async () => {
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: '/bd.jpg' }), item(workDir))
    const row = db.prepare('SELECT backdrop_path, backdrop_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { backdrop_path: string | null; backdrop_checked_at: number | null }
    expect(row.backdrop_path).toBe('/bd.jpg')
    expect(row.backdrop_checked_at).not.toBeNull()
    db.close()
  })

  it('🔴 getDetails 没给 backdropPath 字段（旧构造点）→ 两列都落 NULL，不抛（optional 接线纪律）', async () => {
    // IdentifyWorkerDeps.tmdb.getDetails 的 backdropPath 是 optional（几十个既有构造点的
    // 编译成本，同 getExternalIds 的既有分工：类型层留宽、接线层单钉）。
    // 这一条钉的是**不许炸**：undefined 直接喂给 better-sqlite3 会抛
    // `TypeError: Invalid value`，把一次成功的识别整个打回退避轨。
    //
    // ⚠️ v43 追加的实质：**checked_at 也必须留 NULL**。"构造点没接这个字段"与
    // "TMDB 确认没有"完全不同——前者一次图都没查过。落错了就是把漏接线伪装成"查过了"，
    // 而 checked_at 是**单调**的，一次忘接线的启动会让这些作品永久拿不到横版图、
    // 且再没有任何一轮 boot 会回来补（同 backfillBackdropPaths 的"探针缺席不动列"论证）。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, BASE), item(workDir))   // BASE 里没有 backdropPath
    const bound = db.prepare('SELECT work_id, last_error FROM files WHERE work_dir = ?')
      .get(workDir) as { work_id: string | null; last_error: string | null }
    expect(bound.work_id).toBe('tmdb:1')
    expect(bound.last_error).toBeNull()          // 没被打进退避轨
    const row = db.prepare('SELECT backdrop_path, backdrop_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { backdrop_path: string | null; backdrop_checked_at: number | null }
    expect(row.backdrop_path).toBeNull()
    expect(row.backdrop_checked_at).toBeNull()   // ← v43：漏接线不许伪装成"查过了"
    db.close()
  })

  it('🔴 重识别同一作品 → 已有的 backdrop_path / checked_at 不被 INSERT OR REPLACE 洗掉', async () => {
    // `INSERT OR REPLACE INTO works` 是**整行替换**（provider_ids 那条已经吃过一次）。
    // 第二次识别拿不到横版图时若直接绑 null，会把回填 pass 上一轮采到的值抹掉。
    // v43 追加：checked_at 同样不许被洗——洗掉就等于把一个已收敛的行退回"没查过"，
    // 回填 pass 下轮又把它捡回来，收敛性被识别路径悄悄破坏。
    const db = openDb(':memory:')
    const workDir = seed(db)
    await runIdentifyWorkDir(depsWith(db, { ...BASE, backdropPath: '/bd.jpg' }), item(workDir))
    const first = db.prepare('SELECT backdrop_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { backdrop_checked_at: number | null }
    expect(first.backdrop_checked_at).not.toBeNull()
    // 第二次：构造点这次没接 backdropPath 字段（探针缺席，不是"TMDB 说没有"）
    await runIdentifyWorkDir(depsWith(db, BASE), item(workDir))
    const row = db.prepare('SELECT backdrop_path, backdrop_checked_at FROM works WHERE id = ?')
      .get('tmdb:1') as { backdrop_path: string | null; backdrop_checked_at: number | null }
    expect(row.backdrop_path).toBe('/bd.jpg')
    expect(row.backdrop_checked_at).toBe(first.backdrop_checked_at)   // 凭据也不许丢
    db.close()
  })
})

// D-4（2026-09-18）：媒体类型**双向**核验 + 404 终态**可失效**。
// 生产实案 `[爱情公寓][全1-5季+电影+番外篇][国语中字][4K高码][203G]`：扁平文件（`01.mp4`、
// 季集全 NULL）+ 无季子目录 → 机械推断成 movie → 拿 TV id 去查 movie 端点 → null → 落
// `tmdb-404` **终态**，被队列谓词永久排除，界面上一个字都不显示。
describe('D-4 · 媒体类型双向核验（推定类型只决定查询顺序）', () => {
  function seedFlatShow(db: ReturnType<typeof openDb>, workDir: string) {
    // 扁平目录：文件名是 01.mp4（无季集）、无季子目录 —— 正是会被推成 movie 的形状
    for (const n of ['01.mp4', '02.mp4']) {
      db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(`${workDir}/${n}`, workDir, n, 100, 1000, workDir, 1000)
    }
  }

  it('🔴 movie 查不到但 tv 查得到 → 用 tv 绑定成功，不落 404（生产实案形状）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/quark/影视/[爱情公寓] (2020)'   // 刻意不含季标记：类型推断会先猜 movie，从而压到「回退」路径
    seedFlatShow(db, workDir)
    const calls: string[] = []
    const deps: IdentifySchedulerDeps = {
      db,
      runIdentify: async () => ({ tmdbId: '95897', title: 'iPartment', reason: 'ok' }),
      worker: {
        model: {} as any,
        tmdb: {
          search: async () => [],
          // 关键：movie 端点查不到，tv 端点查得到 —— 旧实现只看 movie 就判 404 了
          getDetails: async (mediaType: string) => {
            calls.push(mediaType)
            if (mediaType !== 'tv') return null
            // 真实 getDetails 会带回中文译名——标题门靠它匹配目录名里的 [爱情公寓]
            return { id: 95897, title: 'iPartment', originalTitle: 'iPartment', year: 2020, genreIds: [], chineseTitles: ['爱情公寓'] } as any
          },
        } as any,
      },
    }
    const report = await runIdentifyWorkDir(deps, {
      workDir, dirName: '[爱情公寓] (2020)',
      fileCount: 2, seasons: [], hasSeasonDirs: false,
    })
    // 推定类型只决定**先查哪个**：无季标记 → 先 movie；movie 空 → 回退 tv 命中
    expect(calls).toEqual(['movie', 'tv'])
    const row = db.prepare('SELECT work_id, last_error FROM files WHERE work_dir = ? LIMIT 1').get(workDir) as any
    expect(row.last_error).toBeNull()
    expect(row.work_id).toBe('tmdb:95897')
    expect(report.tmdbId).toBe('95897')
  })

  it('🔴 两种类型都查不到 → 才落 tmdb-404（终态语义恢复），且同时盖当前版本戳', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/TV/Nowhere'
    seedFlatShow(db, workDir)
    const deps: IdentifySchedulerDeps = {
      db,
      runIdentify: async () => ({ tmdbId: '1', title: 'Nowhere', reason: 'ok' }),
      worker: { model: {} as any, tmdb: { search: async () => [], getDetails: async () => null } as any },
    }
    await runIdentifyWorkDir(deps, {
      workDir, dirName: 'Nowhere', fileCount: 2, seasons: [], hasSeasonDirs: false,
    })
    const row = db.prepare('SELECT last_error, identify_gate_version FROM files WHERE work_dir = ? LIMIT 1').get(workDir) as any
    expect(row.last_error).toBe('tmdb-404')
    // 落 404 时必须同时盖戳，否则队列谓词会把它无限重新入队（付费热循环）
    expect(row.identify_gate_version).toBe(IDENTIFY_GATE_VERSION)
  })

  it('🔴 目录名带季标记（全3季）→ 类型推断为剧集（旧判据恒判 movie）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/影视/某剧 全3季'
    seedFlatShow(db, workDir)
    const calls: string[] = []
    const deps: IdentifySchedulerDeps = {
      db,
      runIdentify: async () => ({ tmdbId: '2', title: 'Some Show', reason: 'ok' }),
      worker: {
        model: {} as any,
        tmdb: {
          search: async () => [],
          getDetails: async (mediaType: string) => {
            calls.push(mediaType)
            return { id: 2, title: 'Some Show', originalTitle: 'Some Show', year: 2020, genreIds: [] } as any
          },
        } as any,
      },
    }
    await runIdentifyWorkDir(deps, { workDir, dirName: '某剧 全3季', fileCount: 2, seasons: [], hasSeasonDirs: false })
    // hasSeasonDirs=false 且 seasons 为空，旧推断必先查 movie；带季标记后应先查 tv
    expect(calls[0]).toBe('tv')
  })
})

describe('D-4 · 404 终态可失效（identify_gate_version 版本戳）', () => {
  function seed404(db: ReturnType<typeof openDb>, workDir: string, gateVersion: number | null) {
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, last_error, identify_gate_version, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/01.mp4`, workDir, '01.mp4', 100, 1000, workDir, 'tmdb-404', gateVersion, 1000)
  }

  it('🔴 从未盖戳（NULL）的 404 行 → 重新入队（存量假 404 的解冻出口）', () => {
    const db = openDb(':memory:')
    seed404(db, '/media/A', null)
    expect(listIdentifyQueue(db, 9999).map(i => i.workDir)).toContain('/media/A')
  })

  it('🔴 盖了旧版本戳的 404 行 → 重新入队', () => {
    const db = openDb(':memory:')
    seed404(db, '/media/B', IDENTIFY_GATE_VERSION - 1)
    expect(listIdentifyQueue(db, 9999).map(i => i.workDir)).toContain('/media/B')
  })

  it('🔴 盖了当前版本戳的 404 行 → 不再入队（收敛，不每轮重试）', () => {
    const db = openDb(':memory:')
    seed404(db, '/media/C', IDENTIFY_GATE_VERSION)
    expect(listIdentifyQueue(db, 9999).map(i => i.workDir)).not.toContain('/media/C')
  })

  it('非 404 的错误照常入队（本变更不改变它们的语义）', () => {
    const db = openDb(':memory:')
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, last_error, identify_gate_version, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run('/media/D/01.mp4', '/media/D', '01.mp4', 100, 1000, '/media/D', 'evidence-fail: title mismatch', IDENTIFY_GATE_VERSION, 1000)
    expect(listIdentifyQueue(db, 9999).map(i => i.workDir)).toContain('/media/D')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 提案 §6（2026-09-18）：队列取件顺序改为按目录内**最新 mtime** 倒序。
//
// 这一组锁的是"排序键必须是外部事实、不能是轨道自己的记账"这条纪律。
// 它极容易被下一个人当成"随手优化"改回 `updated_at`（那个列看起来更"新"），
// 而那个改动会让一个永远认不出来的目录**每轮都把自己推到队首**——把新作品饿死。
// ─────────────────────────────────────────────────────────────────────────────
describe('listIdentifyQueue · 取件顺序按最新 mtime（提案 §6）', () => {
  /** 播一个 work_dir；`mtime` 是磁盘写入时间，`updatedAt` 模拟识别轨自己的回写。 */
  function seedDir(
    db: ReturnType<typeof openDb>,
    workDir: string,
    opts: { mtime: number; updatedAt: number; attempt?: number; lastError?: string | null; gate?: number | null },
  ) {
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, attempt, last_error, identify_gate_version, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/01.mp4`, workDir, '01.mp4', 100, opts.mtime, workDir,
        opts.attempt ?? 0, opts.lastError ?? null, opts.gate ?? null, opts.updatedAt)
  }

  it('新 mtime 的目录排前面（用户刚放进去的先处理）', () => {
    const db = openDb(':memory:')
    seedDir(db, '/media/老片', { mtime: 1_000, updatedAt: 1_000 })
    seedDir(db, '/media/新片', { mtime: 9_000_000, updatedAt: 9_000_000 })

    expect(listIdentifyQueue(db, 999_999_999).map((i) => i.workDir)).toEqual(['/media/新片', '/media/老片'])
    db.close()
  })

  it('🔴 updated_at 不是排序键：失败目录的回写不许把自己顶上队首', () => {
    const db = openDb(':memory:')
    // 老目录：mtime 很旧，但识别轨刚刚回写过（退避/盖戳），updated_at 是最新的。
    // 任何"按 updated_at 排"的写法都会把它排到第一 —— 这就是要拦的形态。
    seedDir(db, '/media/永远认不出的老片', { mtime: 1_000, updatedAt: 9_000_000, attempt: 9, lastError: 'evidence-fail: x' })
    // 新目录：mtime 最新，但识别轨从没碰过它（updated_at 很旧）。
    seedDir(db, '/media/刚加的新片', { mtime: 8_000_000, updatedAt: 5_000 })

    expect(listIdentifyQueue(db, 999_999_999).map((i) => i.workDir)).toEqual(['/media/刚加的新片', '/media/永远认不出的老片'])
    db.close()
  })

  it('🔴 attempt 不是排序键：失败得越多越不该靠前（原实现的 MIN(attempt) 会这样做）', () => {
    const db = openDb(':memory:')
    seedDir(db, '/media/老片attempt0', { mtime: 1_000, updatedAt: 1_000, attempt: 0 })
    seedDir(db, '/media/新片attempt9', { mtime: 8_000_000, updatedAt: 1_000, attempt: 9 })

    expect(listIdentifyQueue(db, 999_999_999)[0]!.workDir).toBe('/media/新片attempt9')
    db.close()
  })

  it('同 mtime → 按 work_dir 确定性排序（顺序不随查询计划抖动）', () => {
    const db = openDb(':memory:')
    seedDir(db, '/media/B', { mtime: 5_000, updatedAt: 1 })
    seedDir(db, '/media/A', { mtime: 5_000, updatedAt: 2 })
    seedDir(db, '/media/C', { mtime: 5_000, updatedAt: 3 })

    expect(listIdentifyQueue(db, 999_999_999).map((i) => i.workDir)).toEqual(['/media/A', '/media/B', '/media/C'])
    db.close()
  })

  it('§6.3：版本戳解冻的 404 老目录**不额外提权**——按自身 mtime 老实排队', () => {
    const db = openDb(':memory:')
    // 一条被 D-4 解冻的老 404（gate 为 NULL → 重新入队），mtime 很旧。
    seedDir(db, '/media/解冻的老404', { mtime: 1_000, updatedAt: 1_000, lastError: 'tmdb-404', gate: null })
    // 用户今天刚加的新片。
    seedDir(db, '/media/今天刚加', { mtime: 9_000_000, updatedAt: 9_000_000 })

    // 两条都在队列里（解冻生效），但**新片排前面**——解冻不等于插队。
    expect(listIdentifyQueue(db, 999_999_999).map((i) => i.workDir)).toEqual(['/media/今天刚加', '/media/解冻的老404'])
    db.close()
  })

  it('目录内取 MAX(mtime)：新加一集的旧目录，按那一集的新 mtime 参与排序', () => {
    const db = openDb(':memory:')
    seedDir(db, '/media/老剧', { mtime: 1_000, updatedAt: 1_000 })
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run('/media/老剧/S04E01.mkv', '/media/老剧', 'S04E01.mkv', 100, 9_500_000, '/media/老剧', 1_000)
    seedDir(db, '/media/另一部老片', { mtime: 5_000, updatedAt: 5_000 })

    // 老剧的最新 mtime(9_500_000) > 另一部老片(5_000) → 老剧在前。
    // 若写成 MIN(mtime) 或 MIN(id)，老剧会被另一部老片压住。
    expect(listIdentifyQueue(db, 999_999_999).map((i) => i.workDir)).toEqual(['/media/老剧', '/media/另一部老片'])
    db.close()
  })
})
