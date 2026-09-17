// 字幕试错沙盒:候选下载到这里"打开看",agent 终审通过才原子安装进媒体目录。
// 试错本身零风险——job 结束(无论成败)整个沙盒目录被删除,写错媒体库的唯一路径是 install()。
import {
  existsSync, mkdirSync, rmSync, rmdirSync, writeFileSync, readFileSync,
  renameSync, openSync, fsyncSync, closeSync, unlinkSync,
  readdirSync, readSync, lstatSync, type Dirent,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { writeAll } from './fsUtil.js'
import {
  isJunkDirName, STAGING_DIRNAME, TRANSLATE_STAGING_DIRNAME, stagingDirName,
} from '../core/mediaContext.js'

const INSTALL_RETRY_DELAYS_MS = [50, 150, 400, 1000]
const RETRYABLE_CODES = new Set(['EEXIST', 'EPERM', 'EBUSY'])

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** 空壳判据要校验的标记内容前缀：本项目两个沙盒写入点写下的 `.ignore` 都以它开头
 *  （stagingSandbox 的 ensureStagingMarker、translate/workspace/paths.ts 的 ensureWorkspaceLayout）。 */
const HUSK_MARKER_PREFIX = 'subtitle-scout'
/** 前缀校验只读这么多字节——标记本该只有 60 余字节，但有界读让"万一被换成一个巨大文件"
 *  的代价固定，而不是随文件大小增长（媒体根常在网络挂载上）。 */
const MARKER_PREFIX_BYTES = 256

/** 读 path 的前 n 字节；读不到返回 null（不存在/无权限/目录/坏链接）。 */
function readPrefix(path: string, n: number): string | null {
  let fd: number | undefined
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.allocUnsafe(n)
    const read = readSync(fd, buf, 0, n, 0)
    return buf.toString('utf8', 0, read)
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort：关不掉 fd 不该把"读到了什么"变成一次抛错
      }
    }
  }
}

/** 确保 `<root>/.ignore` 屏蔽标记存在（内容为本项目写死的字面量）。标记文件是
 *  `<root>` 一级、跨 job 共用的媒体服务器（Jellyfin）第二道屏蔽——点前缀目录本身就默认不扫，
 *  这个文件是双保险。best-effort：缺失从不阻塞任何流程，顶多让媒体服务器误扫到半成品字幕。
 *
 *  从 allocate 里抽出来是因为 cleanup 的收尾也需要它（rmdir 撞 ENOTEMPTY 时把标记补回）。 */
function ensureStagingMarker(root: string): void {
  const ignorePath = join(root, '.ignore')
  if (existsSync(ignorePath)) return
  try {
    writeFileSync(ignorePath, 'subtitle-scout staging area — media servers should not scan this directory\n')
  } catch {
    // best-effort 标记;缺失从不阻塞试错流程,顶多让 Jellyfin 误扫到孤儿 srt
  }
}

/** dir 是不是一个"空壳沙盒"：目录里**唯一**的条目是名为 `.ignore` 的普通文件，且它的内容
 *  以 `subtitle-scout` 开头。任一条件不满足 → false。
 *
 *  ── 为什么这个判据天然安全（而不是"看起来大概没在用"）──────────────
 *  allocate 的动作顺序是"先 mkdirSync(<root>/<jobId>)、后确保 .ignore 存在"。
 *  因此**存在标记文件却不存在任何 <jobId> 条目 ⟺ 此刻没有任何任务在用这个目录**——
 *  这是由分配顺序保证的蕴含关系。
 *
 *  ── 为什么要校验内容前缀 ────────────────────────────────────────
 *  判据已要求"目录里只有一个 `.ignore`"，再校验前缀是为了杜绝"用户自己恰好建了个叫
 *  `.subtitle-staging` 的目录、里面恰好只有一个 `.ignore`"这类巧合被我们删掉。前缀是
 *  两个写入点共有的特征，成本是一次 ≤256 字节的有界读。
 *
 *  判错的代价不对称：返回 false 只是少删一个空目录（下次 boot 再试 / doctor 会报出来），
 *  返回 true 却会真的删目录。故一切读不到、内容不符、条目数不为 1 的情形一律 false。 */
export function isStagingHusk(dir: string): boolean {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  if (entries.length !== 1) return false
  const only = entries[0]
  if (only.name !== '.ignore' || !only.isFile()) return false
  const prefix = readPrefix(join(dir, '.ignore'), MARKER_PREFIX_BYTES)
  return prefix !== null && prefix.startsWith(HUSK_MARKER_PREFIX)
}

/** 尽力 fsync 目录:rename 落盘后目录 inode 本身(条目指针)也该 fsync 一次,防止断电场景下
 *  目录项没跟着落盘、重启后 rename "消失"。部分平台/文件系统(Windows、部分 FUSE/SMB 挂载)不
 *  支持对目录 fd 调 fsync——那类环境直接吞掉失败,不让这个尽力而为的加固步骤反噬本已成功的安装。 */
function fsyncDirBestEffort(dir: string): void {
  let fd: number | undefined
  try {
    fd = openSync(dir, 'r')
    fsyncSync(fd)
  } catch {
    // best-effort：目录 fsync 不是所有平台/文件系统都支持，失败不影响已经成功的 rename
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // best-effort
      }
    }
  }
}

/** 跨设备兜底(理论上不该发生——沙盒与视频同根,见 allocate):拷到目标目录内点前缀
 *  临时名 → fsync → 同盘 rename。任何一步失败(写入/fsync/改名)都 best-effort 删掉这个
 *  临时文件再往外抛——否则它会永久留在媒体目录里,既不是试错沙盒的一部分(不会被 cleanup()
 *  回收),也不在 gcOrphans 的清扫范围内(那只扫 .subtitle-staging/ 内部)。 */
function copyThenRenameSameDir(stagedPath: string, finalPath: string): void {
  const data = readFileSync(stagedPath)
  const tmpPath = join(dirname(finalPath), `.subtitle-scout-install-${process.pid}-${Date.now()}`)
  const fd = openSync(tmpPath, 'w')
  try {
    try {
      writeAll(fd, data)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(tmpPath, finalPath)
  } catch (e) {
    try {
      unlinkSync(tmpPath)
    } catch {
      // best-effort: cleanup failure must never mask the original error, and the temp
      // file may already be gone (e.g. rename itself succeeded before a caller-side
      // failure elsewhere) or unlink may fail on a flaky NAS/SMB mount
    }
    throw e
  }
}

/** 每 job 独立的沙盒目录:`<mediaRootForVideo>/.subtitle-staging/<jobId>/`。必须与目标视频
 *  同一文件系统——install() 的原子 rename 单跳不容跨设备。目录带点前缀 + 同级 `.ignore`
 *  标记文件,Jellyfin 双保险扫不到。jobId 由调用方保证同一时刻内唯一。
 *
 *  mediaRootForVideo 必须是"包含该视频的媒体根"(配置里 MEDIA_ROOTS / mapping.to 的那一级),
 *  不是视频所在的深层目录(如 .../Show/Season 01/)。gcOrphans 只在每个媒体根下非递归扫描
 *  `<root>/.subtitle-staging/`,沙盒挂在深层目录就永远够不到——硬杀(SIGKILL/OOM/断电)在
 *  allocate 与 cleanup 之间发生时会成为永久泄漏。install() 仍把最终文件 rename 进视频自己的
 *  目录(同一挂载/文件系统,原子 rename 单跳不破),所以沙盒挂在根一级不影响装机。调用方
 *  (如 v2/realignExecutor.ts)用 containingRoot(videoDir, mediaRoots) 求这个根;没有根匹配时
 *  安全退回视频目录本身(无媒体根概念的退化路径不受 gcOrphans 保护是预期行为)。
 *
 *  目录名 = `stagingDirName(jobId)`，**不是** jobId 本身——jobId 是身份串（`subtitle:tmdb:<id>`），
 *  底层的网盘驱动可能拒绝其中的字符。下一个读者不要以为 `join(root, jobId)` 是安全的。 */
export function allocate(jobId: string, mediaRootForVideo: string): string {
  const root = join(mediaRootForVideo, STAGING_DIRNAME)
  // 目录名 MUST 经 stagingDirName 映射，MUST NOT 用 jobId 逐字当目录名：jobId 是 `subtitle:tmdb:<id>`
  // 这样的身份串，而媒体根所在的文件系统/网盘驱动可能拒绝其中的字符（夸克拒绝冒号，且 rclone 的
  // VFS 写缓存会把 mkdir 失败伪装成本地成功）。详见 core/mediaContext.ts 的 stagingDirName。
  const dir = join(root, stagingDirName(jobId))
  mkdirSync(dir, { recursive: true })
  ensureStagingMarker(root)
  return dir
}

/** job 结束(无论成败)把沙盒**整棵收干净**——既删本 job 的 `<jobId>/`，也删只含标记文件的
 *  父目录 `<root>/.subtitle-staging/` 本身。best-effort:NAS/SMB 上 rm 可能因残留文件句柄
 *  失败,不让清理失败拖垮主流程结论(同 subtitleWriter 的孤儿 .tmp 清理先例)。
 *
 *  ── 2026-09-16 修订（design D3）────────────────────────────────────────────
 *  旧口径是"只删 `<jobId>` 这一层，绝不动同级 `.ignore`"，理由是该标记跨 job 共用。
 *  但实测的后果是：**每次任务都在用户的媒体目录里留下一个只含 `.ignore` 的隐藏文件夹**
 *  （生产两个根下累计 36 个，全部只含标记），而这正是用户看到并报上来的现象。
 *  新口径：**只在"父目录此刻只剩我们自己写的那个标记"时才连标记一起收掉**——判据复用
 *  `isStagingHusk()`。"还有别的 jobId 在场 → 不动标记"这条保护被完整保留（就是 isStagingHusk
 *  的"条目数必须为 1"那一条），因此"跟着任何一个 job 一起删掉共用标记、让 Jellyfin 在中间
 *  窗口扫到半成品 srt"这个风险没有被引入。
 *
 *  原子性：父目录的删除用 `rmdirSync`（非空即 ENOTEMPTY 失败），不用"readdir 判空 + rm -r"——
 *  后者有一个真实的竞争窗口：判空的瞬间另一个进程恰好 allocate 进来建了 `<jobId>`，
 *  `rm -r` 会把**正在被使用**的沙盒连根删掉。`rmdirSync` 的失败语义由内核提供，从根
 *  上消除那个窗口。残余窗口转移到"标记已删、`<jobId>` 刚建"这个更窄的组合上，且这一组合
 *  由下面的 `ensureStagingMarker(root)` 兜住——rmdir 失败即把标记补回，不留屏蔽空窗。
 *
 *  cleanup 是上面两处的**唯一**生产调用点（agent/findSubtitleWorker.ts:504 的 finally）。
 *
 *  ── 有意不做的选择：不加删除重试/回退策略 ────────────────────────────────
 *  ①′ 只留痕、不重试、不换姿势再删（不改 `rm -rf` 的语义、不改为先删内容再删目录）。冒号这条
 *  根因由 stagingDirName 从构造上消除后，剩余的删除失败原因只剩"挂载抖动/远端最终一致"，那是
 *  **启动时的 gcOrphans 本来就该兜**的场景；在这里加一层重试只会把一次等待挪到任务尾（拖慢
 *  finally），并制造第二份"什么时候算删干净"的判据。 */
export function cleanup(jobId: string, mediaRootForVideo: string): void {
  const root = join(mediaRootForVideo, STAGING_DIRNAME)
  // 目录名与 allocate 同法映射（两处 MUST 同一个函数，见 core/mediaContext.ts 的 stagingDirName）。
  const dirName = stagingDirName(jobId)
  // ① 删本 job 的沙盒：既有行为，逐字不变（除目录名映射）。
  try {
    rmSync(join(root, dirName), { recursive: true, force: true })
  } catch {
    // best-effort:清理失败不影响本次运行已产生的结论
  }
  // ①' 复核删除结果并留痕（2026-09-17 修订）。此前这里只有上面的空 catch：当沙盒目录**根本建不
  // 出来**时（实测：jobId 的冒号被夸克/alist 拒绝，rclone 的 VFS 写缓存把 mkdir 失败伪装成本地
  // 成功），删除会稳定失败并被无声吞掉——预防者在生产上连续停摆数十次任务而日志里一条痕迹都没有，
  // 残留只能等启动时的孤儿回收被动兜住。"尽力而为"指的是**不阻塞**，不是**不留痕**。
  try {
    if (existsSync(join(root, dirName))) {
      console.error(
        `staging sandbox not removed: ${join(root, dirName)} still exists after cleanup ` +
        `(jobId ${jobId} → dir name ${dirName}). Best-effort: the run's conclusion is unaffected; ` +
        `boot-time orphan GC will retry.`,
      )
    }
  } catch {
    // 复核本身失败（目录读不出来等）不该反噬主流程；上面的日志已经覆盖了"删不掉"这一主要情形
  }
  // ② 收尾父目录：只在"此刻只剩我们自己写的那一个标记文件"时才动手。
  try {
    if (!isStagingHusk(root)) return // 还有别的 jobId / 任何残留条目 → 原地保留（含标记）
    unlinkSync(join(root, '.ignore'))
    try {
      rmdirSync(root) // 原子判据：此刻若冒出新 <jobId> 会 ENOTEMPTY，绝不连根删掉在用沙盒
    } catch {
      ensureStagingMarker(root) // 父目录仍在用 → 标记必须立刻补回，不留屏蔽空窗
    }
  } catch {
    // best-effort：收尾失败只留一个空壳（= 本变更之前的行为），由 gcOrphans / doctor 兜底
  }
}

export interface InstallOptions {
  /** 重试退避表(毫秒),默认走生产梯度 INSTALL_RETRY_DELAYS_MS。目前没有生产调用方会传
   *  这个参数——只为测试开的口子,让"重试到耗尽"这类用例不用真等 ~1.6s 的退避总和。 */
  delaysMs?: number[]
}

/** install() 的成功结果:文件已落在 finalPath。 */
export interface InstallResult {
  path: string
}

/** install() 的冲突结果(H1,2026-07-18 数据安全审计):finalPath 已存在(用户手放字幕、或
 *  上次崩溃/硬杀残留),没有发生任何改名/覆盖——原文件原样保留。调用方(目前是
 *  agent/findSubtitleWorker.tools.ts 的 install_subtitle)据此把冲突转成给 agent 的 error 文案,
 *  让 agent 自行决定 finalize 收工还是换个 langTag 重试,而不是本函数替它做那个判断。 */
export interface InstallConflict {
  conflict: true
  path: string
}

/** 原子安装:沙盒里胜出的文件 rename 进媒体目录。文件名一律 NFC 归一化(群晖 SMB 的
 *  NFD/NFC 乱码坑)——finalPath 先 normalize('NFC') 再判存在性/改名。遇 EEXIST/EPERM/
 *  EBUSY(SMB oplock 抖动)退避重试;EXDEV(跨设备)兜底走拷贝+改名。不用 O_TMPFILE
 *  (网络盘不支持)。
 *
 *  H1(2026-07-18 数据安全审计,损失场景:用户手放字幕/上次崩溃残留与本次 finalPath 同名):
 *  renameSync 对一个已存在的目标文件零防线——实测会静默覆盖,无声吞掉原文件内容,不可恢复。
 *  每次尝试(包括 EXDEV 兜底分支的同盘改名)前都先 existsSync(normalizedFinal) 探测;命中即
 *  当场返回冲突结果,不改名、不重试、不覆盖——"宁停不猜"同 v2/subtitlePropagation.ts 的
 *  既有防线(那条防副本旁用户手放的 sidecar 被主文件字幕覆盖,这里防同一类损失落到
 *  finalPath 本身)。 */
export async function install(
  stagedPath: string,
  finalPath: string,
  opts?: InstallOptions,
): Promise<InstallResult | InstallConflict> {
  const delaysMs = opts?.delaysMs ?? INSTALL_RETRY_DELAYS_MS
  const normalizedFinal = finalPath.normalize('NFC')
  let lastError: unknown
  for (let attempt = 0; attempt <= delaysMs.length; attempt++) {
    if (existsSync(normalizedFinal)) {
      return { conflict: true, path: normalizedFinal }
    }
    try {
      // H1 承诺"绝不覆盖"——存在即返回 conflict。注意:existsSync→renameSync 之间存在微秒级
      // TOCTOU 窗口,窗口内出现的同名文件会被 rename 静默覆盖(POSIX rename 语义)。实际风险
      // 极低(agent 单线程顺序执行,窗口内恰好有人手放同名字幕的概率接近零),且冲突路径已
      // 有 existsSync 前置短路兜底。未来如需彻底消除窗口,可改用 linkSync(存在即 EEXIST
      // 失败)+unlinkSync,但会改变函数签名(返回错误而非 InstallConflict),需调用方适配。
      renameSync(stagedPath, normalizedFinal)
      fsyncDirBestEffort(dirname(normalizedFinal))
      return { path: normalizedFinal }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EXDEV') {
        if (existsSync(normalizedFinal)) {
          return { conflict: true, path: normalizedFinal }
        }
        copyThenRenameSameDir(stagedPath, normalizedFinal)
        fsyncDirBestEffort(dirname(normalizedFinal))
        return { path: normalizedFinal }
      }
      lastError = e
      if (code && RETRYABLE_CODES.has(code) && attempt < delaysMs.length) {
        await sleep(delaysMs[attempt])
        continue
      }
      throw e
    }
  }
  throw lastError
}

/** 启动即回收(镜像 jobsRepo.reapAllActive 的"单实例前提,无条件回收"):删除每个
 *  mediaRoot 下所有不在 activeJobIds 里的 .subtitle-staging/<jobId> 条目——目录、
 *  文件、符号链接一视同仁,统统当垃圾清。daemon 启动时旧进程必已死,任何残留都是崩溃/
 *  被杀留下的试错垃圾——不看年龄,直接清。返回清理的条目数。
 *
 *  每个根下 NON-recursive 扫描:只看 `<root>/.subtitle-staging/` 的直接子条目。这与
 *  allocate 的契约配套——沙盒必须由 allocate 挂在媒体根一级(见 allocate 文档),埋在深层
 *  目录里的沙盒这里扫不到。保持非递归是有意的(最小正确改动):allocate 侧钉在根一级后,
 *  沙盒本就都在直接子层,无需为了兜底更深层而付出全根递归遍历的代价。
 *
 *  用 lstatSync 而非 statSync:后者会跟随符号链接——断链目标不存在时 statSync 直接抛
 *  ENOENT,命中下面的 catch 被当成"清理失败"跳过,断链就永久堆在这里出不去。lstatSync
 *  只看链接本身,断链也能正常 stat 到,进而被 rmSync 删掉。同理,rmSync 对符号链接(哪怕
 *  指向目录)只解链接本身,不会顺着链接递归删目标——指向的真实目录不受影响。 */
/** 递归取目录内最新 mtime（含子目录）——translate 工作台的持续写入全部在子目录
 *  （work/bilingual.jsonl 等），只看顶层目录 mtime 会在启动几分钟后永久陈旧（R7-1 实锤）。
 *  R8-1 修复：种子值带目录自身 mtime——刚 allocate、只建了空子目录、还没写任何文件的工作台，
 *  latest=0 会被误删（无论多新鲜）。入口 seed lstatSync(dir).mtimeMs，递归时目录项也取其自身 mtime。 */
function latestMtimeMs(dir: string): number {
  let latest = 0
  try {
    latest = lstatSync(dir).mtimeMs // R8-1：目录自身 mtime 也计入（空工作台不被误删）
  } catch { /* 目录不存在 */ }
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      try {
        if (entry.isDirectory()) {
          latest = Math.max(latest, latestMtimeMs(full))
        } else {
          latest = Math.max(latest, lstatSync(full).mtimeMs)
        }
      } catch { /* 单个条目失败不影响其它 */ }
    }
  } catch { /* 目录列不出来 */ }
  return latest
}

/** 遍历每个配置根，收集**任意深度**的空壳沙盒路径（判据见 isStagingHusk）。
 *
 *  ── 为什么需要它（而不是只靠根一级清扫）──────────────────────────────
 *  根一级清扫只看 `<root>/.subtitle-staging/*`。接线修好之前 allocate 拿到的
 *  mediaRootForVideo 是**视频所在的深层目录**，留下的空壳因此散落在第 1–4 层
 *  （2026-09-16 生产实测：两个根下 36 个，深度分布 1/26/6/3）。根一级扫描对它们完全失明，
 *  这就是"存量清不掉"的原因。
 *
 *  ── 遍历剪枝（正确性 + 成本）────────────────────────────────────────
 *  1) 不进入任何 `isJunkDirName` 判为垃圾的目录（`.` / `@` / `#` 前缀）。沙盒自己就是点前缀，
 *     所以**永不递归进沙盒内部**——不把沙盒里的候选字幕当成媒体树来遍历。
 *  2) 用 `readdirSync(withFileTypes)` 的 Dirent 判类型（lstat 口径）：符号链接的
 *     `isDirectory()` 为 false，于是**永不穿过符号链接**，不存在"经链接跑到媒体根之外"
 *     的删除路径（与 gcOrphans 既有条目用 lstatSync 同一取舍）。
 *  3) 单个目录读不出来（权限/挂载抖动/坏点）只记日志继续——不让一棵坏树中断整轮回收
 *     （同 daemon/selfScan.ts 的既有行为）。
 *
 *  只读：本函数**不删任何东西**。删除由 gcOrphans 按它既有的两条保留条件执行，
 *  doctor 只报告不删（design D5）。
 *
 *  返回去重后的绝对路径（配置根嵌套时同一棵树不会被走两遍，也不会重复上报同一个空壳）。 */
export function findStagingHusks(roots: string[]): string[] {
  const found = new Set<string>()
  const visited = new Set<string>()
  for (const root of roots) {
    walkForHusks(resolve(root), found, visited)
  }
  return [...found]
}

function walkForHusks(dir: string, found: Set<string>, visited: Set<string>): void {
  if (visited.has(dir)) return
  visited.add(dir)
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    console.error(`staging-husk scan: skip unreadable path ${dir}: ${e instanceof Error ? e.message : String(e)}`)
    return
  }
  for (const entry of entries) {
    // Dirent 口径（lstat）：符号链接的 isDirectory() 为 false，因此天然不跟随链接。
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (entry.name === STAGING_DIRNAME || entry.name === TRANSLATE_STAGING_DIRNAME) {
      // 🔴 顺序要紧：先认沙盒目录名、再判垃圾前缀。两个名字都是点前缀，被下面的
      // isJunkDirName 剪掉就永远找不到它们了。
      if (isStagingHusk(full)) found.add(full)
      continue // 无论是不是空壳都不下钻——沙盒内部不是媒体树
    }
    if (isJunkDirName(entry.name)) continue
    walkForHusks(full, found, visited)
  }
}

/** activeJobIds 收成 `ReadonlySet`（2026-08-08 第 2 步 / C34）：本函数只对它调 `.has()`，
 *  从不写。收窄成只读是为了让调用方能**直接**把 daemon 进程内那个活的 in-flight 集合传进来
 *  （见 v2/daemonV2.ts 的 inFlightStagingJobIds），而不用为了满足类型多拷一份——拷一份的写法
 *  在这里正好是危险的：GC 的判据是"这个工作台此刻是否在被使用"，任何一层拷贝都可能在 await
 *  边界上变成陈旧快照，把跑了两小时的翻译工作台当孤儿 rm 掉。既有调用方传 `Set` 不受影响。
 *  （2026-09-17：下面确实把成员映射成目录名形态放进了一个新 Set，但那不是上述意义的"快照"——
 *  本函数全程同步、无 await，映射是入参的纯函数，不存在新旧两份判据并存的窗口。）
 *
 *  ── 两段式（2026-09-16 修订，design D4/D7）──────────────────────────────
 *  ① **任意深度的空壳**：只剩一个标记文件的沙盒根（findStagingHusks 的产物）。
 *  ② **根一级条目**：`<root>/.subtitle-staging/*` 与 `<root>/.subtitle-translate/*`
 *     的直接子条目，按 mtime/活性窗口回收（既有行为，逐字保留）。
 *
 *  两段都保留，因为**删除面不同**：②会删 `<jobId>` 这类**非空**孤儿条目，①只删"只剩标记文件"
 *  的目录。合并成一次全递归遍历要么让①获得删非空目录的权限（扩大删除面），要么让非空孤儿
 *  失去唯一的回收者。
 *
 *  顺序：①在②之前。理由只有一条——让空壳判据看到的是**本轮尚未被我方副作用改动过**的 mtime。
 *  "这个沙盒是新建的吗"问的是沙盒自身的新建时刻，不该被同一轮 GC 顺手改过的时间戳污染。
 *  实测（rmSync 一个子条目后读父目录 mtime）证明删除子条目会把父目录 mtime 刷成"现在"，
 *  所以"②删掉陈旧 <jobId> 后①顺手收掉父目录"这个直觉是**错的**——含陈旧 <jobId> 的沙盒在
 *  两种顺序下都只能等下一个 boot。既然顺序对可观测结果没有影响，它**不是契约**：规格不写、
 *  测试也不锁（生产实证的 36 个空壳全部只含 .ignore，两种顺序都在本轮收干净）。 */
export function gcOrphans(mediaRoots: string[], activeJobIds: ReadonlySet<string>, bootTimeMs?: number): number {
  let cleaned = 0
  // P2.4(复审 Important-1):translate 工作台 `.subtitle-translate` 与 find 的 `.subtitle-staging`
  // 同法清扫——daemon translate 每 job 落 `<root>/.subtitle-translate/<jobId>/`,无清扫则无界堆积。
  // R6-9 修复：跳过 mtime 新于本次进程启动时间的条目——daemon + 手动 CLI 并发场景下，
  // watch 重启时若一个手动 translate CLI（一场可跑数小时）正在跑，boot GC 会把它的工作台
  // 整个 rm 掉（运行中的任务工作台消失、LLM 配额白烧）。
  // R7-1 修复：用 age-based 活性判断（最近 10 分钟内有写入则跳过）——此前只看顶层目录 mtime，
  // CLI 工作台持续写入在子目录（work/bilingual.jsonl），顶层 mtime 在启动几分钟后永久陈旧，
  // 自述场景（3 小时前创建的 CLI 工作台）照样被删。递归取最新 mtime + 10 分钟活性窗口。
  const bootTime = bootTimeMs ?? Date.now()
  const ACTIVE_WINDOW_MS = 10 * 60 * 1000 // 10 分钟

  /** 在飞集合的**目录名形态**（2026-09-17）：调用方登记的是原始 jobId（`subtitle:tmdb:<id>`，
   *  见 daemonV2 的 inFlightStagingJobIds），而下面 ② 段拿到的是磁盘条目名——已被 allocate 经
   *  stagingDirName 映射过（`subtitle-tmdb-<id>`）。拿原始串直接 `.has(磁盘名)` 恒为 false，
   *  后果不是"少删一个目录"而是**把正在被使用的沙盒当孤儿删掉**（本函数唯一的破坏性错误方向）。
   *  两个约定都要能用：stagingDirName 幂等，故这里对成员统一映射一次即可同时容纳
   *  "传原始 jobId"与"传已映射名字"两种调用方（见 core/mediaContext.ts 的注释）。 */
  const activeDirNames = new Set<string>()
  for (const id of activeJobIds) activeDirNames.add(stagingDirName(id))

  /** 两条保留条件（R6-9 / R7-1 / R8-1），根一级条目与任意深度空壳**共用同一份实现**——
   *  在两处各写一遍就是"留两份漂移实现"的又一次翻版（见 subtitleJobId 的注释：GC 的保护
   *  会因两份漂移而静默失效），而这条判据失灵的代价是删掉一个正在被写入的工作台。
   *  返回 true = 保留（不删）。lstatSync 的存在性探测不跟随链接，断链在这里也不会抛
   *  （调用方仍把它包在 try 里，保持既有的"单条目失败不中断"语义）。 */
  const shouldKeep = (full: string): boolean => {
    const stat = lstatSync(full) // 存在性探测,不跟随链接;断链在这里也不会抛
    // R8-1：双条件——① mtime 新于 bootTime（新建未写的工作台，bootTime=0 时不启用）
    // ② 最近 10 分钟内有写入（活跃的工作台）。两个条件任一满足都跳过（不删）。
    if (bootTime > 0 && stat.mtimeMs > bootTime) return true // 新建未写的工作台（R6-9 语义）
    if (stat.isDirectory() && Date.now() - latestMtimeMs(full) < ACTIVE_WINDOW_MS) return true // 活跃（R7-1 语义）
    return false
  }

  // ① 任意深度的空壳（只剩标记文件的沙盒根）。**不含 <jobId> 的沙盒一律不碰**——
  //    深层只收空壳，扩大删除面要另案论证（design Non-Goals）。
  for (const husk of findStagingHusks(mediaRoots)) {
    try {
      if (shouldKeep(husk)) continue
      rmSync(husk, { recursive: true, force: true })
      cleaned++
    } catch {
      // best-effort:单个空壳清理失败不影响其它空壳/其它根
    }
  }

  // ② 根一级条目清扫：既有行为，逐字保留（含"从不删 .subtitle-staging 这一层自身"——
  //    这一层由 ① 在确认它只剩标记文件后负责收掉）。
  for (const root of mediaRoots) {
    for (const dirname of [STAGING_DIRNAME, TRANSLATE_STAGING_DIRNAME]) {
      const stagingRoot = join(root, dirname)
      if (!existsSync(stagingRoot)) continue
      let entries: string[]
      try {
        entries = readdirSync(stagingRoot)
      } catch {
        continue // best-effort:目录列不出来(权限/挂载抖动)跳过这一根,下次启动再试
      }
      for (const name of entries) {
        // name 是磁盘形态（已映射）；activeDirNames 是同一映射下的在飞集合（见上方注释）。
        if (name === '.ignore' || activeDirNames.has(name)) continue
        const full = join(stagingRoot, name)
        try {
          if (shouldKeep(full)) continue
          rmSync(full, { recursive: true, force: true })
          cleaned++
        } catch {
          // best-effort:单个条目清理失败不影响其它条目/其它根
        }
      }
    }
  }
  return cleaned
}

/** 落点探针的目录名前缀。命名沿用 isDirWritable 的"隐藏名 + 本进程 pid + 自增序号"约定，但
 *  **刻意不复用** `.subtitle-scout-writetest-`：那个前缀属于"根一级 0 字节**文件**探针"，由
 *  sweepWriteProbes 逐个 unlink；本探针是 `.subtitle-staging/` 内部的**目录**，清扫者是
 *  gcOrphans ②（那一层正是它的扫描面）——混用前缀会让 sweepWriteProbes 去 unlink 一个目录。 */
export const PLACEMENT_PROBE_PREFIX = '.subtitle-scout-placement-'

let placementProbeCounter = 0

/** doctor 的"沙盒落点可建"探针（design D5）：在 root 上真实建一个
 *  `<root>/.subtitle-staging/.subtitle-scout-placement-<pid>-<n>/` 再删掉；**建不出来就抛**
 *  （由 doctor.ts 的 checkStagingPlacement 翻译成报告行——它不该关心 fs，本模块不该关心文案）。
 *
 *  ── 这次探查能发现什么、**不能**发现什么（2026-09-17 实测修正，别高估它）────────
 *  能发现：挂载已死/只读（EROFS）、权限不足（EACCES/EPERM）、驱动**同步**拒绝该名字（如 alist 的
 *  `{"code":500,"message":" bad file name :[...] "}`）、父路径缺失（ENOENT）。
 *  **不能发现**：rclone `--vfs-cache-mode writes` 那一类"本地写缓存吞掉失败、只在回写时才爆 405"
 *  ——本函数跑在 FUSE 视图里，`mkdirSync` 会返回成功。这正是本次缺陷（含冒号的沙盒目录）的形态，
 *  故本探针**不是**那类缺陷的回归护栏；那类缺陷由单元测试（stagingSandbox.test.ts 的红线）与
 *  `cleanup` 的留痕日志负责。把这条写在这里，是为了防止下一个读者看到"doctor ✓"就以为
 *  "盘上一定建得出冒号目录"。
 *
 *  ── 清理口径 ────────────────────────────────────────────────────────
 *  best-effort（同 isDirWritable 的 2026-07-29 事故口径：判据只看"建得出"，删除失败不改结论）。
 *  探针目录建不出来时 mkdirSync 会先抛，此时不留任何东西。清理失败留下的空目录由 gcOrphans ②
 *  兜底收（在 `.subtitle-staging/` 一层、名字不匹配在飞集合、也不会被 gcOrphans ① 当空壳——它
 *  不是沙盒根）。**父目录是本探针顺手建的时候（此前不存在）才回删它**：否则 doctor 会留下一个
 *  0 条目的 `.subtitle-staging/`，而它既不是空壳（isStagingHusk 要求恰好一个 `.ignore`）也不在
 *  任何回收面的判据里，会永久留着。 */
export function probeStagingPlacement(root: string): void {
  const stagingRoot = join(root, STAGING_DIRNAME)
  // existsSync 在 FUSE/网盘上也只有本地视图可信——但这里问的是"父目录本来在不在"，
  // 判错的后果只是"该不该回删父目录"，不影响探针结论。
  const stagingRootExisted = existsSync(stagingRoot)
  // 🔴 两级都**不使用** recursive：媒体根不存在（未挂载/挂错）时必须抛 ENOENT，而不是顺着
  // 递归把挂载点当普通目录建出来——那会在宿主上凭空造出一个同名的本地空目录，把"盘没挂上"
  // 这件最该被发现的事伪装成 ✓（本仓已有 2026-07-29 云盘误判的先例，代价是 175 个残留）。
  if (!stagingRootExisted) mkdirSync(stagingRoot)
  const probe = join(stagingRoot, `${PLACEMENT_PROBE_PREFIX}${process.pid}-${placementProbeCounter++}`)
  mkdirSync(probe)
  try {
    rmdirSync(probe)
    if (!stagingRootExisted) rmdirSync(stagingRoot) // 非空即失败（别人刚建了沙盒）→ 忽略，正确
  } catch {
    console.error(
      `placement probe left behind: ${probe}（删除失败）。best-effort：结论不受影响，` +
      `该空目录由下次启动的 gcOrphans 回收。`,
    )
  }
}
