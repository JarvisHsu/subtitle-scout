// src/v2/identifyScheduler.ts：识别调度器（新架构阶段 2/3 交界面）。
// 职责：纯 SQL 挑出待识别 work_dir → 组装 WorkDirFacts → 调 runIdentify → 写库。
//
// 写库门（防幻觉）：agent 报的 tmdbId 必须通过 verifyEvidence 机械核验才落库。
// 404 终态：getDetails 返回 null → last_error='tmdb-404'，永不重试（spec-gap B2）。
import type { ScoutDb } from './db.js'
import { verifyEvidence, titleFromDir, hasSeasonToken, IDENTIFY_GATE_VERSION, type TmdbEvidence } from './identify.js'
import { parseFilename } from '../recognition/parseFilename.js'
import type { IdentifyWorkerDeps, IdentifyReport, WorkDirFacts } from '../agent/identifyWorker.js'
// #21b：完整留痕进 runs 时复用**同一个** capDetail（不手抄一份截断口径，同 C30 的既有教训）。
import { capDetail } from './findSubtitleWorkerTask.js'

/** D-3：从本簇文件里取**高置信**解析出的标题，作为一级标题证据交给 verifyEvidence。
 *
 *  「高置信」= `parse_confidence === 'high'`（有明确季集结构），此时 `parseFilename` 的
 *  `title` 取自规则库的 seriesname，**不含**分辨率/编码/发布组——生产实例：
 *  `The.Expanse.S01E01.2015.2160p.AMZN.WEB-DL.DDP5.1.H265.HDR.DV.2Audio-年糕.mkv`
 *  → title = `The Expanse`。
 *
 *  🔴 刻意**不要**低置信行：无季集结构时 `parseFilename` 会把整个文件名清洗后当标题，里面
 *  混着 `2160p`/`x265`/`DreamHD` 这类片段，拿它当标题证据等于给幻觉开门（同 verifyEvidence
 *  头注释"机械层只拦完全无关的标题"的边界）。收紧到高置信，"文件名证据"才是比目录名更精确。
 *
 *  去重：同一作品的每个文件都会解析出同一个 seriesname，几十个文件没必要重复进候选表。
 *  纯函数、无 IO——`parseFilename` 是纯字符串解析，可以在核验路径上直接调。 */
function highConfidenceFileTitles(
  files: Array<{ filename: string; confidence: string }>,
): string[] {
  const out = new Set<string>()
  for (const f of files) {
    if (f.confidence !== 'high') continue
    const t = parseFilename(f.filename).title
    if (t != null && t !== '') out.add(t)
  }
  return [...out]
}

export interface IdentifySchedulerDeps {
  db: ScoutDb
  worker: IdentifyWorkerDeps
  /** runIdentify 函数本身（从 agent/identifyWorker.js 传入——deps 不含它，避免循环） */
  runIdentify: (deps: IdentifyWorkerDeps, facts: WorkDirFacts, runKey: string) => Promise<IdentifyReport>
  now?: () => number
  runKey?: (workDir: string) => string
  /**
   * #21b（2026-09-23）：识别失败的**完整**留痕去处。
   *
   * ── 为什么必须加这个（一次真实的排障失败）──────────────────────────────────
   * 生产里 4 个目录长期挂在"认不出来"，而它们的 `files.last_error` 全是
   * `reasoning agent DID call the finalize tool, but its arguments failed schema validation — execute() n`
   * —— **正好断在"哪个字段错了"之前**。查下去发现：完整原因（`reasoningAgent` 那边其实已经
   * 拼好了 zod issues（字段路径 + 消息，前 5 条））在**任何**持久位置都不存在：
   *   · `files.last_error` 是 `e.message.slice(0, 100)` 截断的；
   *   · `console.error` 只在 docker 日志里，7 天后已经被轮掉（实测 `--since 168h` 命中 0 条）。
   * ⇒ 排障成了考古。而本仓**早就有**完整留痕的正规去处：`runs` 表（每条别的执行器
   *   — subtitleScheduler / findSubtitleWorkerTask / realignWorkerTask — 都在往里写 detail），
   *   identifyScheduler 是**唯一一个从没接过它**的路径。
   *
   * 可选：测试与未接线的构造点行为不变（不传就不记）。生产在 cli/index.ts 里接上。
   */
  runs?: {
    insert: (p: {
      jobId: number | null; startedAt: number; finishedAt: number; decision: string
      detail: string; journalPath: string | null; llmCalls?: number; assrtCalls?: number
      traceJson?: string | null
    }) => void
  }
}

export interface IdentifyQueueItem {
  workDir: string
  dirName: string
  fileCount: number
  seasons: number[]
  hasSeasonDirs: boolean
}

/** 识别队列：work_id IS NULL 且（退避窗已过）且（非 404 终态）。
 *  一次一个 work_dir（串行，TMDB 配额敏感）。 */
export function listIdentifyQueue(db: ScoutDb, now: number): IdentifyQueueItem[] {
  const rows = db.prepare(`
    SELECT work_dir,
           COUNT(*) AS file_count,
           SUM(CASE WHEN season IS NOT NULL THEN 1 ELSE 0 END) AS with_season
    FROM files
    WHERE work_id IS NULL
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
      -- D-4（2026-09-18）：404 终态**可失效**。原谓词是纯 last_error != 'tmdb-404'，
      -- 于是写入 404 的行从此再也不进队列——本次修好了产生假 404 的机制（推定类型单向、
      -- 查不到就判 404），但库里已存在的假 404 行一行都不会重跑，等于改了门而生产库原封不动。
      -- 现在多一条出口：**该行的 gate 版本落后于当前门**（或从未盖过戳）时重新入队一次。
      -- 🔴 identify_gate_version IS NULL 必须显式写：它归一成「未盖戳=最旧」，
      --    不能只靠 identify_gate_version < ?——NULL 参与比较在三值逻辑里是 unknown，
      --    永远选不中存量行（v45 头注释记的同一个坑）。
      AND (
        last_error IS NULL
        OR last_error != 'tmdb-404'
        OR identify_gate_version IS NULL
        OR identify_gate_version < ?
      )
    GROUP BY work_dir
    -- 取件顺序（提案第 6 组，2026-09-18）：按**目录内最新 mtime** 倒序，
    -- 替换原来的 ORDER BY MIN(attempt), MIN(id)。
    -- 理由是"用户刚放进去的东西先被处理"——这是界面上唯一能让用户感知到
    -- "我看得见它在动"的排序性质。
    --
    -- 为什么**不按 updated_at**（本仓最容易顺手写错的一条）：updated_at 是**识别轨
    -- 自己会回写的列**——每次失败退避、每次盖版本戳都会刷新它。拿它排序等于
    -- "越失败越靠前"：一个永远认不出来的目录每轮都把自己推到队首，
    -- 把真正新加的作品饿在后面。**排序键必须是外部事实，不能是轨道自己的记账**。
    -- mtime 满足这条：它是文件在磁盘上的写入时间，识别轨从不碰它。
    --
    -- 为什么**不按 id**（D-4 之前的 MIN(id)）：id 是"这个文件第一次被扫描到"的
    -- 插入序号——一个三年前的老目录里**今天新加的一集**，id 依然是老的（行已存在，
    -- scan 只更新 mtime），于是它会被埋在几百行之后。而 mtime 会跟着更新，
    -- 这正是"同一目录里新加的文件也该优先"所要求的。MIN(id) 还顺带让
    -- "重新扫描导致的 id 变化"影响队首，行为不可预期。
    --
    -- 末位 work_dir 只是**确定性 tiebreaker**（同 mtime 时顺序不随 SQLite 的任意选择变），
    -- 不表达任何优先级——否则同 mtime 的目录顺序会随查询计划抖动，测试也跟着飘。
    ORDER BY MAX(mtime) DESC, work_dir ASC
  `).all(now, IDENTIFY_GATE_VERSION) as Array<{ work_dir: string; file_count: number; with_season: number }>

  return rows.map(r => {
    const dirName = r.work_dir.slice(r.work_dir.lastIndexOf('/') + 1)
    return {
      workDir: r.work_dir,
      dirName,
      fileCount: r.file_count,
      seasons: [],
      hasSeasonDirs: r.with_season > 0,
    }
  })
}

export function buildFacts(db: ScoutDb, item: IdentifyQueueItem): WorkDirFacts {
  const files = db.prepare(`
    SELECT filename, season, episode, parse_confidence AS confidence
    FROM files WHERE work_dir = ?
  `).all(item.workDir) as Array<{ filename: string; season: number | null; episode: number | null; confidence: string | null }>
  const seasons = new Set<number>()
  for (const f of files) if (f.season != null) seasons.add(f.season)
  return {
    workDir: item.workDir,
    dirName: item.dirName,
    fileCount: files.length,
    seasons: [...seasons],
    hasSeasonDirs: item.hasSeasonDirs,
    files: files.map(f => ({
      filename: f.filename,
      season: f.season,
      episode: f.episode,
      confidence: f.confidence ?? 'none',
    })),
  }
}

/** 执行识别：跑 worker → 写库。返回报告。 */
export async function runIdentifyWorkDir(
  deps: IdentifySchedulerDeps,
  item: IdentifyQueueItem,
  /** D-5（2026-09-18）：这一行的 work_id 是**谁**定的——写进 `files.work_id_source`。
   *  `'auto'` = daemon 派发的识别 agent 判定（**默认**，既有的 74 个调用点一字不改）；
   *  `'human'` = 用户经 `POST /api/v2/identify/bind` 人工指定。
   *  唯一消费者是**撤销闸**：只许撤销 `'human'` 的行（论证见 identifyBindApi.ts）。
   *
   *  为什么走"同一个函数 + 一个 source 参数"而不是给绑定另写一套写库：
   *  提案明写「写库复用自动识别同一套核验与事务，**不开旁路**」。让绑定直接调用本函数、
   *  只把 worker 换成一个"立即返回用户选定 id"的 stub，复用的就是**整条**路径——
   *  buildFacts、双向类型核验、verifyEvidence 的全部证据腿、works 行写入、files 更新、
   *  版本戳——一行都不重复，也就不可能漂移。 */
  source: 'auto' | 'human' = 'auto',
): Promise<IdentifyReport> {
  const now = deps.now?.() ?? Date.now()
  const runKey = deps.runKey?.(item.workDir) ?? `identify:${item.workDir}`
  const facts = buildFacts(deps.db, item)

  // writeIdentified 执行体：verifyEvidence 机械核验 + 事务写库。
  // 🔴 2026-08-08 实测修正：agent 经常搜了 TMDB 但不调 write 工具（9 步只 search+details）。
  // 绑定不应依赖 agent 自觉——改为 scheduler 自动执行：report 确认身份后，用文件列表 + TMDB
  // 详情自动绑定（season/episode 取 confidence 值 + 单季推导）。agent 只负责"确认身份"。
  const writeIdentified = async (input: { tmdbId: string; isTv: boolean; title: string; files: Array<{ filename: string; season: number | null; episode: number | null }> }) => {
    // 先查 TMDB 详情做核验——**双向**（D-4，2026-09-18）。
    //
    // 🔴 曾经是单向：`getDetails(input.isTv ? 'tv' : 'movie', id)` 返回 null 就直接判
    // `tmdb-404`，把"我们猜错了类型"写成了"TMDB 上确实没有这部作品"。而 `isTv` 是
    // `hasSeasonDirs || seasons.length > 0` 机械推断出来的——扁平文件目录（文件名是
    // `01.mp4`、季集全 NULL）且**没有**季子目录时恒判 movie，于是拿一个 TV id 去查 movie 端点
    // → null → 落 404 **终态**，被队列谓词 `last_error != 'tmdb-404'` **永久排除**，
    // 界面上一个字都不显示。生产实案：`[爱情公寓][全1-5季+电影+番外篇…]` 15 个文件。
    //
    // 现在：推定类型只决定**先查哪个**，两个都 null 才判 404。这让 `tmdb-404` 恢复其应有语义
    // （"TMDB 上两种类型都查过、确实没有"），而不是"我们猜错了类型"。
    // 代价：只在**首次查询为 null** 时多一次 API 调用，命中正常路径时零增量。
    const firstType: 'tv' | 'movie' = input.isTv ? 'tv' : 'movie'
    const otherType: 'tv' | 'movie' = input.isTv ? 'movie' : 'tv'
    let mediaType = firstType
    let details = await deps.worker.tmdb.getDetails(firstType, input.tmdbId)
    if (!details) {
      details = await deps.worker.tmdb.getDetails(otherType, input.tmdbId)
      if (details) {
        mediaType = otherType
        console.error(
          `[identify-scheduler] ${facts.workDir}: 推定类型 ${firstType} 查不到，改用 ${otherType} 命中——` +
            `机械推断只决定查询顺序，不再决定结论（D-4）`,
        )
      }
    }
    if (!details) {
      // 两种类型都查过 → 这才是真·404
      return { ok: false as const, error: 'tmdb-404' }
    }
    // 提案 3.4：剧集取一次季表，算**单季最大集数**（判据与理由见 identify.ts 的第 ⑤ 条腿
    // 与 ops 的 task-3.4-decision.md）。取不到 → **不填**，那条腿不参与、行为与改动前逐字一致。
    // 整支 try 住：季表是**增益**，它挂了不该把一次成功的识别打回退避轨。
    let episodeCount: number | undefined
    if (mediaType === 'tv' && deps.worker.tmdb.getSeasonTable) {
      try {
        const table = await deps.worker.tmdb.getSeasonTable(input.tmdbId)
        // **排除 season 0**：TMDB 用它装"特别篇"，那不是一季的集数。拿它算 max 会让
        // 一个"特别篇有 30 集"的作品凭特典集数放行一个 30 文件的目录。
        const seasonsOnly = table ? table.filter((s) => s.seasonNumber > 0) : []
        if (seasonsOnly.length > 0) {
          const max = Math.max(...seasonsOnly.map((s) => s.episodeCount))
          // 只接受有限正整数：季表里出现 NaN/0/负数时**不填**而不是填它——
          // 填 0 会让"集数>0"的前置恒假（腿永久失效），填负数会让下界恒真（凭空放行）。
          if (Number.isFinite(max) && max > 0) episodeCount = max
        }
      } catch { /* 季表缺席/失败 = 这条腿不参与，绝不是"集数为 0" */ }
    }
    const evidence: TmdbEvidence = {
      id: input.tmdbId,
      title: details.title,
      originalTitle: details.originalTitle ?? null,
      year: details.year,
      mediaType,
      episodeCount,
    }
    const check = verifyEvidence(evidence, {
      dirName: facts.dirName,
      fileCount: facts.fileCount,
      seasons: facts.seasons,
      hasSeasonDirs: facts.hasSeasonDirs,
      // D-3（2026-09-18）：把**高置信文件名**升为一级标题证据（第三个根因的修复）。
      // 目录名会被发布组/网盘污染，而文件名常常是干净的；原实现只吃 titleFromDir(work_dir)，
      // 把这条最精确的证据整条浪费。生产实案（苍穹浩瀚 / tmdb:63174）：
      //   目录名  = 「苍穹浩瀚 全6季 4K.HDR&杜比视界 国英双音轨 内封精修简英双语特效字幕 顶级收藏版片源」
      //   文件名  = 「The.Expanse.S01E01.2015.2160p.AMZN.WEB-DL.DDP5.1.H265.HDR.DV.2Audio-年糕.mkv」
      // 目录名里**没有** "theexpanse"（D-2 的 CJK 门也救不了它），只有文件名能证明身份。
      fileTitles: highConfidenceFileTitles(facts.files),
      // D-4：目录名里的季/集标记（`全1-5季` 等）= "这是剧集"的独立结构证据。
      dirHasSeasonToken: hasSeasonToken(facts.dirName),
      // 🔴 2026-08-08 实测：必须用 titleFromDir 清洗后的标题（去掉年份/花括号），
      // 不能传原始 dirName——带年份的目录名会让 normalize 后的字符串多出年份数字导致
      // 永不匹配（Chainsaw Man Reze Arc 的 ': ' vs '- ' 差异 + 年份 2025 实测踩中）。
    }, titleFromDir(facts.dirName), details.chineseTitles)
    if (!check.ok) {
      return { ok: false as const, error: `evidence-fail: ${check.reason}` }
    }

    // C5：顺手采 imdb 落进 works.provider_ids。位置在 verifyEvidence **之后**——
    // 身份还没核验过就去打 external_ids 是白烧配额（evidence-fail 的目录不会写 works 行）。
    //
    // 三层结果各有不同语义，不许折叠（这三态直接决定回填 pass 会不会回来重查这一行）：
    //   · 拿到 imdb        → {tmdb, imdb}，抓源腿从此走 imdb 精确定位
    //   · TMDB 确认没有    → {tmdb}，**非 NULL**：这是"查过、确实没有"的凭据，
    //                        否则回填 pass 的 `provider_ids IS NULL` 谓词每天把它捡回来重查，
    //                        永不收敛（同 3-1 那个 pass 上 `[]` 与 NULL 必须分开的坑）
    //   · 调用失败/未接线  → null，留给回填 pass 下次重试
    // 写成 '{}' 或无条件 `{tmdb}` 都会让第三种伪装成第二种 → 一次 TMDB 抖动就永久放弃这一行。
    let providerIds: string | null = null
    if (deps.worker.tmdb.getExternalIds) {
      try {
        const ext = await deps.worker.tmdb.getExternalIds(mediaType, input.tmdbId)
        const ids: Record<string, string> = { tmdb: input.tmdbId }
        if (ext.imdbId) ids.imdb = ext.imdbId
        providerIds = JSON.stringify(ids)
      } catch {
        providerIds = null   // 增益缺席不是 blocker；回填 pass 会回来补
      }
    }

    // 写库：works 行 + files.work_id 批量更新（同一事务）
    const tx = deps.db.transaction(() => {
      // `INSERT OR REPLACE` 是**整行替换**：本次采不到时若直接绑定 null，会把上一次成功采到的
      // imdb 抹掉（用户重命名目录/手动重跑识别的路径上真实可达）。故先读一次现值兜底——
      // 丢了不至于永久缺失（回填 pass 的 `IS NULL` 谓词会把它捡回来），但那是白烧一次 TMDB，
      // 且抓源腿在两轮之间退化回文本 query。读在事务内，与写同一把锁。
      const kept = providerIds ?? ((deps.db.prepare('SELECT provider_ids FROM works WHERE id = ?')
        .get(`tmdb:${input.tmdbId}`) as { provider_ids: string | null } | undefined)?.provider_ids ?? null)
      // 同一个 `INSERT OR REPLACE` 整行替换的坑，对 backdrop_path 同样成立（v42）：本次
      // getDetails 没给横版图时（TMDB 真没有 / 该构造点没接这个可选字段）若直接绑 null，
      // 会把回填 pass 上一轮辛苦采到的值抹掉。与 provider_ids 不同的是，这里丢了**不保证**
      // 能补回来——回填谓词是 `backdrop_path IS NULL`，确实会把它捡回去重查，但若 TMDB 对
      // 这个作品本来就没有横版图，那就是每轮 boot 白烧一次往返（见 db.ts v42 的已知代价）。
      // 读在事务内，与写同一把锁。
      const backdropNow = details.backdropPath ?? null
      const keptBackdrop = backdropNow ?? ((deps.db.prepare('SELECT backdrop_path FROM works WHERE id = ?')
        .get(`tmdb:${input.tmdbId}`) as { backdrop_path: string | null } | undefined)?.backdrop_path ?? null)
      // v43：backdrop_path 的**收敛凭据**，与上面那个值一一配对（这是写入点①这一半）。
      // 这一次 getDetails 是真打出去、真拿回确定答案了（有图或确认没图），故无论
      // backdropNow 是不是 null 都要落 checked_at——不落的话，回填 pass 的谓词
      // （`backdrop_checked_at IS NULL`）每轮 boot 都会把这个刚识别完的作品捡回来重查，
      // v43 修的那个队头阻塞就原样从回填侧搬到识别侧（TMDB 真无图的新作品永远收敛不了）。
      //
      // ⚠️ 但**探针没给这个可选字段**（deps 构造点没接 backdropPath）时不能落：那与
      // "TMDB 确认没有"不可区分，而它其实一次图都没查过。用 `in` 判断而不是 `!= null`，
      // 正是为了把"接了线但 TMDB 没图"（应收敛）与"压根没接线"（应留 NULL 重试）分开——
      // 同 backfillBackdropPaths 的"探针缺席不动列"论证，且 checked_at 是单调的，
      // 错写一次就是永久放弃。
      const backdropProbed = 'backdropPath' in details
      const keptBackdropChecked = backdropProbed
        ? now
        : ((deps.db.prepare('SELECT backdrop_checked_at FROM works WHERE id = ?')
            .get(`tmdb:${input.tmdbId}`) as { backdrop_checked_at: number | null } | undefined)?.backdrop_checked_at ?? null)
      // 双语 overview（2026-09-01）：overview_zh 三件套逐字照 backdrop 口径——整行替换先读现值
      // 兜底、`in` 区分"接了线但 TMDB 没有 zh 简介"（应盖章收敛）与"构造点没接这个可选字段"
      // （应留 NULL 等回填），checked_at 单调、错写一次即永久放弃，论证同上不重抄。
      const zhNow = details.overviewZh ?? null
      const keptZh = zhNow ?? ((deps.db.prepare('SELECT overview_zh FROM works WHERE id = ?')
        .get(`tmdb:${input.tmdbId}`) as { overview_zh: string | null } | undefined)?.overview_zh ?? null)
      const zhProbed = 'overviewZh' in details
      const keptZhChecked = zhProbed
        ? now
        : ((deps.db.prepare('SELECT overview_zh_checked_at FROM works WHERE id = ?')
            .get(`tmdb:${input.tmdbId}`) as { overview_zh_checked_at: number | null } | undefined)?.overview_zh_checked_at ?? null)
      deps.db.prepare(`
        INSERT OR REPLACE INTO works (id, title, original_title, year, media_type, origin_lang, overview, overview_zh, overview_zh_checked_at, poster_path, backdrop_path, backdrop_checked_at, chinese_titles, provider_ids, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        `tmdb:${input.tmdbId}`,
        details.title,
        details.originalTitle,
        details.year,
        mediaType,
        details.originLanguage,
        details.overview,
        keptZh,
        keptZhChecked,
        details.posterPath,
        // R-F13/R-F14（v42）：横版背景图。TMDB 客户端早就在取这个字段（tmdb.ts:325），
        // 此前落库时被丢弃 → 新架构识别出的作品在活动页只能退化成「模糊海报当背景」。
        //
        // 这是 backdrop_path 的**写入点①（新识别）**，与 daemonV2.backfillBackdropPaths
        // （写入点②，存量回填）缺一不可：identifyScheduler 的队列谓词是
        // `files.work_id IS NULL`，识别成功后那个目录**永不再进识别队列** → 只补这一点，
        // 库里的存量作品永远没图；只补回填 pass，新识别的作品要等下一次 boot 才有图。
        // 同 provider_ids（C5 写入点 + C21 回填）的既有分工。
        //
        // `?? null` 而不是省略：getDetails 的 backdropPath 是 optional（几十个既有构造点的
        // 编译成本，见 IdentifyWorkerDeps 的论证），undefined 传给 better-sqlite3 会抛
        // `TypeError: Invalid value`（它只认 null/number/string/bigint/Buffer），
        // 那会把一次成功的识别整个打回退避轨。
        keptBackdrop,
        keptBackdropChecked,
        JSON.stringify(details.chineseTitles ?? []),
        kept,
        now, now,
      )
      // 按文件名匹配绑定（同一 work_dir 下的文件）
      const byFilename = new Map(facts.files.map(f => [f.filename, f]))
      const stmt = deps.db.prepare(`
        UPDATE files SET work_id = ?, season = ?, episode = ?, attempt = 0, next_retry_at = NULL, last_error = NULL, identify_gate_version = ?, work_id_source = ?, updated_at = ?
        WHERE work_dir = ? AND filename = ?
      `)
      let written = 0
      for (const f of input.files) {
        const target = byFilename.get(f.filename)
        if (!target) continue
        stmt.run(`tmdb:${input.tmdbId}`, f.season, f.episode, IDENTIFY_GATE_VERSION, source, now, facts.workDir, f.filename)
        written++
      }
      return written
    })
    const written = tx()
    return { ok: true as const, written }
  }

  let report: IdentifyReport
  try {
    report = await deps.runIdentify(
      { ...deps.worker, writeIdentified },
      facts,
      runKey,
    )
  } catch (e) {
    // 🔴 B2（对抗审计）：识别抛错（超时/步数耗尽/LLM 5xx）必须回写退避——
    // 否则 next_retry_at 不动 → 每 30s 重选 → 烧钱死循环。
    const attempt = (deps.db.prepare('SELECT MAX(attempt) a FROM files WHERE work_dir = ?').get(facts.workDir) as { a: number }).a
    // 短摘要进 files.last_error（它是**判据列**：队列谓词读 `last_error != 'tmdb-404'`，
    // 且 dashboard 的未识别面按它分档）——保持 100 字上限不变，不拿长文本污染判据列。
    const err = e instanceof Error ? e.message.slice(0, 100) : String(e)
    deps.db.prepare(`
      UPDATE files SET attempt = ?, next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE work_dir = ?
    `).run(attempt + 1, now + retryDelayMs(attempt), err, now, facts.workDir)
    // #21b：**完整**原因进 runs（唯一有界的持久通道）。上限给 2000 而不是 capDetail 的默认
    // 200：这条 detail 的用途就是"一眼定位哪个字段错了"，而 zod issues 列表本身就常超 200；
    // runs 行按周清理，这个长度不会长期堆积。
    const full = e instanceof Error ? e.message : String(e)
    try {
      deps.runs?.insert({
        jobId: null, startedAt: now, finishedAt: now,
        decision: 'identify-error', detail: capDetail(full, 2000),
        journalPath: null,
      })
    } catch (logErr) {
      // 留痕是增益，绝不许反噬识别轨（同本仓各运维器官的既有口径）。
      console.error(`[identify-scheduler] 写 runs 留痕失败（隔离）: ${String(logErr)}`)
    }
    console.error(`[identify-scheduler] ${facts.workDir} 抛错: ${err}（已推进退避轨）`)
    return { tmdbId: null, title: null, reason: `error: ${err}` }
  }

  // 🔴 自动绑定：report 确认身份后，scheduler 用文件列表 + TMDB 详情自动绑定所有文件。
  // （agent 的 write_identified_media 工具保留供它主动修正集号，但绑定不再依赖它被调用。）
  if (report.tmdbId !== null) {
    const writeResult = await writeIdentified({
      tmdbId: report.tmdbId,
      // D-4：类型推断加上"目录名里的季/集标记"这一条。原判据是
      // `hasSeasonDirs || seasons.length > 0`，对**扁平文件目录**（`01.mp4`、季集全 NULL）
      // 恒假 → 判 movie → 拿 TV id 去查 movie 端点 → null → 落 `tmdb-404` 终态。
      // 生产实案 `[爱情公寓][全1-5季+电影+番外篇…]`：目录名里的 `全1-5季` 已经说明是剧集。
      // 注意这只影响**先查哪个类型**（writeIdentified 已改双向核验），所以即使这里判错，
      // 也不会再造出假 404——两层是互补的。
      isTv: facts.hasSeasonDirs || facts.seasons.length > 0 || hasSeasonToken(facts.dirName),
      title: report.title ?? '',
      files: facts.files.map(f => ({ filename: f.filename, season: f.season, episode: f.episode })),
    })
    if (!writeResult.ok) {
      const attempt = (deps.db.prepare('SELECT MAX(attempt) a FROM files WHERE work_dir = ?').get(facts.workDir) as { a: number }).a
      // 🔴 D-4：这条失败路径**能写 `last_error='tmdb-404'`**，而队列谓词给了"gate 版本落后"
      // 的行一条重新入队的出口——所以这里**必须同时盖当前版本戳**，否则该行会在每轮巡检里
      // 被反复重新入队、反复白跑一次识别 agent（付费 LLM），变成一个热循环。
      // 盖戳后收敛：重跑仍判 404 → 版本已是当前 → 谓词恒假 → 不再重试。
      // （catch 路径与下面 'identify-failed' 路径不产生 404，本就不受该谓词限制，故不盖戳。）
      deps.db.prepare(`
        UPDATE files SET attempt = ?, next_retry_at = ?, last_error = ?, identify_gate_version = ?, updated_at = ?
        WHERE work_dir = ?
      `).run(attempt + 1, now + retryDelayMs(attempt + 1), writeResult.error, IDENTIFY_GATE_VERSION, now, facts.workDir)
      // D-5（2026-09-18）：把写库失败**结构化**地放进 report（不只是塞进 reason 文案里）。
      // 上面那个 `...report` 保留 tmdbId 是对的（认定结果没变），但调用方因此无法用
      // `tmdbId === null` 判断"有没有写进去"——加这个字段就是为了让那个判断存在。
      return { ...report, reason: `${report.reason} [bind failed: ${writeResult.error}]`, writeError: writeResult.error }
    }
    console.error(`[identify-scheduler] bound ${writeResult.written}/${facts.fileCount} files of ${facts.workDir} to tmdb:${report.tmdbId}`)
  }

  // 写库结果落回 files（成功/失败/404）
  if (report.tmdbId === null) {
    // 识别失败：退避（spec-gap B2）
    const attempt = (deps.db.prepare('SELECT MAX(attempt) a FROM files WHERE work_dir = ?').get(facts.workDir) as { a: number }).a
    deps.db.prepare(`
      UPDATE files SET attempt = ?, next_retry_at = ?, last_error = ?, updated_at = ?
      WHERE work_dir = ?
    `).run(attempt + 1, now + retryDelayMs(attempt + 1), 'identify-failed', now, facts.workDir)

    // 🔴 2026-09-23（与 schema 放宽配套，缺了这一步前一步就白修）：
    // agent **诚实地认不出**时给的那段 `reason` 是"为什么认不出"唯一的解释面——它此前
    // **被整个丢掉**：`files.last_error` 只写一个固定标签 `'identify-failed'`（那是队列与
    // dashboard 读的**判据标记**，不许塞长文本），而 `console.error` 7 天就被轮掉。
    // 于是 schema 放宽之前是一句话都看不到（结论被拒），放宽之后仍然是看不到（被覆盖）。
    // 落到 `runs`（#21b 刚接上的那条有界通道），与抛错路径同一个决策名族。
    const why = report.reason.trim()
    if (why !== '') {
      try {
        deps.runs?.insert({
          jobId: null, startedAt: now, finishedAt: now,
          decision: 'identify-no-match', detail: capDetail(`${facts.workDir}: ${why}`, 2000),
          journalPath: null,
        })
      } catch (logErr) {
        console.error(`[identify-scheduler] 写认不出留痕失败（隔离）: ${String(logErr)}`)
      }
      console.error(`[identify-scheduler] ${facts.workDir} 认不出（agent 已给理由）: ${capDetail(why, 300)}`)
    }
  }
  return report
}

/** 退避（巡检模型 spec 2026-08-08）：识别不出的统一"明天"（24h，对齐巡检周期）。
 *  不再有 1h/4h 短退避——那是旧 30s tick 思维的残留，与"每天巡检一次"矛盾。 */
function retryDelayMs(_attempt: number): number {
  return 24 * 60 * 60 * 1000
}
