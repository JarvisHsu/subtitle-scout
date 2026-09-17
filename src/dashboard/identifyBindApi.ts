// src/dashboard/identifyBindApi.ts —— D-5 人工绑定通道（2026-09-18）。
//
// ══════════════════════════════════════════════════════════════════════════════
// 修的是什么：用户**唯一**的"手动"手段是去文件管理器改目录名
// ══════════════════════════════════════════════════════════════════════════════
// 提案原话：「人工介入通道为零。`GET /api/v2/tmdb/search` 是只读代理；`ClaimDialog` 与
// `identify_overrides` 表已随 v27 退役。用户当前唯一的『手动』手段是去文件管理器改目录名
// ——而这恰好对本节的故障目录无效。」
//
// 生产实案坐实了这个洞：`[毒枭][全1-3季]…` 这类目录，改名要么破坏发布组原始命名、要么
// 用户根本不知道该改成什么（他不知道 TMDB 上这部作品的英文名）。D-2/D-3/D-4 修好了**机械
// 判据**，但判据再宽也架不住 agent 一开始就搜错了作品——那时用户需要一个"就是它"的开关。
//
// ── 设计要点一：写库**复用自动识别的整条路径**，不开旁路 ──────────────────────
// 提案明写「写库复用自动识别同一套核验与事务，不开旁路」。实现方式是：本模块**直接调用
// `runIdentifyWorkDir`**，只把 `runIdentify` 换成一个"立即返回用户选定 tmdbId"的 stub：
//
//     runIdentifyWorkDir(deps, item, 'human')
//       └─ buildFacts（同样的季集/文件名事实）
//       └─ writeIdentified
//            ├─ 双向类型核验（D-4）——用户的 id 同样要过这一关
//            ├─ verifyEvidence（D-2 CJK 门 + D-3 文件名腿 + D-4 季标记腿）
//            ├─ works 行 INSERT（provider_ids / backdrop / zh 简介三件套的现值兜底）
//            └─ files UPDATE（work_id / identify_gate_version / work_id_source）
//
// 于是**没有任何一份判据是第二实现**：D-2/D-3/D-4 以后再怎么改，人工绑定自动跟着改。
// 这也是为什么本模块里看不到第二条 verifyEvidence 调用——那是刻意的。
//
// ⚠️ 用户选定的 tmdbId **不是免检通道**：`verifyEvidence` 照样要过。用户可能选错作品
// （TMDB 上同名作品很多），而写错身份比不写更糟——那是把字幕装到错的作品上。故绑定失败时
// 如实回报 `evidence-fail`，与自动路径同一个错误文案。
//
// ── 设计要点二：句柄是**不透明的**，不是绝对路径 ──────────────────────────────
// `buildUnidentifiedHealth` 的既有纪律（见该文件头注释）是「出**目录名**而不是**绝对路径**：
// 前面的挂载点前缀对用户毫无信息量，且把容器内路径贴给用户是纯排障噪音」。
// 但 POST 需要一个能回指的机器可用指针，故用 base64url(work_dir) 作**不透明句柄**：
// 前端只把它当字符串原样回传，不需要也不应该解释它。URL 安全（无 +/= 需转义）。
//
// ── 设计要点三：撤销闸**只认 `work_id_source='human'`** ───────────────────────
// 绝不许一键抹掉 agent 的判定——那会把一次正常的自动识别变成静默回退，用户看不出发生过
// 什么。见 db.ts v47 entry 的论证。
import type { ScoutDb } from '../v2/db.js'
import { runIdentifyWorkDir, type IdentifySchedulerDeps } from '../v2/identifyScheduler.js'
import type { IdentifyWorkerDeps } from '../agent/identifyWorker.js'
import { decodeWorkDirHandle, encodeWorkDirHandle } from '../core/workDirHandle.js'

// 编解码住在 core/workDirHandle.ts（中立模块）：只读的 unidentifiedHealth 也要用它，
// 不该为一个 base64 把整条识别轨（→ agent → LLM SDK）拖进只读路径。这里只做转出，
// 让绑定 API 的调用方有一个入口。
export { decodeWorkDirHandle, encodeWorkDirHandle }

export type BindResult =
  | { ok: true; workDir: string; tmdbId: string; written: number; title: string | null }
  | { ok: false; status: number; error: string }

export interface BindDeps {
  db: ScoutDb
  /** 与 identifyScheduler 同一个 TMDB 注入面——不新开一个客户端。 */
  tmdb: IdentifyWorkerDeps['tmdb']
  now?: () => number
}

/** 人工把一个未识别的 `work_dir` 绑定到指定 TMDB 作品。
 *
 *  @param handle `buildUnidentifiedHealth` 给出的不透明句柄
 *  @param tmdbId 用户在 `GET /api/v2/tmdb/search` 里选中的 TMDB id（纯数字串）
 */
export async function bindUnidentifiedDir(
  deps: BindDeps,
  input: { handle: string; tmdbId: string },
): Promise<BindResult> {
  const workDir = decodeWorkDirHandle(input.handle)
  if (workDir === null) {
    return { ok: false, status: 400, error: 'invalid handle' }
  }
  if (!/^\d+$/.test(input.tmdbId)) {
    return { ok: false, status: 400, error: 'tmdbId must be a numeric TMDB id' }
  }

  // 该目录必须**真的存在且尚未识别**。两道都必要：
  //  · `work_id IS NULL` 过滤掉"已经识别成功"的目录——否则用户可以用一个人工请求把一部
  //    已正确识别的作品改绑到别的 id 上，而那条路径本来有 agent 的证据链把关。
  //  · 目录存在性靠这个查询本身（COUNT=0 即不存在或已识别），不另做文件系统探测——那是
  //    FUSE 上的昂贵操作（生产实测全库遍历会超时），而这里的信息全在库里。
  const row = deps.db
    .prepare('SELECT COUNT(*) AS n FROM files WHERE work_dir = ? AND work_id IS NULL')
    .get(workDir) as { n: number }
  if (row.n === 0) {
    return { ok: false, status: 404, error: 'no unidentified files under this handle (already identified or unknown)' }
  }

  const dirName = workDir.split(/[/\\]+/).filter((s) => s.length > 0).pop() ?? workDir
  // 季节/季目录事实交给 buildFacts 自己去库里读（它在 runIdentifyWorkDir 内部调用），
  // 这里只提供 IdentifyQueueItem 需要的形状。`seasons`/`hasSeasonDirs` 留空**不是**遗漏：
  // buildFacts 会用 `files` 表的 season 列重算，`hasSeasonDirs` 只影响类型推断的**首选**，
  // 而 D-4 的双向核验保证首选错了也能命中。人工绑定因此不需要用户填类型。
  const item = {
    workDir,
    dirName,
    fileCount: row.n,
    seasons: [] as number[],
    hasSeasonDirs: false,
  }

  const runIdentify: IdentifySchedulerDeps['runIdentify'] = async () => ({
    tmdbId: input.tmdbId,
    title: null,
    reason: 'human-bind',
  })

  const schedulerDeps: IdentifySchedulerDeps = {
    db: deps.db,
    // worker.model 在绑定路径上从不被读（runIdentify 是 stub，不调 LLM）；给一个空对象是
    // 刻意的——它让"绑定会意外烧 LLM 配额"这件事在类型与运行期都不可能发生。
    worker: { model: undefined as never, tmdb: deps.tmdb },
    runIdentify,
    now: deps.now,
  }

  const report = await runIdentifyWorkDir(schedulerDeps, item, 'human')

  // 🔴 成功判据必须是**两件事同时成立**：认出了身份（`tmdbId !== null`）**且**真的写进去了
  // （`writeError === undefined`）。
  //
  // 只看 `tmdbId` 是个**静默陷阱**：写库失败时 `identifyScheduler` 返回的是
  // `{ ...report, reason: '… [bind failed: …]', writeError }`——`tmdbId` 被**刻意保留**
  // （"认定结果"确实没变，变的只是"没写进去"）。于是 `tmdbId !== null` 对一次 evidence-fail
  // 也成立，绑定端点会把一次**库里一个字都没动**的请求回报成 200。
  // 本文件第一版就是这么写的，被 src/dashboard/identifyBindApi.test.ts 的两条用例当场逮住
  // （422 与 502 两条都回报了 ok）。判据的完整论证写在 IdentifyReport.writeError 的头注释。
  if (report.tmdbId === null || report.writeError !== undefined) {
    // 用 writeError 而不是 report.reason 分类：reason 被上层拼成了
    // `human-bind [bind failed: evidence-fail: …]`，前缀噪音会让 startsWith 判据失准。
    const reason = report.writeError ?? report.reason
    // 自动路径把失败原样写进这个字段（`evidence-fail: …` / `tmdb-404` / `error: …`）。
    // 这里转成 HTTP 语义：
    //   · 证据不过 = 422 —— 用户给的身份没能过机械核验。**这是可重试的**（换一个 id 再试），
    //     且必须与自动路径同一个错误文案，否则"人工绑定为什么失败"会出现第二套解释。
    //   · 其余（TMDB 两种类型都查不到 / 任何异常）= 502 —— TMDB 侧问题，不是用户的错。
    const isEvidenceFail = reason.startsWith('evidence-fail')
    return {
      ok: false,
      status: isEvidenceFail ? 422 : 502,
      error: reason,
    }
  }

  const written = (
    deps.db
      .prepare("SELECT COUNT(*) AS n FROM files WHERE work_dir = ? AND work_id_source = 'human'")
      .get(workDir) as { n: number }
  ).n
  return { ok: true, workDir, tmdbId: report.tmdbId, written, title: report.title }
}

export type UnbindResult =
  | { ok: true; workDir: string; cleared: number }
  | { ok: false; status: number; error: string }

/** 撤销一次**人工**绑定（把 `work_id` 清回 NULL，让它重新进识别队列）。
 *
 *  🔴 只清 `work_id_source = 'human'` 的行。agent 的判定不许被这个端点抹掉——那会把一次正常
 *  的自动识别变成静默回退（见 db.ts v47 entry）。因此 `cleared === 0` 是**正常结果**，
 *  语义是"这里没有可撤销的人工绑定"，报 409 而不是静默成功。
 *
 *  `works` 行**不删**：它可能被别的目录（或同一作品的另一季）引用，且删掉会让"绑错了"
 *  这件事失去痕迹。留着是无害的——没有 files 行指向它，它不出现在媒体库页。 */
export function unbindUnidentifiedDir(
  deps: { db: ScoutDb; now?: () => number },
  input: { handle: string },
): UnbindResult {
  const workDir = decodeWorkDirHandle(input.handle)
  if (workDir === null) {
    return { ok: false, status: 400, error: 'invalid handle' }
  }
  const now = deps.now?.() ?? Date.now()
  const r = deps.db
    .prepare(
      `UPDATE files SET work_id = NULL, work_id_source = NULL, updated_at = ?
       WHERE work_dir = ? AND work_id_source = 'human'`,
    )
    .run(now, workDir)
  if (r.changes === 0) {
    return { ok: false, status: 409, error: 'nothing to undo: no human-bound files under this handle' }
  }
  return { ok: true, workDir, cleared: r.changes }
}
