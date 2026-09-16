import { resolve, sep } from 'node:path'
import { writeFileSync, unlinkSync } from 'node:fs'

export interface PathMapping { from: string; to: string }

export function parsePathMappings(raw: string | undefined): PathMapping[] {
  if (!raw) return []
  return raw.split(',').filter(Boolean).map(pair => {
    const [from, to] = pair.split('=')
    if (!from || !to) throw new Error(`invalid MEDIA_PATH_MAPPINGS pair: ${pair}`)
    return { from, to }
  })
}

export function mapPath(path: string, mappings: PathMapping[]): string {
  // 最长前缀优先，避免 /media 抢了 /media/movies 的活
  const hit = [...mappings].sort((a, b) => b.from.length - a.from.length)
    .find(m => path.startsWith(m.from))
  return hit ? hit.to + path.slice(hit.from.length) : path
}

/** path 是否位于任一 root 之下（或恰为 root）。roots 为空 → 视为不限制，返回 true */
export function isUnderRoots(path: string, roots: string[]): boolean {
  if (roots.length === 0) return true
  const p = resolve(path)
  return roots.some(r => {
    const root = resolve(r)
    return p === root || p.startsWith(root + sep)
  })
}

/** roots 里包含 path 的那一个根（最长前缀命中，避免嵌套配置时 /media 抢了 /media/tv 的活）。
 *  一个都不包含（越出所有根，或 roots 为空）返回 null——调用方自行决定安全兜底，这里不替
 *  调用方猜。供 stagingSandbox.allocate 的调用方判定"哪个媒体根装下了这段视频"：沙盒必须
 *  挂在根一级而不是视频所在的深层目录（见 files/stagingSandbox.ts allocate() 的注释——
 *  gcOrphans 按根非递归扫描，沙盒不在根一级就永远不会被启动时的孤儿回收扫到）。 */
export function containingRoot(path: string, roots: string[]): string | null {
  const p = resolve(path)
  const hits = roots
    .map(r => resolve(r))
    .filter(root => p === root || p.startsWith(root + sep))
  if (hits.length === 0) return null
  return hits.sort((a, b) => b.length - a.length)[0]
}

let writeProbeCounter = 0

/**
 * 目录是否可写:在 dir 下真实试写一个隐藏临时文件再删除。不用 fs.access(W_OK)——网络挂载
 * (WebDAV/rclone/CIFS)上 W_OK 会撒谎,且容器内 root 会绕过权限位;真实试写走 sidecar 将来同
 * 一条写路径,是唯一可信信号。
 *
 * 🔴 2026-07-29 生产事故修复（云盘误判 + 175 个残留垃圾文件）：旧实现把「写成功」与「删成功」
 * 绑成一个成功条件——`writeFileSync` 后紧跟 `unlinkSync`，只有两个都成功才 return true。
 * 在 rclone WebDAV 云盘上，写入是最终一致的：writeFileSync 立刻返回，紧接着的 unlinkSync
 * 可能撞上「文件还没在远端落地」而抛错，于是：
 *   ① 函数返回 false → 上层 assertDirSafe 报「Media dir not writable」，云盘目标全线拒装
 *     （昨夜 job 34 的真实错误就是它，而手工 touch 测试证明云盘明明可写）；
 *   ② catch 里的补救 unlink 同样失败 → 每次探测留一个 0 字节垃圾文件。实测全库残留 175 个
 *     （铁拳教育那个目录 50 个 —— 同一 job 每次重试各留一个）。
 *
 * 修正后的语义：**可写性只由「写」决定，删除是清理而非判据**。删不掉不影响结论，只记一次
 * 告警（探针文件是隐藏文件、0 字节，且下面的 sweepWriteProbes 会在后续巡检里兜底收走）。
 *
 * @param unlink 删除实现的可测接缝（ESM 下无法 spyOn 模块导出）。生产省略=真实 fs.unlinkSync。
 */
export function isDirWritable(dir: string, unlink: (p: string) => void = unlinkSync): boolean {
  const probe = resolve(dir, `.subtitle-scout-writetest-${process.pid}-${writeProbeCounter++}`)
  try {
    writeFileSync(probe, '')
  } catch {
    return false // 写不进去 = 真的不可写，无残留可清
  }
  // 写成功即判定可写；删除是尽力而为的清理，失败不改变结论（云盘最终一致性）。
  try {
    unlink(probe)
  } catch {
    // 云盘延迟导致的删除失败：留一个 0 字节隐藏文件，由 sweepWriteProbes 兜底清理。
    console.error(
      `[media-context] write probe left behind at ${probe} (unlink failed — likely eventual-consistency ` +
      `on a network mount). Directory IS writable; sweepWriteProbes will clean it up later.`,
    )
  }
  return true
}

/**
 * 清理残留的写探针文件（上面 unlink 失败时留下的 0 字节隐藏文件）。
 * 幂等、尽力而为：任何单个文件删不掉都只记日志，不抛错、不中断调用方。
 * 返回真正删掉的数量，供调用方记账。
 *
 * @param unlink 同 isDirWritable 的可测接缝。
 */
export function sweepWriteProbes(
  dir: string,
  readdir: (d: string) => string[],
  unlink: (p: string) => void = unlinkSync,
): number {
  let removed = 0
  let names: string[]
  try {
    names = readdir(dir)
  } catch {
    return 0 // 目录读不了（死挂载/权限）——不是本函数该处理的问题
  }
  for (const name of names) {
    if (!name.startsWith('.subtitle-scout-writetest-')) continue
    try {
      unlink(resolve(dir, name))
      removed++
    } catch {
      // 删不掉就留着——0 字节隐藏文件无害，下一轮再试
    }
  }
  return removed
}

/** 目录名是否应当被"媒体树遍历"剪枝（不进去）：点前缀 = 隐藏目录（含本仓自己的
 *  `.subtitle-staging` / `.subtitle-translate` / `.realign-build`）；`@` 前缀 = 群晖
 *  `@eaDir` 这类 NAS 厂商的缩略图/元数据目录；`#` 前缀 = 同类回收站/临时目录。
 *
 *  **全仓唯一一份定义**（2026-09-16 合并）：此前只有 `daemon/selfScan.ts` 的私有
 *  `isJunkDir`，它的注释自己写着"本仓没有任何地方导出等价的判据可以复用"。空壳遍历
 *  （`files/stagingSandbox.ts` 的 `findStagingHusks`）成为第二个消费者后，两份逐字相同的
 *  判据就是下一次静默分叉的种子，故上提到这里。`selfScan.ts` 与 `stagingSandbox.ts` 都导入它。
 *
 *  放这一层的理由：`core/mediaContext.ts` 是最底层的路径/文件系统约定模块，`files/` 与
 *  `v2/` 都已从它导入；放这里不产生任何新的层间方向。若改成从 `daemon/selfScan.ts` 导出，
 *  就凭空造出 `files/ → daemon/` 这条当前不存在的边。
 *
 *  与 `isVideoFile` 无关：本函数只回答"要不要进去"，不回答"里面有没有视频"。 */
export function isJunkDirName(name: string): boolean {
  return name.startsWith('.') || name.startsWith('@') || name.startsWith('#')
}

/** 字幕试错沙盒的目录名（`<媒体根>/.subtitle-staging/<jobId>/`）。见 files/stagingSandbox.ts。 */
export const STAGING_DIRNAME = '.subtitle-staging'

/** 翻译工作台的目录名（`<媒体根>/.subtitle-translate/<jobId>/`）。单一真相点：
 *  `translate/workspace/paths.ts` 从这里再导出（它自身的 workspacePaths/ensureWorkspaceLayout
 *  内部用法不变），`files/stagingSandbox.ts` 的 gcOrphans / findStagingHusks 也从这里导入。
 *  此前这一串字面量在两处各写一份——任何一侧改了格式，另一侧的回收会**静默**停止工作
 *  （工作台无界堆积，且不会有任何测试变红）。 */
export const TRANSLATE_STAGING_DIRNAME = '.subtitle-translate'
