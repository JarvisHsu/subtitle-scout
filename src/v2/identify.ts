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
  const titleOk = titleCandidates.some((nc) => {
    if (nc === '' || normTarget === '') return false
    if (nc === normTarget) return true
    // ── CJK 侧（D-2 修复，2026-09-18 复盘 openspec `improve-media-recognition`）─────────────
    // 🔴 曾经的单一判据是"显著子串重叠 ≥ 5 字符"，它对**含 CJK 的标题**是错的门：
    // 归一后的中文标题通常是 2~4 字（毒枭=2、西部世界=4、爱情公寓=4），**永远够不到 5 字下限**，
    // 于是整条包含匹配从未在中文字幕上执行过——所有中文目录一律判 `title mismatch`。
    // 生产实案（2026-09-16）：库里 17 个"认不出来"的目录里绝大多数是这个原因，
    // `evidence-fail: title mismatch: candidate="Narcos" vs dir="[毒枭][全1-3季]…"`，
    // 而 TMDB 上 Narcos 的 zh 译名正是 `毒枭`、是目录名的字面前缀。
    //
    // 为什么可以取消下限：原阈值的意图是**防幻觉**（拦住与目录名无关的候选），而那个意图只在
    // 拉丁侧成立——汉字的信息密度远高于字母，2 个字已是**完整词**且几乎不共享：
    // "毒枭"与"毒液"共享首字但谁也不包含谁，包含关系本身仍是强证据。故：
    //   · 含 CJK 的候选 → 只要求归一后互为子串（含相等，相等上面已处理）
    //   · 纯拉丁的候选 → 保持原有 ≥5 字符显著性重叠，行为一字不改
    // 双证据条（本函数下半段的年份/类型/集数）不放松，仍然是"名字 + 独立结构证据"两道。
    if (hasCjk(nc) || hasCjk(normTarget)) {
      if (nc.includes(normTarget) || normTarget.includes(nc)) return true
      // CJK 侧不做"短串滑窗找 5 字"那一套——那是为拉丁长标题设计的部分匹配补丁，
      // 对 2~4 字的中文标题既不适用（滑窗步长本就是 5）也无必要。
      return false
    }
    // 显著子串重叠（≥5 字符）——覆盖 PLUR1BUS vs Pluribus 这种部分匹配
    if (nc.length >= 5 && normTarget.length >= 5) {
      if (nc.includes(normTarget) || normTarget.includes(nc)) return true
      // 最长公共子串（简化：取短串的前 5+ 字符在长串里找）
      const short = nc.length <= normTarget.length ? nc : normTarget
      const long = nc.length <= normTarget.length ? normTarget : nc
      for (let i = 0; i <= short.length - 5; i++) {
        if (long.includes(short.slice(i, i + 5))) return true
      }
    }
    return false
  })
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
