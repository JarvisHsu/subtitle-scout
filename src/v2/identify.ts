// src/v2/identify.ts：识别 agent 的核心纯函数（新架构阶段 2）。
// Identify scheduler and worker boundary.
//
// 识别 agent 的职责（用户裁决）：
//  - 确认"这个 work_dir 是什么影视"（TMDB 身份）
//  - 批量绑定文件季集号（60 一包，身份只确认一次）
//  - 404 终态（作品真不在 TMDB → 永不重试）
//
// 本文件是**纯函数层**（标题清洗、候选生成、核验逻辑），不含 LLM 调用——
// LLM 调用在识别 worker 里（阶段 2b），这里的函数可单测。

import type { FindSubtitleBatchReport } from '../agent/findSubtitleWorker.schemas.js'

/** 从目录名提取标题候选。目录名可能带年份、{tmdb-N} 标签、乱码等。
 *  "Pulp Fiction (1994)" → "Pulp Fiction"
 *  "后室 (2026) {tmdb-1083381}" → "后室"
 *  "绝命毒师 (2008)" → "绝命毒师" */
export function titleFromDir(dirName: string): string {
  let t = dirName.trim()
  // 去掉 {tmdb-N} 标签
  t = t.replace(/\s*\{tmdb-\d+\}\s*$/i, '')
  // 去掉末尾年份 (2024) / [2024] / 2024。
  // 括号字符类含全角形态（中文文件管理器常产出）：（）= U+FF08/U+FF09 是 () 的全角，
  // 【】= U+3010/U+3011 是 [] 在中文标点里的对应形态。开闭括号各自可选且互不配对约束——
  // 实测存在混用目录名（'Invasion（2021)'），要求配对会把它们漏掉，留下孤儿括号。
  t = t.replace(/\s*[\(\[（【]?\d{4}[\)\]）】]?\s*$/, '')
  // 去掉末尾年份（无括号，如 "Show 2024"）
  t = t.replace(/\s+\d{4}\s*$/, '')
  return t.trim()
}

/** 生成 TMDB 搜索候选：主标题 + 中文变体（从目录名形态）。
 *  用于 prompt 告诉 agent 搜什么，agent 自己决定最终搜索词。 */
export function searchCandidates(dirName: string): string[] {
  const primary = titleFromDir(dirName)
  const out = new Set<string>()
  if (primary) out.add(primary)
  // 目录名本身就是候选（可能已是完整形态）
  if (dirName.trim()) out.add(dirName.trim())
  return [...out]
}

/** 双证据核验（spec: two-evidence bar）：
 *  名字匹配 + 独立结构证据（年份/类型/集数）至少一条吻合。
 *  返回是否通过。纯函数，TMDB 查询结果由调用方传入。 */
/** 识别写库门（two-evidence bar）的**判据版本**。D-4（2026-09-18），照 v45 `PARSER_VERSION`
 *  的既有机制。
 *
 *  🔴 **何时递增**：改本文件的**任何判据**（标题门、结构证据、媒体类型推断）都必须 +1。
 *
 *  **为什么需要它**：队列谓词里有 `last_error != 'tmdb-404'`，而 `tmdb-404` 是**终态**——
 *  写入它的行从此再也不进识别队列。于是"改好了判据"对**已经落在库里的假 404 行零作用**：
 *  它们被谓词永久排除，改了门也不重跑，生产库原封不动，而且连日志都不会响。
 *  这与 v45 用 parser_version 消灭的静默失效是**同一个形状**。
 *
 *  🔴 **谁写（两条路径，缺一不可）**：
 *   · `identifyScheduler.writeIdentified` 的绑定 UPDATE——识别成功、写完 `work_id` 时盖戳
 *     （记的是"我用哪套门判的"，不是"算出了什么"）。
 *   · **同文件的失败回写路径**——落 `last_error='tmdb-404'` 时**同样必须盖戳**。
 *   ⚠️ 这一条曾只写了前一条（2026-09-18 复核时改正）：只提"那条绑定 UPDATE"会让人以为
 *   写入侧只有一处，于是新增第三条失败路径时不盖戳——而**漏盖戳的后果是热循环**：
 *   该行永远满足"gate 版本落后"，于是每轮巡检都被重新入队、重跑一次识别 agent（付费 LLM），
 *   且看起来完全正常。db.ts 的 v46 entry 也记着「没有第二个写入者」，指的是**别处不许写**，
 *   不是说本文件只有一处要写——这两句话容易读混，故在此并列写清。
 *
 *  **谁读**：`listIdentifyQueue` 把 NULL 归一成 0，允许 `identify_gate_version < 本值` 的行
 *  **重新入队**一次。
 *
 *  **谁触发重跑**：就是这个队列谓词本身——不存在第二个触发器（没有 cron、没有显式重扫）。
 *  重跑仍判 404 时盖上当前版本戳 → 此后收敛，不会每轮重试。 */
export const IDENTIFY_GATE_VERSION = 1

export interface TmdbEvidence {
  id: string
  title: string
  originalTitle: string | null
  year: number | null
  mediaType: 'tv' | 'movie'
  episodeCount?: number
}

export interface DirFacts {
  dirName: string
  fileCount: number
  seasons: number[]   // work_dir 下出现的季号
  hasSeasonDirs: boolean
  /** D-3（2026-09-18）：该 work_dir 下**高置信**文件名解析出的标题，升为一级标题证据。
   *
   *  为什么需要它：目录名会被发布组/网盘污染（`G 爱G公寓5 (2020)`、
   *  `【高清影视之家发布 www.BEBBB.com】特洛伊[…]`），而**文件名往往是干净的**
   *  （`Ipartment.S05E01.mkv`、`Troy.2004.2160p…mkv`）。原实现只吃
   *  `titleFromDir(work_dir)`，把这条最精确的一级证据整条浪费了——生产实案：
   *  `苍穹浩瀚 全6季 4K.HDR&…` 目录名认不出，但同目录的文件名里 `The.Expanse.S01E01` 是干净的。
   *
   *  🔴 只收**高置信**（`parse_confidence === 'high'`，即有明确季集结构、title 取自
   *  `parseFilename` 的 seriesname）的条目：无结构时 `parseFilename` 会把**整个文件名清洗后**
   *  当标题，里面还混着分辨率/编码/发布组（`2160p`/`x265`/`DreamHD`），拿它当标题证据等于给
   *  幻觉开门。收紧到这里，"文件名证据"才是**比目录名更精确**而不是更松的东西。 */
  fileTitles?: string[]
  /** D-4（2026-09-18）：目录名里带季/集标记（`全1-5季`、`Season 3`、`S01`…）——这是
   *  「该作品是剧集」的**独立结构证据**，见 `hasSeasonToken` 的完整论证。
   *  缺席 = 视为无该证据（旧调用点行为不变）。 */
  dirHasSeasonToken?: boolean
}

export function verifyEvidence(
  candidate: TmdbEvidence,
  dirFacts: DirFacts,
  targetTitle: string,
  chineseTitles: string[] = [],
): { ok: true } | { ok: false; reason: string } {
  // 🔴 2026-08-08 实测修正（PLUR1BUS/High School D×D）：纯 normalize 相等太严格，
  // 真实世界的命名变体（leetspeak 1→i、×→x、缩写、粉丝写法）会让合法匹配被拒。
  // 标题匹配降级为"模糊相关性"（显著子串重叠 ≥ 5 字符 或 首词相等）——
  // 机械层只拦"完全无关的标题"（防幻觉），不拦"合法变体"（那是 agent 双证据的职责）。
  const titleCandidates = [normalize(candidate.title)]
  if (candidate.originalTitle != null) titleCandidates.push(normalize(candidate.originalTitle))
  for (const c of chineseTitles) titleCandidates.push(normalize(c))
  const normTarget = normalize(targetTitle)

  /** 一组标题候选与一个"被测串"的匹配判据——**唯一一份**，目录名腿与文件名腿共用。
   *  分叉成两份是本仓反复栽过的坑（C30）。 */
  const matches = (cands: string[], target: string): boolean =>
    cands.some((nc) => {
      if (nc === '' || target === '') return false
      if (nc === target) return true
      // ── CJK 侧（D-2 修复，2026-09-18 复盘 openspec `improve-media-recognition`）───────────
      // 🔴 曾经的单一判据是"显著子串重叠 ≥ 5 字符"，它对**含 CJK 的标题**是错的门：
      // 归一后的中文标题通常是 2~4 字（毒枭=2、西部世界=4、爱情公寓=4），**永远够不到 5 字下限**，
      // 于是整条包含匹配从未在中文字幕上执行过——所有中文目录一律判 `title mismatch`。
      // 生产实案（2026-09-16）：库里 17 个"认不出来"的目录里绝大多数是这个原因。
      //
      // 为什么可以取消下限：原阈值的意图是**防幻觉**，而那个意图只在拉丁侧成立——汉字的信息
      // 密度远高于字母，2 个字已是**完整词**且几乎不共享："毒枭"与"毒液"共享首字但谁也不包含
      // 谁，包含关系本身仍是强证据。
      if (hasCjk(nc) || hasCjk(target)) {
        return nc.includes(target) || target.includes(nc)
      }
      // 显著子串重叠（≥5 字符）——覆盖 PLUR1BUS vs Pluribus 这种部分匹配（纯拉丁侧，行为不变）
      if (nc.length >= 5 && target.length >= 5) {
        if (nc.includes(target) || target.includes(nc)) return true
        const short = nc.length <= target.length ? nc : target
        const long = nc.length <= target.length ? target : nc
        for (let i = 0; i <= short.length - 5; i++) {
          if (long.includes(short.slice(i, i + 5))) return true
        }
      }
      return false
    })

  // 标题证据的两条**并列**腿（D-3）：
  //   ① 目录名腿——候选与 `targetTitle`（已由 titleFromDir 清洗的目录名）互为包含
  //   ② 文件名腿——候选与某个**高置信文件名标题**互为包含
  // 为什么不合并成一组候选去比 targetTitle：那是最弱的形态，**救不了它要救的场景**。
  // 生产实案 `G 爱G公寓5 (2020)`：目录名被注入了 `G`，`Ipartment`（文件名干净解析出的标题）
  // **不可能**是 `g爱g公寓5` 的子串，而 TMDB 的 zh 译名是 `爱情公寓`（不是目录名里的片段）——
  // 于是"并入候选再比目录名"照样 FAIL。文件名证据的价值恰恰在于它**能独立支撑**，不依赖目录名。
  // 判据仍是同一份 `matches()`（防漂移），只是把"被测串"换成文件名标题。
  const fileTitles = (dirFacts.fileTitles ?? []).map(normalize).filter((t) => t !== '')
  const titleOk = matches(titleCandidates, normTarget)
    || fileTitles.some((ft) => matches(titleCandidates, ft))
  if (!titleOk) {
    return { ok: false, reason: `title mismatch: candidate="${candidate.title}" vs dir="${targetTitle}"` }
  }
  // 证据 2：独立结构证据（年份 / 类型 / 集数）
  //  - 年份：candidate.year 与目录名里的年份一致（如果目录名有年份）
  const dirYear = yearFromDir(dirFacts.dirName)
  if (dirYear !== null && candidate.year !== null && dirYear === candidate.year) {
    return { ok: true }
  }
  //  - 类型：candidate.mediaType 与 work_dir 的位置（TV/ 下 → tv）
  //  - 集数：candidate.episodeCount 与文件数（同数量级）
  if (dirFacts.hasSeasonDirs && candidate.mediaType === 'tv') return { ok: true }
  // D-4 第四条腿：**目录名里的季/集标记**也是"这是剧集"的独立结构证据。
  // 它修的是扁平文件目录（`01.mp4`、无季子目录）那一类——`hasSeasonDirs` 为假，
  // 原来一律落进下面那条 movie 分支或最终拒绝。
  if (dirFacts.dirHasSeasonToken === true && candidate.mediaType === 'tv') return { ok: true }
  if (!dirFacts.hasSeasonDirs && candidate.mediaType === 'movie' && dirFacts.fileCount <= 10) {
    return { ok: true }
  }
  return { ok: false, reason: 'no independent structural evidence (year/type/episodes)' }
}

/** 字符串里是否含 CJK 汉字。用于标题门的**分侧判据**（见 verifyEvidence 里的完整论证）：
 *  中文字的信息密度远高于拉丁字母，2 个汉字已是完整词，故 CJK 侧不适用"≥5 字符显著性"这个
 *  为拉丁长标题设计的门槛。
 *
 *  只认**汉字**（Unified Ideograph，U+4E00–U+9FFF 主区 + 扩展 A U+3400–U+4DBF）：
 *  · 不含日文假名（U+3040–U+30FF）——`normalize` 会把假名当字母保留，但假名标题（如
 *    `進撃の巨人`）走原有的拉丁式长度判据更安全（假名是音节文字，信息密度接近字母）。
 *  · 不含全角标点/数字——那些在 normalize 里已被剥掉，且它们单独出现不构成标题。
 *  范围取窄是有意的：宁可让少数混排标题走旧判据（行为不变），也不要放宽到把符号当汉字。 */
function hasCjk(s: string): boolean {
  return /[\u4E00-\u9FFF\u3400-\u4DBF]/.test(s)
}

/** 目录名里是否带"这是剧集"的季/集标记。D-4（2026-09-18）新增：既是**独立结构证据**的
 *  第四条腿，也参与媒体类型推断。
 *
 *  修的是什么：扁平文件目录（文件名 `01.mp4`、季集全 NULL）**且没有**季子目录时，
 *  `hasSeasonDirs || seasons.length > 0` 恒假 → 判 movie → 拿 TV id 去查 movie 端点 → null
 *  → 落 `tmdb-404` **终态**，被队列谓词永久排除。生产实案
 *  `[爱情公寓][全1-5季+电影+番外篇][国语中字][4K高码][203G]`：目录名里的 `全1-5季` 已经
 *  明说了这是剧集，而原实现完全不看目录名里的季信息。
 *
 *  认这几类形态（都是发布命名里**稳定出现**的写法，不是模糊猜）：
 *    · `全1-5季` / `全3季` / `第2季` / `第一季`  —— 中文季标记
 *    · `Season 3` / `season03`                  —— 英文季标记
 *    · `S01` / `s1` / `S01E01`                  —— 缩写季集标记
 *    · `全23集` / `共12集`                       —— 中文集数标记（同为"这是剧集"的证据）
 *
 *  ⚠️ 刻意**不**把裸数字当季号——`2004`（年份）、`265`（编码）、`521G`（体积）都会误判。
 *  宁可漏认（退回旧行为）也不要误认：误认会让 movie 被拿去查 tv 端点，正是要修的形状。 */
export function hasSeasonToken(dirName: string): boolean {
  return (
    /全\s*\d+\s*[-–~至]\s*\d+\s*季/.test(dirName)              // 全1-5季
    || /全\s*\d+\s*季/.test(dirName)                            // 全3季
    || /第\s*[0-9一二三四五六七八九十]+\s*季/.test(dirName)      // 第2季 / 第一季
    || /season\s*\d+/i.test(dirName)                            // Season 3 / season03
    || /(^|[^A-Za-z])S\d{1,2}(E\d{1,3})?([^0-9]|$)/.test(dirName)  // S01 / S01E01
    || /全\s*\d+\s*集/.test(dirName)                            // 全23集
    || /共\s*\d+\s*集/.test(dirName)                            // 共12集
  )
}

function normalize(s: string): string {
  // 命名变体归一（2026-08-08 实测踩中三类）：
  //  ×（U+00D7）→ x："D×D" 是 "DxD" 的粉丝写法
  //  leetspeak 数字 → 字母：PLUR1BUS → Pluribus（1→i）、M4TRIX → Matrix（4→a）
  //  变音符号折叠：Amélie→Amelie、Shōgun→Shogun（目录名常无 diacritic）
  //  之后再删非字母数字（空格/标点/年份分隔符）
  return s.toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/×/g, 'x')
    .replace(/1/g, 'i').replace(/4/g, 'a').replace(/3/g, 'e')
    .replace(/0/g, 'o').replace(/5/g, 's').replace(/7/g, 't')
    .replace(/[^\p{L}\p{N}]+/gu, '').trim()
}

export interface YearHit {
  title: string
  originalTitle: string | null
  year: number | null
}

function exactName(hit: YearHit, claimedTitle: string): boolean {
  const claimed = normalize(claimedTitle)
  if (!claimed) return false
  if (normalize(hit.title) === claimed) return true
  if (hit.originalTitle != null && normalize(hit.originalTitle) === claimed) return true
  return false
}

/** Directory year vs TMDB year off by 1–2, and no other exact-name title in a different year. */
export function yearFolderTypoOk(
  dirYear: number | null,
  tmdbYear: number | null,
  claimedTitle: string,
  hits: YearHit[],
): boolean {
  if (dirYear == null || tmdbYear == null) return false
  const delta = Math.abs(dirYear - tmdbYear)
  if (delta !== 1 && delta !== 2) return false
  const sameName = hits.filter((h) => exactName(h, claimedTitle))
  if (sameName.length === 0) return false
  return !sameName.some((h) => h.year != null && h.year !== tmdbYear)
}

const YEAR_IDENT_FAIL = /year|identification-failed/i
const YEAR_FOLDER_TYPO_REASON =
  'year-folder-typo: directory year vs TMDB year is not a different work; do not treat as source-empty'

export function applyYearFolderTypoGate(
  report: FindSubtitleBatchReport,
  args: {
    dirYear: number | null
    tmdbYear: number | null
    claimedTitle: string
    hits: YearHit[]
    boundItemIds: ReadonlySet<string>
  },
): FindSubtitleBatchReport {
  if (!yearFolderTypoOk(args.dirYear, args.tmdbYear, args.claimedTitle, args.hits)) {
    return report
  }

  const dropped: typeof report.no_safe_match = []
  const no_safe_match = report.no_safe_match.filter((entry) => {
    if (
      entry.itemId != null
      && args.boundItemIds.has(entry.itemId)
      && YEAR_IDENT_FAIL.test(entry.reason)
    ) {
      dropped.push(entry)
      return false
    }
    return true
  })

  const already = new Set<string>()
  for (const item of report.installed) {
    if (item.itemId != null) already.add(item.itemId)
  }
  for (const item of report.retry_later) {
    if (item.itemId != null) already.add(item.itemId)
  }

  const retry_later = [...report.retry_later]
  for (const entry of dropped) {
    if (entry.itemId == null || already.has(entry.itemId)) continue
    already.add(entry.itemId)
    retry_later.push({ itemId: entry.itemId, reason: YEAR_FOLDER_TYPO_REASON })
  }

  return { ...report, no_safe_match, retry_later }
}

export function yearFromDir(dirName: string): number | null {
  const m = dirName.match(/(?:\(|\[)?(\d{4})(?:\)|\])?/)
  return m ? Number(m[1]) : null
}
