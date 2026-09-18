import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, symlinkSync, lstatSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocate, cleanup, install, gcOrphans, findStagingHusks, isStagingHusk, probeStagingPlacement, PLACEMENT_PROBE_PREFIX, cleanupNumberedDuplicates, retryUntilDirectory } from './stagingSandbox.js'

// Finding 4: production code has no call sites for install() yet, so defaulting this to
// a short ladder everywhere retries are exercised keeps this suite fast without touching
// the production default (which stays the real backoff ladder — see stagingSandbox.ts).
const fastDelays = { delaysMs: [1, 1, 1, 1] }

const mediaRoot = () => mkdtempSync(join(tmpdir(), 'stage-root-'))

// Deviation from the plan: the plan's retry/EXDEV tests used
// `vi.spyOn(fsMod, 'renameSync').mockImplementation(...)` on the `node:fs` namespace
// object. Under Node's native ESM loader (which this repo's vitest config uses),
// built-in module namespace objects are frozen/non-configurable, so vi.spyOn throws
// "Cannot redefine property: renameSync" instead of producing the RED failure the
// plan describes. `src/files/subtitleWriter.test.ts` already solves this exact
// problem for the same module with `vi.mock('node:fs', async (importOriginal) =>
// ...)` plus a module-level mutable override — that is the established pattern in
// this codebase, so it is reused here instead of vi.spyOn.
// Note: the factory below must not synchronously write into a module-level `let`
// (e.g. `realRenameSync = actual.renameSync`) — vi.mock's factory runs at import
// resolution time, which precedes this file's own top-level `let` initializers
// regardless of source order, so any such write hits the temporal dead zone. Only
// *reading* a module-level `let` from inside a nested closure (deferred to call
// time, after the file has finished initializing) is safe — hence passing
// `actual.renameSync` through as a parameter to the override instead.
let renameSyncOverride:
  | ((real: typeof import('node:fs').renameSync, from: string, to: string) => void)
  | null = null

// Addendum A: install() fsyncs the parent directory fd after a successful rename (best-effort).
// Same vi.mock pattern as renameSyncOverride above — openSync/fsyncSync/closeSync are individually
// overridable so tests can observe the calls and simulate fsync failing without touching the real
// rename/write behavior exercised by the rest of this suite.
let openSyncOverride: ((real: typeof import('node:fs').openSync, path: string, flags: string) => number) | null = null
let fsyncSyncOverride: ((real: typeof import('node:fs').fsyncSync, fd: number) => void) | null = null
let closeSyncOverride: ((real: typeof import('node:fs').closeSync, fd: number) => void) | null = null

// 2026-09-16 cleanup 父目录收尾 / 并发窗口的可测接缝（同上：ESM 命名空间对象不可重定义）。
let rmSyncOverride: ((real: typeof import('node:fs').rmSync, path: string, opts: unknown) => void) | null = null
let unlinkSyncOverride: ((real: typeof import('node:fs').unlinkSync, path: string) => void) | null = null
// 2026-09-17 落点探针（probeStagingPlacement 的收尾用 rmdirSync）的可测接缝。
let rmdirSyncOverride: ((real: typeof import('node:fs').rmdirSync, path: string) => void) | null = null

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      if (renameSyncOverride) {
        return renameSyncOverride(actual.renameSync, args[0] as string, args[1] as string)
      }
      return actual.renameSync(...args)
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      if (openSyncOverride) {
        return openSyncOverride(actual.openSync, args[0] as string, args[1] as string)
      }
      return actual.openSync(...args)
    },
    fsyncSync: (...args: Parameters<typeof actual.fsyncSync>) => {
      if (fsyncSyncOverride) {
        return fsyncSyncOverride(actual.fsyncSync, args[0])
      }
      return actual.fsyncSync(...args)
    },
    closeSync: (...args: Parameters<typeof actual.closeSync>) => {
      if (closeSyncOverride) {
        return closeSyncOverride(actual.closeSync, args[0])
      }
      return actual.closeSync(...args)
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (rmSyncOverride) return rmSyncOverride(actual.rmSync, args[0] as string, args[1])
      return actual.rmSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      if (unlinkSyncOverride) return unlinkSyncOverride(actual.unlinkSync, args[0] as string)
      return actual.unlinkSync(...args)
    },
    rmdirSync: (...args: Parameters<typeof actual.rmdirSync>) => {
      if (rmdirSyncOverride) return rmdirSyncOverride(actual.rmdirSync, args[0] as string)
      return actual.rmdirSync(...args)
    },
  }
})

describe('allocate', () => {
  it('creates <mediaRoot>/.subtitle-staging/<jobId>/ and returns its path', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    expect(dir).toBe(join(root, '.subtitle-staging', 'job-1'))
    expect(existsSync(dir)).toBe(true)
  })

  it('drops a .ignore marker file next to the per-job dirs (Jellyfin should skip this tree)', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    expect(existsSync(ignorePath)).toBe(true)
    expect(readFileSync(ignorePath, 'utf8')).toContain('subtitle-scout staging')
  })

  it('is idempotent: allocating the same jobId twice does not throw and keeps existing files', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'marker.txt'), 'x')
    const dir2 = allocate('job-1', root)
    expect(dir2).toBe(dir)
    expect(existsSync(join(dir, 'marker.txt'))).toBe(true)
  })

  it('does not overwrite an existing .ignore file on a second allocate', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    writeFileSync(ignorePath, 'custom content')
    allocate('job-2', root)
    expect(readFileSync(ignorePath, 'utf8')).toBe('custom content')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 沙盒目录名映射（2026-09-17）。生产形态：jobId = `subtitle:tmdb:<id>`，媒体根在夸克网盘上
// （rclone mount → WebDAV → alist Quark 驱动），驱动拒绝**目录名**里的 `:`：
//     POST /api/fs/mkdir → {"code":500,"message":" bad file name :[...] "}
//     MKCOL（终态）→ 405 Method Not Allowed
// 而同一个位置的**文件名**允许 `:`（`.ignore` 上传成功即证）。更坏的是 rclone 的
// `--vfs-cache-mode writes` 把 mkdir 失败伪装成本地成功，于是 cleanup 的 rm 必然失败、被
// `catch {}` 吞掉——预防者连续停摆数十次任务而无一条日志。修法：目录名过 stagingDirName。
// ─────────────────────────────────────────────────────────────────────────────
describe('allocate/cleanup — jobId 含冒号（生产形态）', () => {
  afterEach(() => {
    rmSyncOverride = null
    unlinkSyncOverride = null
    vi.restoreAllMocks()
  })

  it('🔴 allocate 建出的目录名不含冒号，落点是映射后的名字', () => {
    const root = mediaRoot()
    const dir = allocate('subtitle:tmdb:999999', root)
    expect(dir).toBe(join(root, '.subtitle-staging', 'subtitle-tmdb-999999'))
    expect(dir).not.toContain(':')
    expect(existsSync(join(root, '.subtitle-staging', 'subtitle-tmdb-999999'))).toBe(true)
    // 逐字当目录名的那份名字**不该**存在（旧代码下的形态）
    expect(existsSync(join(root, '.subtitle-staging', 'subtitle:tmdb:999999'))).toBe(false)
  })

  it('🔴 cleanup 对冒号 jobId 真的删得掉：视频目录下净残留为 0', () => {
    const root = mediaRoot()
    const dir = allocate('subtitle:tmdb:999999', root)
    writeFileSync(join(dir, 'candidate.zh-Hans.srt'), 'junk')
    // 忠实模拟生产的不对称：**建**（mkdir）在 rclone VFS 下会假成功，而**删**（rm）真的打到远端
    // 并对含冒号的路径失败（实测日志 `Dir.Remove failed ... directory not found` / 回写 405）。
    // 于是旧代码在这里必红：rmSync 抛错 → 被 catch 吞掉 → 沙盒目录原样留下。
    rmSyncOverride = (real, p, opts) => {
      if (typeof p === 'string' && p.includes(':')) {
        throw Object.assign(new Error('405 Method Not Allowed'), { code: 'EPERM' })
      }
      return (real as unknown as (path: string, o?: unknown) => void)(p, opts)
    }
    cleanup('subtitle:tmdb:999999', root)
    rmSyncOverride = null

    expect(existsSync(dir)).toBe(false)
    // 父目录留着（第 27 轮：父目录永驻），但里面**不许**再有本任务的目录名形态
    expect(existsSync(join(root, '.subtitle-staging'))).toBe(true)
    expect(readdirSync(join(root, '.subtitle-staging')).filter(n => n !== '.ignore')).toEqual([])
    expect(readdirSync(root).filter(n => n.startsWith('.'))).toEqual(['.subtitle-staging'])
  })

  it('🔴 #15：第一次删不掉、等一会儿删得掉 → 不抛、**不留痕**（秒级重试真的在跑）', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    let calls = 0
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rmSyncOverride = (real, p, opts) => {
      // 第一次模拟后端"子条目还没处理完"（最终一致后端的常态签名：directory not empty）
      if (p === dir && calls++ === 0) {
        throw Object.assign(new Error('directory not empty'), { code: 'ENOTEMPTY' })
      }
      return (real as unknown as (path: string, o?: unknown) => void)(p, opts)
    }
    cleanup('job-1', root)
    rmSyncOverride = null
    expect(calls).toBe(2)                 // 真的重试了一次
    expect(existsSync(dir)).toBe(false)   // 第二次成功
    // 既然最终删干净了，就**不该**报残留（与"删不掉必须留痕"那条互补）
    expect(spy.mock.calls.flat().join(' ')).not.toContain('not removed')
    spy.mockRestore()
  })

  it('失败必须留痕：删不掉时打出含原始 jobId 与映射后目录名的 ERROR，且不抛错', () => {
    const root = mediaRoot()
    const dir = allocate('subtitle:tmdb:999999', root)
    writeFileSync(join(dir, 'candidate.srt'), 'junk')
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rmSyncOverride = (real, p) => {
      if (p === dir) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(p)
    }

    expect(() => cleanup('subtitle:tmdb:999999', root)).not.toThrow()
    rmSyncOverride = null

    // 映射关系必须从日志里就能看懂（否则排障要回头读代码）
    const logged = spy.mock.calls.map(c => c.join(' ')).join('\n')
    expect(logged).toContain(dir)
    expect(logged).toContain('subtitle:tmdb:999999')
    expect(logged).toContain('subtitle-tmdb-999999')
  })

  it('反向断言保留：同根还有另一个冒号 jobId 时，父目录与共用标记都原样保留', () => {
    const root = mediaRoot()
    allocate('subtitle:tmdb:1', root)
    const dir2 = allocate('subtitle:tmdb:2', root)
    cleanup('subtitle:tmdb:1', root)
    expect(existsSync(join(root, '.subtitle-staging', 'subtitle-tmdb-1'))).toBe(false)
    expect(existsSync(dir2)).toBe(true)
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
  })
})

describe('cleanup', () => {
  it('removes the whole per-job staging directory', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'leftover.srt'), 'junk')
    cleanup('job-1', root)
    expect(existsSync(dir)).toBe(false)
  })

  it('is a no-op (does not throw) when the directory was never allocated', () => {
    const root = mediaRoot()
    expect(() => cleanup('never-allocated', root)).not.toThrow()
  })
})

describe('install', () => {
  it('atomically renames the staged file to the final path', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.zh-Hans.srt')
    writeFileSync(stagedPath, '1\n00:00:01,000 --> 00:00:02,000\nhi\n')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(existsSync(stagedPath)).toBe(false)
  })

  it('NFC-normalizes the final path before writing (Synology SMB NFD landmine)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    // NFD-decomposed "e-acute": ASCII 'e' + U+0301 COMBINING ACUTE ACCENT (2 code
    // points), built via ́ escape rather than a precomposed literal char.
    // Deviation from the plan's literal source text: pasting a precomposed
    // character through the edit toolchain risks silent NFC re-normalization in
    // transit, which would make the input already-NFC and defeat this test's
    // purpose (asserting install() normalizes NFD input to NFC).
    const nfdName = "Café.zh-Hans.srt"
    const finalPath = join(root, nfdName)
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath.normalize('NFC'))
    expect(result.path).not.toBe(finalPath) // input is NFD, output must be NFC, bytes differ
  })
})

describe('install — parent-directory fsync (addendum A: 尽力 fsync 目录)', () => {
  afterEach(() => {
    openSyncOverride = null
    fsyncSyncOverride = null
    closeSyncOverride = null
  })

  it('opens, fsyncs, and closes the parent directory fd after a successful rename', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const openedPaths: string[] = []
    let fsyncedFd: number | null = null
    let closedFd: number | null = null
    openSyncOverride = (real, path, flags) => {
      openedPaths.push(path)
      return real(path, flags)
    }
    fsyncSyncOverride = (real, fd) => {
      fsyncedFd = fd
      return real(fd)
    }
    closeSyncOverride = (real, fd) => {
      closedFd = fd
      return real(fd)
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(openedPaths).toContain(root) // dirname(finalPath) === root
    expect(fsyncedFd).not.toBeNull()
    expect(closedFd).toBe(fsyncedFd)
  })

  it('swallows a directory-fsync failure without failing the install (best-effort, e.g. platforms without dir-fd fsync support)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'still installed')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    fsyncSyncOverride = () => {
      throw Object.assign(new Error('fsync not supported on directory fd'), { code: 'EINVAL' })
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe('still installed')
  })

  it('swallows an open-failure on the parent directory too (best-effort all the way through)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'installed anyway')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    openSyncOverride = () => {
      throw Object.assign(new Error('cannot open directory'), { code: 'EACCES' })
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
  })

  it('also fsyncs the parent directory on the EXDEV copy+rename fallback path', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let renameCalls = 0
    renameSyncOverride = (real, from, to) => {
      renameCalls++
      if (renameCalls === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      return real(from, to)
    }
    let fsyncedFd: number | null = null
    fsyncSyncOverride = (real, fd) => {
      fsyncedFd = fd
      return real(fd)
    }

    const result = await install(stagedPath, finalPath)

    expect(result.path).toBe(finalPath)
    expect(fsyncedFd).not.toBeNull()
  })
})

describe('install — retry and EXDEV fallback', () => {
  afterEach(() => {
    renameSyncOverride = null
  })

  it('retries on EBUSY (simulated SMB oplock jitter) and eventually succeeds', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let calls = 0
    renameSyncOverride = (real, from, to) => {
      calls++
      if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
      return real(from, to)
    }
    const result = await install(stagedPath, finalPath, fastDelays)
    expect(result.path).toBe(finalPath)
    expect(calls).toBe(3)
    expect(existsSync(finalPath)).toBe(true)
  })

  it('gives up after exhausting retries on a persistently retryable error', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    renameSyncOverride = () => {
      throw Object.assign(new Error('perm'), { code: 'EPERM' })
    }
    await expect(install(stagedPath, finalPath, fastDelays)).rejects.toThrow(/perm/)
  })

  it('does not retry a non-retryable code (EACCES): fails on the first attempt with no delay', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let calls = 0
    renameSyncOverride = () => {
      calls++
      throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    }
    // Real ladder on purpose: if this ever *did* retry, the un-mocked delays would make
    // the test slow — that would itself be a signal something regressed.
    await expect(install(stagedPath, finalPath)).rejects.toThrow(/access denied/)
    expect(calls).toBe(1)
  })

  it('falls back to copy+fsync+rename on EXDEV (cross-device, theoretically unreachable given allocate() shares the video root)', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let renameCalls = 0
    renameSyncOverride = (real, from, to) => {
      renameCalls++
      if (renameCalls === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      // second call is copyThenRenameSameDir's internal same-device rename — pass through
      return real(from, to)
    }
    const result = await install(stagedPath, finalPath)
    expect(result.path).toBe(finalPath)
    expect(existsSync(finalPath)).toBe(true)
    expect(readFileSync(finalPath, 'utf8')).toBe('cross-device content')
  })

  it('does not leak the copyThenRenameSameDir temp file into the media dir when the fallback rename fails', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    let renameCalls = 0
    renameSyncOverride = () => {
      renameCalls++
      // 1st call: install()'s primary rename → force the EXDEV fallback path.
      if (renameCalls === 1) throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
      // 2nd call: copyThenRenameSameDir's own same-dir rename → simulate a non-retryable
      // failure (e.g. EACCES) at the last step, after the temp file has already been
      // written+fsynced. Nothing above install() retries this fallback's rename, so this
      // must surface as a real failure — and must not leave the temp file behind in the
      // media directory.
      throw Object.assign(new Error('access denied'), { code: 'EACCES' })
    }

    await expect(install(stagedPath, finalPath)).rejects.toThrow(/access denied/)

    const leftovers = readdirSync(root).filter(f => f.startsWith('.subtitle-scout-install-'))
    expect(leftovers).toEqual([])
  })
})

describe('install — conflict detection (H1, 2026-07-18 数据安全审计: renameSync 对已存在目标零防线)', () => {
  afterEach(() => {
    renameSyncOverride = null
  })

  it('目标位置已存在文件（用户手放字幕/上次崩溃残留）→ 不覆盖，返回冲突结果，原文件内容不变', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'NEW candidate content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    writeFileSync(finalPath, 'EXISTING content — must survive')

    const result = await install(stagedPath, finalPath)

    expect(result).toEqual({ conflict: true, path: finalPath })
    expect(readFileSync(finalPath, 'utf8')).toBe('EXISTING content — must survive')
    // staged file untouched too — nothing was renamed away
    expect(existsSync(stagedPath)).toBe(true)
  })

  it('目标不存在 → 照常改名成功（结果不带 conflict 字段）', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const result = await install(stagedPath, finalPath)

    expect(result).toEqual({ path: finalPath })
    expect('conflict' in result).toBe(false)
  })

  it('EXDEV 兜底路径同样受保护：跨设备重试前目标恰好被别处创建 → 冲突而非覆盖', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'cross-device content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    renameSyncOverride = () => {
      // 模拟竞态：EXDEV 触发的那一刻，目标恰好已被别的进程/用户创建
      writeFileSync(finalPath, 'RACE WINNER content — must survive')
      throw Object.assign(new Error('cross-device'), { code: 'EXDEV' })
    }

    const result = await install(stagedPath, finalPath)

    expect(result).toEqual({ conflict: true, path: finalPath })
    expect(readFileSync(finalPath, 'utf8')).toBe('RACE WINNER content — must survive')
  })
})

// C-1 修复（2026-09-17 生产实案）：网盘后端在同一路径被写第二次时**不覆盖**，而是把自己新收的
// 那份改名成 `<base>(1)<ext>` 另存 → 同一集出现两份内容相同的字幕。根因是 rclone 挂载的
// `--dir-cache-time 5m` + `--vfs-cache-mode writes` 让 install() 的 existsSync 前置检查读到
// 陈旧目录缓存，于是 TOCTOU 窗口从"微秒级"变成"分钟级"。
describe('install — 重复品清理 (C-1, 网盘后端把冲突文件改名成 (1))', () => {
  it('落盘后存在内容相同的 <base>(1)<ext> → 装盘成功并把它清掉', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'SAME content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    // 模拟后端加的那份：内容与即将落盘的字幕逐字节相同
    writeFileSync(join(root, 'Show.S01E01.zh-Hans(1).srt'), 'SAME content')

    const result = await install(stagedPath, finalPath)

    expect('conflict' in result).toBe(false)
    expect(result).toEqual({
      path: finalPath,
      cleanup: [{ removed: join(root, 'Show.S01E01.zh-Hans(1).srt') }],
    })
    expect(existsSync(join(root, 'Show.S01E01.zh-Hans(1).srt'))).toBe(false)
    expect(readFileSync(finalPath, 'utf8')).toBe('SAME content')
  })

  it('误删防线：内容不同的 (1) 文件一个字节都不动，仅报告交人判断', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'OUR content')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    // 用户手放的、恰好同名的另一份字幕：内容不同 → 绝不能被我们删掉
    const userFile = join(root, 'Show.S01E01.zh-Hans(1).srt')
    writeFileSync(userFile, 'USER content — must survive')

    const result = await install(stagedPath, finalPath)

    expect(existsSync(userFile)).toBe(true)
    expect(readFileSync(userFile, 'utf8')).toBe('USER content — must survive')
    if ('cleanup' in result && result.cleanup) {
      expect(result.cleanup.every((n) => n.removed !== userFile || n.warning !== undefined)).toBe(true)
    }
  })

  it('多个编号 (1)(2)(3) 中只删内容相同的那些', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'SAME')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    writeFileSync(join(root, 'Show.S01E01.zh-Hans(1).srt'), 'SAME')
    writeFileSync(join(root, 'Show.S01E01.zh-Hans(2).srt'), 'DIFFERENT')
    writeFileSync(join(root, 'Show.S01E01.zh-Hans(3).srt'), 'SAME')

    await install(stagedPath, finalPath)

    expect(existsSync(join(root, 'Show.S01E01.zh-Hans(1).srt'))).toBe(false)
    expect(existsSync(join(root, 'Show.S01E01.zh-Hans(3).srt'))).toBe(false)
    expect(existsSync(join(root, 'Show.S01E01.zh-Hans(2).srt'))).toBe(true)
  })

  it('无重复品时结果形状与改动前完全一致（不带 cleanup 字段）', async () => {
    const root = mediaRoot()
    const stagedDir = allocate('job-1', root)
    const stagedPath = join(stagedDir, 'candidate.srt')
    writeFileSync(stagedPath, 'x')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const result = await install(stagedPath, finalPath)

    expect(result).toEqual({ path: finalPath })
    expect('cleanup' in result).toBe(false)
  })

  it('cleanupNumberedDuplicates 可独立调用；目录不可读时返回空表而不抛', () => {
    const root = mediaRoot()
    const finalPath = join(root, 'nope.srt')
    writeFileSync(finalPath, 'x')
    expect(cleanupNumberedDuplicates(join(root, 'not-a-dir', 'x.srt'))).toEqual([])
    expect(cleanupNumberedDuplicates(finalPath)).toEqual([])
  })

  // ── #1 修复（2026-09-18）：扫描侧复用 + 成本红线 ─────────────────────────────
  it('🔴 成本红线：清单里没有 `(n)` 候选 → **一个字节都不读**（原实现会先读整个字幕）', () => {
    const root = mediaRoot()
    // finalPath **故意不存在**。原实现无论如何都会先 readFileSync(finalPath) 当基准，
    // 读不到就 return —— 所以"零候选时也不读"这件事，用不存在的路径测最贴切：
    // 不读 → 直接按候选空表返回 []（不抛、不碰 fs）；读了 → 也返回 []，测不出区别。
    // 因此这里断言的是**可观察的差别**：目录真实存在、finalPath 不存在、清单无候选 → []。
    writeFileSync(join(root, 'other.mkv'), 'v')
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')

    const notes = cleanupNumberedDuplicates(finalPath, ['other.mkv', 'Show.S01E01.zh-Hans.srt'])

    expect(notes).toEqual([])
  })

  it('传进来的 knownEntries 被真的用上：有候选就按它清理（不依赖目录实际内容）', () => {
    const root = mediaRoot()
    const finalPath = join(root, 'Show.S01E01.zh-Hans.srt')
    const dupPath = join(root, 'Show.S01E01.zh-Hans(1).srt')
    writeFileSync(finalPath, 'same')
    writeFileSync(dupPath, 'same')

    // 清单**故意写着与磁盘一致**，但这次断言的是"用过 knownEntries"——
    // 若实现忽略了它去 readdir，结果一样，所以下面再补一条反证（清单与磁盘不一致）。
    expect(cleanupNumberedDuplicates(finalPath, ['Show.S01E01.zh-Hans.srt', 'Show.S01E01.zh-Hans(1).srt']))
      .toEqual([{ removed: dupPath }])
    expect(existsSync(dupPath)).toBe(false)
  })

  it('反证：清单里**没有**候选时，磁盘上真有的重复品不会被删（证明确实用了清单）', () => {
    const root = mediaRoot()
    const finalPath = join(root, 'Show.S02E01.zh-Hans.srt')
    const dupPath = join(root, 'Show.S02E01.zh-Hans(1).srt')
    writeFileSync(finalPath, 'same')
    writeFileSync(dupPath, 'same')

    // 传一份"不含 (1)"的清单 → 必须原样不动（若实现偷偷 readdir 就会把它删掉 → 本用例红）。
    expect(cleanupNumberedDuplicates(finalPath, ['Show.S02E01.zh-Hans.srt'])).toEqual([])
    expect(existsSync(dupPath)).toBe(true)
  })

  it('不传 knownEntries 时行为与改动前一致（自己 readdir）', () => {
    const root = mediaRoot()
    const finalPath = join(root, 'Show.S03E01.zh-Hans.srt')
    const dupPath = join(root, 'Show.S03E01.zh-Hans(1).srt')
    writeFileSync(finalPath, 'same')
    writeFileSync(dupPath, 'same')

    expect(cleanupNumberedDuplicates(finalPath)).toEqual([{ removed: dupPath }])
  })
})

describe('gcOrphans', () => {
  it('removes every staging dir not in activeJobIds, across multiple media roots', () => {
    const root1 = mediaRoot()
    const root2 = mediaRoot()
    const orphan1 = allocate('job-orphan-1', root1)
    allocate('job-active', root1)
    const orphan2 = allocate('job-orphan-2', root2)
    // R8-1：age-based 活性判断——orphan 条目必须旧于 10 分钟才会被删（刚创建的会被跳过）
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(orphan1, oldTime, oldTime)
    utimesSync(orphan2, oldTime, oldTime)

    const cleaned = gcOrphans([root1, root2], new Set(['job-active']), 0)

    expect(cleaned).toBe(2)
    expect(existsSync(join(root1, '.subtitle-staging', 'job-orphan-1'))).toBe(false)
    expect(existsSync(join(root1, '.subtitle-staging', 'job-active'))).toBe(true)
    expect(existsSync(join(root2, '.subtitle-staging', 'job-orphan-2'))).toBe(false)
  })

  it('is a no-op when a media root has no .subtitle-staging dir yet', () => {
    const root = mediaRoot()
    expect(() => gcOrphans([root], new Set(), 0)).not.toThrow()
    expect(gcOrphans([root], new Set(), 0)).toBe(0)
  })

  it('does not treat the .ignore marker file as an orphan directory', () => {
    const root = mediaRoot()
    allocate('job-1', root) // 顺带创建 .ignore
    gcOrphans([root], new Set(), 0)
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
  })

  it('boot semantics: empty activeJobIds nukes everything (mirrors jobsRepo.reapAllActive)', () => {
    const root = mediaRoot()
    const job1 = allocate('job-1', root)
    const job2 = allocate('job-2', root)
    const job3 = join(root, '.subtitle-staging', 'job-3')
    mkdirSync(job3, { recursive: true })
    // R8-1：age-based 活性判断——orphan 条目必须旧于 10 分钟才会被删
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(job1, oldTime, oldTime)
    utimesSync(job2, oldTime, oldTime)
    utimesSync(job3, oldTime, oldTime)
    const cleaned = gcOrphans([root], new Set(), 0)
    expect(cleaned).toBe(3)
  })

  it('P2.4: .subtitle-translate 工作台同法清扫(活跃 jobId 保留)', () => {
    const root = mediaRoot()
    const daemon1 = join(root, '.subtitle-translate', 'daemon-1')
    const daemon2 = join(root, '.subtitle-translate', 'daemon-2')
    mkdirSync(daemon1, { recursive: true })
    mkdirSync(daemon2, { recursive: true })
    // R8-1：age-based 活性判断——orphan 条目必须旧于 10 分钟才会被删
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(daemon1, oldTime, oldTime)
    const cleaned = gcOrphans([root], new Set(['daemon-2']), 0)
    expect(cleaned).toBe(1)
    expect(existsSync(join(root, '.subtitle-translate', 'daemon-1'))).toBe(false)
    expect(existsSync(join(root, '.subtitle-translate', 'daemon-2'))).toBe(true)
  })

  it('removes a stray non-directory file squatting in .subtitle-staging (not just orphan job dirs)', () => {
    const root = mediaRoot()
    const jobDir = allocate('job-1', root) // 顺带创建 .subtitle-staging/.ignore
    const junkFile = join(root, '.subtitle-staging', 'not-a-job-dir.txt')
    writeFileSync(junkFile, 'squatter')
    // R8-1：age-based 活性判断——orphan 条目（目录和文件）的 mtime 都必须旧于 10 分钟才会被删
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(jobDir, oldTime, oldTime)
    utimesSync(junkFile, oldTime, oldTime)

    const cleaned = gcOrphans([root], new Set(), 0)

    expect(existsSync(junkFile)).toBe(false)
    expect(cleaned).toBe(2) // job-1 dir + the junk file
  })

  it('removes a broken symlink in .subtitle-staging instead of leaving it to accumulate forever', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const stagingRoot = join(root, '.subtitle-staging')
    const brokenLink = join(stagingRoot, 'broken-link')
    symlinkSync(join(stagingRoot, 'does-not-exist-target'), brokenLink)
    // R7-1：age-based 活性判断——符号链接的 mtime 必须旧于 10 分钟才会被删
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    try { utimesSync(brokenLink, oldTime, oldTime) } catch { /* 符号链接可能不支持，忽略 */ }

    gcOrphans([root], new Set(), 0)

    // existsSync follows the link and would report false for a broken link either way —
    // lstatSync is the only way to tell whether the link entry itself was actually removed.
    expect(() => lstatSync(brokenLink)).toThrow()
  })

  it('removes a symlink-to-directory as a link, leaving the target directory untouched', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const stagingRoot = join(root, '.subtitle-staging')
    const targetDir = mkdtempSync(join(tmpdir(), 'gcorphans-symlink-target-'))
    writeFileSync(join(targetDir, 'keep-me.txt'), 'still here')
    const linkPath = join(stagingRoot, 'link-to-dir')
    symlinkSync(targetDir, linkPath)

    gcOrphans([root], new Set(), 0)

    expect(() => lstatSync(linkPath)).toThrow() // the link entry itself is gone
    expect(existsSync(targetDir)).toBe(true) // but its target was never touched
    expect(existsSync(join(targetDir, 'keep-me.txt'))).toBe(true)
  })

  // R7-1 修复：gcOrphans 用 age-based 活性判断（最近 10 分钟内有写入则跳过）——此前只看顶层目录
  // mtime，CLI 工作台持续写入在子目录（work/bilingual.jsonl），顶层 mtime 在启动几分钟后永久陈旧，
  // 自述场景（3 小时前创建的 CLI 工作台）照样被删。递归取最新 mtime + 10 分钟活性窗口。
  // 这条测试锁住"活跃的工作台（最近有写入）不会被删"。
  it('age-based 活性判断：最近 10 分钟内有写入的工作台不会被删（R7-1 假修复）', () => {
    const root = mediaRoot()
    const jobDir = allocate('cli-job-1', root)
    // 模拟活跃的工作台：在子目录写入（work/bilingual.jsonl）
    mkdirSync(join(jobDir, 'work'), { recursive: true })
    writeFileSync(join(jobDir, 'work', 'bilingual.jsonl'), '{"id":1,"src":"hello","tgt":"你好"}\n')
    // 顶层目录 mtime 设为 3 小时前（模拟 CLI 已跑了 3 小时），但子目录刚写入
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000)
    utimesSync(jobDir, oldTime, oldTime)

    const cleaned = gcOrphans([root], new Set(), Date.now())

    // 活跃的工作台不会被删（子目录最近有写入）
    expect(existsSync(jobDir)).toBe(true)
    expect(existsSync(join(jobDir, 'work', 'bilingual.jsonl'))).toBe(true)
    expect(cleaned).toBe(0)
  })

  it('age-based 活性判断：超过 10 分钟无写入的工作台会被删（陈旧）', () => {
    const root = mediaRoot()
    const jobDir = allocate('cli-job-1', root)
    // 模拟陈旧的工作台：顶层和子目录都是 3 小时前的
    mkdirSync(join(jobDir, 'work'), { recursive: true })
    writeFileSync(join(jobDir, 'work', 'bilingual.jsonl'), '{"id":1,"src":"hello","tgt":"你好"}\n')
    const oldTime = new Date(Date.now() - 3 * 60 * 60 * 1000)
    utimesSync(jobDir, oldTime, oldTime)
    utimesSync(join(jobDir, 'work'), oldTime, oldTime)
    utimesSync(join(jobDir, 'work', 'bilingual.jsonl'), oldTime, oldTime)

    const cleaned = gcOrphans([root], new Set(), Date.now())

    // 陈旧的工作台会被删
    expect(existsSync(jobDir)).toBe(false)
    expect(cleaned).toBe(1)
  })

  // R8-1 修复：刚 allocate、只建了空子目录、还没写任何文件的工作台，latestMtimeMs 只统计文件
  // 时 latest=0 会被误删（无论多新鲜）。这条测试锁住"空工作台（零文件）不会被删"。
  it('空工作台（刚 allocate、零文件）不会被删（R8-1 新回归）', () => {
    const root = mediaRoot()
    const jobDir = allocate('cli-job-1', root)
    // 只建空子目录，不写任何文件
    mkdirSync(join(jobDir, 'work'), { recursive: true })
    mkdirSync(join(jobDir, 'glossary'), { recursive: true })

    const cleaned = gcOrphans([root], new Set(), Date.now())

    // 空工作台不会被删（R8-1：latestMtimeMs 种子值带目录自身 mtime）
    expect(existsSync(jobDir)).toBe(true)
    expect(existsSync(join(jobDir, 'work'))).toBe(true)
    expect(cleaned).toBe(0)
  })

  // ── 2026-09-16 空壳回收（design D4/D7）──────────────────────────────────
  // 刻意**不写**"先删陈旧 <jobId> 再收父目录"的用例：D7 已实测证明那种组合在两种顺序下
  // 都要等下一个 boot（rmSync 一个子条目会把父目录 mtime 刷成"现在"）。锁它等于把一件
  // 本不该是契约的事变成契约。

  it('🔴 深层**只剩标记**的沙盒现在**不再**被回收（第 27 轮有意收窄删除面）', () => {
    const root = mediaRoot()
    const deep = join(root, 'Show', 'Season 01', 'Extra', '.subtitle-staging')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, '.ignore'), 'subtitle-scout staging area — media servers should not scan this directory\n')
    const old = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(join(deep, '.ignore'), old, old)
    utimesSync(deep, old, old)

    const cleaned = gcOrphans([root], new Set(), Date.now())

    // 旧口径（gcOrphans ①）会把它整目录删掉。第 27 轮删掉了那一段：父目录永驻之后
    // "只剩标记"是**正常稳态**，删它既会重开 #14 的窗口，又会把稳态报成残留。
    // 仍然可见：findStagingHusks 会在它**有残留**时报出来（下面几条用例守着）。
    expect(existsSync(deep)).toBe(true)
    expect(cleaned).toBe(0)
  })

  it('空壳回收：mtime 新于 bootTime 的空壳被保留（R6-9 语义对深层同样生效）', () => {
    const root = mediaRoot()
    const husk = join(root, 'Show', '.subtitle-staging')
    mkdirSync(husk, { recursive: true })
    writeFileSync(join(husk, '.ignore'), 'subtitle-scout staging area — media servers should not scan this directory\n')

    const cleaned = gcOrphans([root], new Set(), Date.now() - 60_000) // 标记比 bootTime 新

    expect(existsSync(husk)).toBe(true)
    expect(cleaned).toBe(0)
  })

  it('空壳回收：10 分钟内有写入的空壳被保留（R7-1 活性窗口对深层同样生效）', () => {
    const root = mediaRoot()
    const husk = join(root, 'Show', '.subtitle-staging')
    mkdirSync(husk, { recursive: true })
    writeFileSync(join(husk, '.ignore'), 'subtitle-scout staging area — media servers should not scan this directory\n')

    const cleaned = gcOrphans([root], new Set(), Date.now())

    expect(existsSync(husk)).toBe(true)
    expect(cleaned).toBe(0)
  })

  it('空壳回收：含 <jobId> 的深层沙盒**不**被回收（不扩大删除面）', () => {
    const root = mediaRoot()
    const sandbox = join(root, 'Show', '.subtitle-staging')
    mkdirSync(join(sandbox, 'job-1'), { recursive: true })
    writeFileSync(join(sandbox, '.ignore'), 'subtitle-scout staging area — media servers should not scan this directory\n')
    writeFileSync(join(sandbox, 'job-1', 'candidate.srt'), 'x')

    const cleaned = gcOrphans([root], new Set(), Date.now())

    expect(existsSync(sandbox)).toBe(true)
    expect(existsSync(join(sandbox, 'job-1', 'candidate.srt'))).toBe(true)
    expect(cleaned).toBe(0)
  })

  it('空壳回收：用户的普通文件与目录一个都不动', () => {
    const root = mediaRoot()
    mkdirSync(join(root, 'Show', 'Season 01'), { recursive: true })
    writeFileSync(join(root, 'Show', 'Season 01', 'E01.mkv'), 'video-bytes')
    const husk = join(root, 'Show', 'Season 01', '.subtitle-staging')
    mkdirSync(husk, { recursive: true })
    writeFileSync(join(husk, '.ignore'), 'subtitle-scout staging area — media servers should not scan this directory\n')
    const old = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(join(husk, '.ignore'), old, old)
    utimesSync(husk, old, old)

    gcOrphans([root], new Set(), Date.now())

    expect(existsSync(join(root, 'Show', 'Season 01', 'E01.mkv'))).toBe(true)
    expect(existsSync(join(root, 'Show', 'Season 01'))).toBe(true)
    expect(existsSync(join(root, 'Show'))).toBe(true)
  })
})

describe('gcOrphans — 在飞登记的是原始 jobId（映射后仍认得出）', () => {
  it('🔴 登记的原始 jobId（含冒号）其沙盒不被当孤儿删掉', () => {
    // daemonV2 的 inFlightStagingJobIds 登记的是 subtitleJobId() 的原样返回（`subtitle:tmdb:<id>`），
    // 而磁盘条目名已被 allocate 映射过。这一条锁住"两侧都传原始 jobId、映射只在 gcOrphans 内部做"。
    const root = mediaRoot()
    const dir = allocate('subtitle:tmdb:7', root)
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(dir, oldTime, oldTime)

    const cleaned = gcOrphans([root], new Set(['subtitle:tmdb:7']), 0)

    expect(cleaned).toBe(0)
    expect(existsSync(dir)).toBe(true)
  })

  it('登记已映射过的名字同样认得出（幂等性质撑住的第二种调用约定）', () => {
    const root = mediaRoot()
    const dir = allocate('subtitle:tmdb:7', root)
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(dir, oldTime, oldTime)

    const cleaned = gcOrphans([root], new Set(['subtitle-tmdb-7']), 0)

    expect(cleaned).toBe(0)
    expect(existsSync(dir)).toBe(true)
  })

  it('不在飞集合里的冒号任务照样被回收（保护不能变成豁免）', () => {
    const root = mediaRoot()
    const dir = allocate('subtitle:tmdb:8', root)
    const oldTime = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(dir, oldTime, oldTime)

    const cleaned = gcOrphans([root], new Set(['subtitle:tmdb:7']), 0)

    expect(cleaned).toBe(1)
    expect(existsSync(dir)).toBe(false)
  })
})

describe('probeStagingPlacement — doctor 的落点探针', () => {
  afterEach(() => {
    rmdirSyncOverride = null
    vi.restoreAllMocks()
  })

  it('可建的根：建得出来、也删得掉，且不留任何痕迹', () => {
    const root = mediaRoot()
    expect(() => probeStagingPlacement(root)).not.toThrow()
    // 第 27 轮起：父目录**留着**（父目录永驻是 #14 的根因修法；探针每跑一次就删一次父目录，
    // 等于每跑一次 doctor 就重开一次它自己要查的那个窗口）。留着 + 补标记，Jellyfin 不扫。
    expect(existsSync(join(root, '.subtitle-staging'))).toBe(true)
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
    // 探针自己的目录必须一个都不留
    const probes = readdirSync(join(root, '.subtitle-staging'))
      .filter(n => n.startsWith(PLACEMENT_PROBE_PREFIX))
    expect(probes).toEqual([])
    expect(readdirSync(root)).toEqual(['.subtitle-staging'])
  })

  it('已有 .subtitle-staging（如在跑任务）时只删探针目录，父目录与标记原样保留', () => {
    const root = mediaRoot()
    const jobDir = allocate('job-1', root)
    probeStagingPlacement(root)
    expect(existsSync(jobDir)).toBe(true)
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
    const leftovers = readdirSync(join(root, '.subtitle-staging'))
      .filter(n => n.startsWith(PLACEMENT_PROBE_PREFIX))
    expect(leftovers).toEqual([])
  })

  it('probe 名字走隐藏前缀（不会被 Jellyfin / 媒体树遍历看到）', () => {
    const root = mediaRoot()
    const names: string[] = []
    // 借 rmdirSync 接缝观察探针目录名（真实 rmdir 已由上一个用例覆盖）
    rmdirSyncOverride = (real, p) => {
      names.push(p)
      return real(p)
    }
    probeStagingPlacement(root)
    expect(names.some(p => p.includes(PLACEMENT_PROBE_PREFIX))).toBe(true)
    expect(PLACEMENT_PROBE_PREFIX.startsWith('.')).toBe(true)
  })

  it('媒体根不可达时抛 ENOENT，且**不**顺手把挂载点当普通目录建出来', () => {
    const root = mediaRoot()
    const missing = join(root, 'not-mounted')
    // 这一条同时钉住实现里的"两级都不 recursive"：若用了 recursive，探针会在宿主上凭空造出
    // `<missing>/.subtitle-staging/`，把"盘没挂上"伪装成 ✓（2026-07-29 云盘误判的同型事故）。
    expect(() => probeStagingPlacement(missing)).toThrow()
    expect(existsSync(missing)).toBe(false)
    expect(readdirSync(root)).toEqual([])
  })

  it('清理失败不改变结论：只记一条 ERROR，不抛错（残留交给 gcOrphans 兜底）', () => {
    const root = mediaRoot()
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    rmdirSyncOverride = () => {
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }
    expect(() => probeStagingPlacement(root)).not.toThrow()
    rmdirSyncOverride = null
    expect(spy.mock.calls.map(c => c.join(' ')).join('\n')).toContain(PLACEMENT_PROBE_PREFIX)
  })
})

describe('cleanup — 父目录收尾（净残留必须为 0）', () => {
  afterEach(() => { rmSyncOverride = null; unlinkSyncOverride = null })

  it('🔴 收尾：任务结束后 `<jobId>` 不留，**父目录与共用标记留着**（第 27 轮起的新不变量）', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'leftover.srt'), 'junk')
    cleanup('job-1', root)
    // ① 本任务的沙盒与文件必须干干净净地消失（这一条从来没变）
    expect(existsSync(dir)).toBe(false)
    // ② 父目录**留着**：父目录永驻是 #14 的根因修法（每任务删一次 = 每任务重新打开一次
    //    "刚删过的父目录当不了父目录"的窗口）。这是**有意反转**的旧不变量，故写在这里。
    expect(existsSync(join(root, '.subtitle-staging'))).toBe(true)
    // ③ 且必须带标记（否则 Jellyfin 会扫进这个隐藏目录）
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
    // ④ 除父目录之外，base 下不该再有任何别的隐藏条目
    expect(readdirSync(root).filter(n => n.startsWith('.'))).toEqual(['.subtitle-staging'])
  })

  it('收尾：同根还有另一个 jobId 时，父目录与共用标记都原样保留', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const dir2 = allocate('job-2', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    cleanup('job-1', root)
    expect(existsSync(join(root, '.subtitle-staging', 'job-1'))).toBe(false)
    expect(existsSync(dir2)).toBe(true)
    expect(readFileSync(ignorePath, 'utf8')).toContain('subtitle-scout staging')
  })

  it('收尾：<jobId> 删不掉（NAS 残留句柄）时父目录与标记保留，绝不误删还有内容的沙盒', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'half.srt'), 'partial')
    rmSyncOverride = (real, p) => {
      if (p === dir) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      return real(p)
    }
    cleanup('job-1', root)
    rmSyncOverride = null
    expect(existsSync(join(dir, 'half.srt'))).toBe(true)
    expect(existsSync(join(root, '.subtitle-staging'))).toBe(true)
    expect(existsSync(join(root, '.subtitle-staging', '.ignore'))).toBe(true)
  })

  it('🔴 收尾竞争：标记已删、父目录却被新沙盒占用时，标记必须被补回', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    const ignorePath = join(root, '.subtitle-staging', '.ignore')
    // 旧口径下这里有一条真实竞争窗口（"删标记"与"删空目录"之间被并发 allocate 插入），
    // 夹具靠 unlinkSyncOverride 在那个瞬间插进一个 job-2。
    // 第 27 轮起 cleanup **根本不删标记、也不删父目录**，那条窗口从构造上消失了——
    // 于是夹具改成直接模拟"另一个任务同时在跑"，断言的是同一件事：标记必须一直在。
    mkdirSync(join(root, '.subtitle-staging', 'job-2'), { recursive: true })
    cleanup('job-1', root)
    expect(existsSync(ignorePath)).toBe(true)
    expect(readFileSync(ignorePath, 'utf8')).toContain('subtitle-scout staging')
    expect(existsSync(join(root, '.subtitle-staging', 'job-2'))).toBe(true)
  })

  it('收尾：父目录里只剩一个「不是我们的」标记时不删（宁可不删）', () => {
    const root = mediaRoot()
    allocate('job-1', root)
    cleanup('job-1', root) // 正常收工，父目录已删
    // 用户自己造的巧合目录：叫同一个名字、里面也只有一个 .ignore，但内容不是我们的
    mkdirSync(join(root, '.subtitle-staging'), { recursive: true })
    writeFileSync(join(root, '.subtitle-staging', '.ignore'), 'my own notes\n')
    expect(isStagingHusk(join(root, '.subtitle-staging'))).toBe(false)
  })
})

describe('findStagingHusks', () => {
  const MARKER = 'subtitle-scout staging area — media servers should not scan this directory\n'
  const mkHusk = (dir: string): string => {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.ignore'), MARKER)
    return dir
  }
  /** "有残留"的沙盒：里面躺着一个 `<jobId>` 子目录（父目录永驻之后的**唯一**残留形态）。 */
  const mkLeftover = (dir: string): string => {
    mkdirSync(join(dir, 'job-1'), { recursive: true })
    return dir
  }

  it('🔴 只扫**根一级**：根下有残留就上报；深层与"只剩标记"都不上报（第 35 轮收窄，为 #19 提速）', () => {
    const root = mediaRoot()
    // ① 根一级的 .subtitle-staging 里有 <jobId> 残留 → 上报（用户看得见的形态）
    const atRoot = join(root, '.subtitle-staging')
    mkdirSync(join(atRoot, 'job-1'), { recursive: true })
    writeFileSync(join(atRoot, '.ignore'), MARKER)
    // ② 另一个根的 .subtitle-staging 只剩标记（父目录永驻后的**稳态**）→ 不上报
    const root2 = mediaRoot()
    mkHusk(join(root2, '.subtitle-staging'))
    // ③ **深层残留**（旧设计的形态）→ **不再**自动发现。这条断言把那个取舍**显式钉住**：
    //    遍历改成根一级，换来的是 boot 从"走完整棵媒体树"降到"每根两次 readdir"（#19）。
    mkLeftover(join(root, 'Show', 'Season 01', 'Extra', '.subtitle-staging'))
    // ④ 根一级的翻译工作台同理
    const translate = join(root, '.subtitle-translate')
    mkdirSync(join(translate, 'job-2'), { recursive: true })

    expect(findStagingHusks([root, root2]).sort()).toEqual([atRoot, translate].sort())
  })

  it('不进入隐藏目录内部（剪枝按 isJunkDirName 口径）', () => {
    const root = mediaRoot()
    // 埋在 .cache / @eaDir 这类隐藏树里的**残留**：遍历不该下钻进去
    // （夹具用"有残留"的形态：只剩标记的目录在现行判据下本来就不上报，拿它当夹具这条守卫会变成空的）
    mkLeftover(join(root, '.cache', 'deep', '.subtitle-staging'))
    mkLeftover(join(root, '@eaDir', 'deep', '.subtitle-staging'))
    expect(findStagingHusks([root])).toEqual([])
  })

  it('不穿过符号链接目录，也不把链接当作沙盒删', () => {
    const root = mediaRoot()
    const outside = mkdtempSync(join(tmpdir(), 'husk-outside-'))
    mkLeftover(join(outside, '.subtitle-staging'))
    symlinkSync(outside, join(root, 'link-out'))

    expect(findStagingHusks([root])).toEqual([])
    expect(existsSync(join(outside, '.subtitle-staging', 'job-1'))).toBe(true)
  })

  it('配置根嵌套时同一棵树不被走两遍，同一残留只上报一次', () => {
    const root = mediaRoot()
    mkLeftover(join(root, 'Show', '.subtitle-staging'))
    const husk = join(root, 'Show', '.subtitle-staging')
    expect(findStagingHusks([root, join(root, 'Show')])).toEqual([husk])
  })

  it('媒体根不存在 / 不可读时返回空表而不抛', () => {
    expect(findStagingHusks([join(tmpdir(), 'definitely-not-there-9f3a')])).toEqual([])
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// #14（2026-09-18）：`mkdir` 已存在的目录 → 后端 409 → rclone 上抛 EIO → 装盘全断。
//
// 这三条钉的是**判据的两侧**：容错必须生效（否则装盘断），而真失败必须照抛
// （否则就是本仓最怕的假绿）。外加一条顺带修掉的隐患。
// ─────────────────────────────────────────────────────────────────────────────
describe('allocate / probeStagingPlacement · 「后端说已存在」容错（#14）', () => {
  it('🔴 allocate 对**已存在**的沙盒目录不再抛（同一条分支覆盖 EEXIST 与 EIO）', () => {
    // 先手工建出两级（模拟"上次任务留下/后端已有而本地视图刚刷新"）
    const root = mediaRoot()
    const stagingRoot = join(root, '.subtitle-staging')
    mkdirSync(stagingRoot, { recursive: true })
    mkdirSync(join(stagingRoot, 'subtitle-tmdb-1'), { recursive: true })

    // 旧实现在这里抛 EEXIST（`recursive:true` 会吞 EEXIST，但**不吞 EIO**——
    // 而后端 409 翻译来的正是 EIO，生产实测就是这么断的）
    expect(() => allocate('subtitle:tmdb:1', root)).not.toThrow()
    expect(existsSync(join(stagingRoot, 'subtitle-tmdb-1'))).toBe(true)
  })

  it('🔴 真失败**必须照抛**：`.subtitle-staging` 的位置被一个文件占着 → 抛', () => {
    // 这一侧是护栏：容错判据是"**它确实是个目录**"，而不是"忽略一切 mkdir 错误"。
    // 吞掉真失败会让"装盘全断"变成"看起来一切正常"——比缺陷本身更糟。
    const root = mediaRoot()
    writeFileSync(join(root, '.subtitle-staging'), 'not a dir')
    expect(() => allocate('subtitle:tmdb:1', root)).toThrow()
  })

  it('🔴 顺带修掉：allocate **不再**把未挂载的媒体根递归建出来', () => {
    // 原实现用 `mkdirSync(dir, {recursive:true})`——媒体根没挂上时它会顺着把
    // `/mnt/.../影视` 建成本地空目录，把"盘没挂上"伪装成成功（本仓 2026-07-29 留过 175 个残留）。
    // probeStagingPlacement 一直为这条不用 recursive，allocate 此前没跟上。
    const ghost = join(mkdtempSync(join(tmpdir(), 'scout-ghost-')), 'not-mounted-root')
    expect(() => allocate('subtitle:tmdb:1', ghost)).toThrow()
    expect(existsSync(ghost)).toBe(false)          // 关键断言：没被凭空造出来
  })

  it('探针在同样的"已存在"情形下不再抛（doctor 的 staging-placement 不该报假红）', () => {
    const root = mediaRoot()
    mkdirSync(join(root, '.subtitle-staging'), { recursive: true })   // 父目录已存在
    expect(() => probeStagingPlacement(root)).not.toThrow()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// retryUntilDirectory —— #14 的**策略**层（2026-09-18 生产事故的时间线）
//
// 上面那组测试钉的是"已存在时不抛"，但它**钉不住本次事故**：本修复的第一版正是通过了
// 那类测试、却在生产上继续报红。事故的关键不是"已存在"，而是"**报错的那一刻本地视图
// 还是旧的**"——而这一点在本地文件系统上造不出来（本地 mkdir 不会给出"失败了却成功了"
// 的答案，statSync 也永远是最新的）。故把重试策略与真实 fs 解耦，用注入的时间线把生产上
// 真实发生过的顺序（报错 → 判据说没有 → 稍等 → 判据才说有了）重放一遍。
// 下面这几条**全部不碰真实 fs、不真睡**（睡眠也是注入的）。
// ─────────────────────────────────────────────────────────────────────────────
describe('retryUntilDirectory · 「重试到看见为止」的预算与错误语义（#14）', () => {
  const eio = () => Object.assign(new Error('EIO: input/output error'), { code: 'EIO' })

  it('🔴 生产时间线：前两次报错且判据说"不是目录"，第三次判据才刷新 → 不抛、共试 3 次', () => {
    const events: string[] = []
    let verdicts = 0            // 判据被问了几次 = 本地视图刷新了几步
    let attempts = 0
    retryUntilDirectory(
      () => { attempts++; events.push('attempt'); throw eio() },
      () => ++verdicts >= 3,    // 第 3 次问才对：模拟"毫秒~秒级才刷新"
      ms => events.push(`sleep:${ms}`),
      3,
      [120, 400],
    )
    expect(attempts).toBe(3)
    expect(events).toEqual(['attempt', 'sleep:120', 'attempt', 'sleep:400', 'attempt'])
  })

  it('判据在第一次报错后**立刻**为真 → 只试一次、不睡（不浪费预算）', () => {
    const events: string[] = []
    let attempts = 0
    retryUntilDirectory(
      () => { attempts++; events.push('attempt'); throw eio() },
      () => true,               // 出错那一刻视图已经是新的（EEXIST 那一类）
      ms => events.push(`sleep:${ms}`),
      3,
      [120, 400],
    )
    expect(attempts).toBe(1)
    expect(events).toEqual(['attempt'])
  })

  it('🔴 判据**永远**为假 → 抛，且抛的是**最后一次**那条原始错误（不包装、不吞）', () => {
    const thrown: unknown[] = []
    let attempts = 0
    let caught: unknown
    try {
      retryUntilDirectory(
        () => { attempts++; const e = eio(); thrown.push(e); throw e },
        () => false,            // 真失败：路径上确实什么都没有
        () => {},
        3,
        [120, 400],
      )
    } catch (e) { caught = e }

    expect(attempts).toBe(3)                         // 预算用尽才放弃
    expect(caught).toBe(thrown[2])                   // 身份相同 = 原样上抛，没被换成新 Error
    expect((caught as { code?: string }).code).toBe('EIO')  // 根因字段还得在，日志才认得出
  })

  it('睡眠严格按 delaysMs 逐次发生，且**最后一次失败后不再睡**（预算耗尽即抛）', () => {
    const slept: number[] = []
    let attempts = 0
    expect(() => retryUntilDirectory(
      () => { attempts++; throw eio() },
      () => false,
      ms => slept.push(ms),
      4,
      [10, 20, 30],
    )).toThrow()
    expect(attempts).toBe(4)
    expect(slept).toEqual([10, 20, 30])              // 4 次尝试 = 3 次间隔
  })

  it('动作成功即返回——成功路径**不**看判据（判据只用于"报错了才知道看"）', () => {
    let asked = 0
    retryUntilDirectory(() => {}, () => { asked++; return false }, () => {}, 3, [120, 400])
    expect(asked).toBe(0)
  })

  it('attempts <= 0 不是"静默成功"，而是至少试一次（宁可多试也不能假装建成）', () => {
    let attempts = 0
    expect(() => retryUntilDirectory(
      () => { attempts++; throw eio() },
      () => false,
      () => {},
      0,
      [],
    )).toThrow()
    expect(attempts).toBe(1)
  })

  it('留痕：每次"还没放弃、准备再来一次"都回调一次（序号从 1 起 + 那条原始错误）', () => {
    // 容错悄悄生效 = 没人知道 #14 又发生过一次、也没人敢动这个重试预算。
    const noted: Array<{ n: number; code?: string }> = []
    let verdicts = 0
    retryUntilDirectory(
      () => { throw eio() },
      () => ++verdicts >= 3,      // 第 3 次问才对 → 前两次失败都要留痕
      () => {},
      3,
      [120, 400],
      (n, e) => noted.push({ n, code: (e as { code?: string }).code }),
    )
    expect(noted).toEqual([{ n: 1, code: 'EIO' }, { n: 2, code: 'EIO' }])
  })

  it('留痕**不**覆盖最后那次失败（预算耗尽即抛，没有"下一次"可言）', () => {
    const noted: number[] = []
    expect(() => retryUntilDirectory(
      () => { throw eio() },
      () => false,
      () => {},
      3,
      [120, 400],
      n => noted.push(n),
    )).toThrow()
    expect(noted).toEqual([1, 2])   // 第 3 次失败直接抛，不回调——日志不该说"等待后重试"
  })

  it('出错时视图已经是新的 → 一次都不算重试，不回调（EEXIST 那一类不该刷日志）', () => {
    const noted: number[] = []
    retryUntilDirectory(() => { throw eio() }, () => true, () => {}, 3, [120, 400], n => noted.push(n))
    expect(noted).toEqual([])
  })
})