// src/v2/subtitleActivityDetail.ts —— REQ-1a「当前动作可见」的**纯派生**：
// 把 trace 事件（agent 工具调用）翻译成"**某个具体文件现在正在做什么**"。
//
// ── 为什么是纯函数（设计选择 A）─────────────────────────────────────────────
// 派生逻辑不碰 IO、不读时钟、不碰 DB：它的输入就是 `TraceEvent[]` + 目标清单，
// 输出就是 per-key 的 detail。这样它可以在单测里被**穷举**（本仓栽过多次"有表有函数
// 但没人触发"，而纯函数至少能把"翻译对不对"这一半钉死），也能被复用给 REQ-1c 的事后回看。
//
// ── 形状从哪来（**不是设计的，是量出来的**）─────────────────────────────────
// 2026-09-23 从生产 `runs.trace_json` 里读出的真实形状（证据：
// ops/servers/43.134.191.43/evidence/req1a-trace-shape.mjs 的输出）：
//   · `search_source`      args `{queries:[…]}`  result `{count:44, top:[{id:"zimuku:192411"},…]}`
//   · `get_candidate`      args `{result_set_id,index,detail}` result `{provider,providerId,…}`
//   · `download_candidate` args `{candidateId:"subhd:58pnuQ", videoFilename:"…mkv", itemId:"tmdb:121860/s1e7"}`
//                          result 成功=下载产物；失败=`{"error":"subhd prepare-download failed: …500…"}`
//   · `check_episode_code_safety` args `{filename,season,episode}` result `{safe:false,expectedCode:"S02E12"}`
// 所以 `videoFilename` / `filename` 是**文件身份**，`candidateId` 的 `provider:` 前缀是**源站身份**。
//
// ── 约束（不许违反）────────────────────────────────────────────────────────
// 1. R-F10 的封闭集合不撑开：这里**不新增事件类型**，产物塞进既有的 `progress.data.targets`。
// 2. 不许把不知道的说成进度：能证明的（工具名、源站、耗时、结果摘要）才写；
//    拿不到的（比如"还剩几分钟"）**留空**，不编一个数字。`note` 一律取**事件自带的摘要**，
//    不在这里编人类文案。

import type { TraceEvent } from '../core/traceBus.js'
import type { SubtitleTargetDetail } from '../core/scoutEvents.js'
import { targetKey, targetLabel } from './subtitleTargets.js'

/** 派生所需的文件身份——只取匹配用得上的三样，避免把 SubtitleQueueItem 整个拖进来。 */
export interface DetailPlanFile {
  filename: string
  season: number | null
  episode: number | null
}

/** 一条 trace 事件对某个文件意味着什么。全部字段都可能缺席（缺席 = 这条事件没告诉我们）。 */
export interface DetailEventView {
  step: string
  source: string | null
  note: string | null
  ms: number
}

/** 工具名 → 这一轮"已经搜过几个源"的计数依据：只有 search 类算搜过。 */
const SEARCH_TOOLS = new Set(['search_source', 'list_candidates'])

/** 注意量级：note 会随每条 progress 帧进 SSE，故截断到 72 字符（前缀信息量远大于尾部）。 */
const NOTE_CAP = 72

function parseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function trim(s: string): string {
  return s.length > NOTE_CAP ? `${s.slice(0, NOTE_CAP - 1)}…` : s
}

/** 🔴 第 61 轮：这行 note 里若混进了**读不出来的字节**，就别把它印给用户看。
 *
 *  ── 修的是什么（生产实测，`GET /api/v2/workbench/runs/last-subtitle` 的原始字节）──
 * 界面那行 detail 出现了 `下载失败：selected file not found in zip: ��ـ֮�Y���p.S01E07.chs.srt`。
 * 逐层查下来，坏字节只存在于**一个**地方：`runs.trace_json`（30/154 行含 U+FFFD），
 * 形态是 `锟斤拷锟斤拷&英锟斤拷` —— 那是 provider zip 条目名经历了 **GBK↔UTF-8 双向误解码**
 * 的典型产物（`archiveEntries` 字段）。而 `files.last_error`(0/224)、`runs.detail`(0/158)、
 * `files.filename`(0/816)、`works.title`(0/77) **全都干净**，`/cache/result-sets` 的
 * 687 个文件也 **0** 个坏字节 ⇒ 坏字节是**源端 zip 元数据**带来的，不是我们写库写坏的。
 *
 * ── 为什么是"不显示"而不是"修好它"──────────────────────────────────────────
 * 原始字节在双向误解码里**已经丢了**，无法还原（这不是我们这边 decode 错了，去修 decode
 * 也无从下手）。而那段文字现在**没有任何信息量**，还给用户一种"这软件坏了"的观感
 * （本仓的 Carbon 双通道：文字自己要把话说全——而乱码说的是"你读不出我"）。
 * 故：**说清"读不出来"，并保留真正有信息量的那半句**。
 *
 * 判据用 U+FFFD（UTF-8 替换字符）而不是"看起来像乱码"：
 * 它是解码失败在字节层的**确证**，不是审美判断（不能因为"像乱码"就吞掉合法内容）。 */
function hasUndecodable(s: string): boolean {
  return s.includes('\uFFFD')
}

/** 把可能含坏字节的一段收拾成可读的：坏就换成一句人话，好就原样。 */
function readable(s: string | null): string | null {
  if (s === null) return null
  return hasUndecodable(s) ? '（源站返回的文件名无法解码）' : s
}

/** 取文件身份：`videoFilename`（download_candidate）与 `filename`（check_episode_code_safety） */
function eventFilename(args: Record<string, unknown> | null): string | null {
  if (args === null) return null
  return str(args.videoFilename) ?? str(args.filename)
}

/** 源站：`candidateId` 形如 `subhd:58pnuQ` / `assrt:667241` 的冒号前缀。取不到就 null（不猜）。 */
function providerOf(candidateId: string | null): string | null {
  if (candidateId === null) return null
  const i = candidateId.indexOf(':')
  return i > 0 ? candidateId.slice(0, i) : null
}

/** 把下载失败的 `resultSummary` 收拾成一句人话；成功时给 null。 */
/** 不复述成功：成功本身由格子变 installed 表达，再写一句"下载成功"只是噪音。 */
function downloadNote(result: Record<string, unknown> | null): string | null {
  const err = str(result?.error)
  if (err === null) return null
  // 真实实例（Baki/狂赌之渊）：`subhd prepare-download failed: {…"message":"服务器内部错误"…}`
  // 或 `Command failed: curl …`。前者能取出中文人话；后者只留前 72 字——原始错误必须留痕，
  // 但界面不该被一整条 curl 命令行淹没。
  const msg = /"message"\s*:\s*"([^"]+)"/.exec(err)
  return msg !== null ? trim(`下载失败：${readable(msg[1])}`) : trim(`下载失败：${readable(err)}`)
}

/** 把一条 trace 事件翻译成 detail 片段；事件与文件无关（识别类工具）时返回 null。 */
export function detailFromEvent(e: TraceEvent, file: DetailPlanFile): DetailEventView | null {
  const args = parseJson(e.argsSummary)
  const result = parseJson(e.resultSummary)
  const ms = Number.isFinite(e.tookMs) ? Math.max(0, e.tookMs) : 0

  if (e.tool === 'search_source' || e.tool === 'list_candidates' || e.tool === 'get_candidate') {
    // 这三个是**作品级**动作（一次搜索服务本作品的全部目标），不指向某个文件；
    // 但 `search_source` 带 season/episode 时能定位到一集。
    const season = num(args?.season)
    const episode = num(args?.episode)
    const pointsAtThisFile =
      season !== null && episode !== null && season === file.season && episode === file.episode
    if (!pointsAtThisFile) return null
    if (e.tool === 'search_source') {
      const count = num(result?.count)
      return {
        step: e.tool,
        source: null,
        note: count === null ? null : `找到 ${count} 个候选`,
        ms,
      }
    }
    return { step: e.tool, source: null, note: null, ms }
  }

  // 以下工具**自带文件身份**：它们只在本文件被真正处理时才会出现，匹配到才算数。
  if (eventFilename(args) !== file.filename) return null

  if (e.tool === 'download_candidate') {
    const candidateId = str(args?.candidateId)
    return {
      step: e.tool,
      source: providerOf(candidateId),
      note: downloadNote(result),
      ms,
    }
  }

  if (e.tool === 'check_episode_code_safety') {
    const safe = result?.safe
    const expected = str(result?.expectedCode)
    let note: string | null = null
    if (safe === false) {
      note = expected === null ? '季集号不安全' : `季集号不安全（应为 ${readable(expected)}）`
    }
    return { step: e.tool, source: null, note, ms }
  }

  if (e.tool === 'install_subtitle') {
    return { step: e.tool, source: providerOf(str(args?.candidateId)), note: null, ms }
  }

  // 其余（read_doc / search_tmdb / get_tmdb_details / finalize / write_identified_media …）不指向文件。
  return null
}

/** 一个文件的**累计**动作视图：把该文件相关的事件按顺序汇总。 */
export interface DetailAccum {
  detail: SubtitleTargetDetail
  /** 命中的事件条数——供测试与"证据够不够"的判断用，不上线。 */
  hits: number
}

/**
 * 实时桥接用：**一条事件** → "它说的是哪个文件、这一步是什么"。与文件无关（识别类工具，
 * 或下载类工具但没带文件名）→ null。
 *
 * 与 `deriveSubtitleActivityDetail` 共用同一个 `detailFromEvent`，故实时的读数与事后
 * 全量重算**不可能漂移**（本仓 D7/C30「留两份实现必漂移」）。
 */
export function detailViewFor(
  e: TraceEvent,
  files: DetailPlanFile[],
  workId: string,
): { key: string; label: string; event: DetailEventView; tool: string } | null {
  for (const f of files) {
    const v = detailFromEvent(e, f)
    if (v === null) continue
    return { key: targetKey(workId, f.season, f.episode), label: targetLabel(f.season, f.episode), event: v, tool: e.tool }
  }
  return null
}

/**
 * 把一条新事件**并入**已有的 detail（实时路径的增量口径）。
 *
 * `prev` 为 undefined = 这个文件此前没有任何动作 ⇒ 从这条事件起算。
 * `steps`/`sources` 去重保序；`searched` 只在 `search_source` 上 +1（list/get 是翻页与细看，
 * 不是"又搜了一个源"——把它算进去会让人以为搜了很多源）。
 */
export function accumulateDetail(
  prev: SubtitleTargetDetail | undefined,
  v: DetailEventView,
  tool: string,
): SubtitleTargetDetail {
  const isSearch = tool === 'search_source'
  return {
    step: v.step,
    // source 与 note 同一口径：**本条没告诉我们**（如 search_source 没有源站概念、
    // 无 candidateId 的装盘）就保留上一次知道的那个，而不是抹成 null。
    // 抹掉会把"刚才还在从 subhd 下"变成一片空白——那比留着一个**仍有语义**的旧值更误导
    // （这一格始终配着 `step` 与 `ms` 一起看，读得出先后）。
    source: v.source ?? prev?.source ?? null,
    note: v.note ?? prev?.note ?? null,
    ms: (prev?.ms ?? 0) + v.ms,
    steps: prev === undefined || !prev.steps.includes(v.step) ? [...(prev?.steps ?? []), v.step] : prev.steps,
    sources: v.source === null || (prev?.sources ?? []).includes(v.source)
      ? (prev?.sources ?? [])
      : [...(prev?.sources ?? []), v.source],
    searched: (prev?.searched ?? 0) + (isSearch ? 1 : 0),
  }
}

/**
 * 汇总本作品全部 trace 事件 → per-target-key 的 detail。
 *
 * `steps` 取**去重后按首次出现排序**的动作名，故它不是"事件流水"而是"这个文件经历过哪些动作"，
 * 长度天然有界（工具集合是封闭的），不会随帧数涨。
 */
export function deriveSubtitleActivityDetail(
  events: TraceEvent[],
  files: DetailPlanFile[],
  workId: string,
): Map<string, SubtitleTargetDetail> {
  const out = new Map<string, SubtitleTargetDetail>()
  for (const f of files) {
    const steps: string[] = []
    const sources: string[] = []
    let ms = 0
    let last: DetailEventView | null = null
    let hits = 0
    let searched = 0
    for (const e of events) {
      const v = detailFromEvent(e, f)
      if (v === null) continue
      hits++
      ms += v.ms
      if (SEARCH_TOOLS.has(e.tool) && e.tool === 'search_source') searched++
      if (!steps.includes(v.step)) steps.push(v.step)
      if (v.source !== null && !sources.includes(v.source)) sources.push(v.source)
      // "最近一条"以**事件时间**为准（at 相同则取后出现的那条，与 trace 的 seq 顺序一致）。
      last = v
    }
    out.set(targetKey(workId, f.season, f.episode), {
      step: last === null ? null : last.step,
      source: last === null ? null : last.source,
      note: last === null ? null : last.note,
      ms,
      steps,
      sources,
      searched,
    })
  }
  return out
}
