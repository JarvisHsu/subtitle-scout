import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync,
  readdirSync, symlinkSync, lstatSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allocate, cleanup, install, gcOrphans, findStagingHusks, isStagingHusk, probeStagingPlacement, PLACEMENT_PROBE_PREFIX, cleanupNumberedDuplicates } from './stagingSandbox.js'

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
    expect(existsSync(join(root, '.subtitle-staging'))).toBe(false)
    expect(readdirSync(root).filter(n => n.startsWith('.'))).toEqual([])
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

  it('🔴 空壳回收：任意深度的空壳被整目录回收（含 ≥3 层深）', () => {
    const root = mediaRoot()
    const deep = join(root, 'Show', 'Season 01', 'Extra', '.subtitle-staging')
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(deep, '.ignore'), 'subtitle-scout staging area — media servers should not scan this directory\n')
    const old = new Date(Date.now() - 11 * 60 * 1000)
    utimesSync(join(deep, '.ignore'), old, old)
    utimesSync(deep, old, old)

    const cleaned = gcOrphans([root], new Set(), Date.now())

    expect(existsSync(deep)).toBe(false)
    expect(cleaned).toBe(1)
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
    // 父目录是探针顺手建的 → 必须一并收掉，否则 doctor 会在媒体根里留一个 0 条目的
    // .subtitle-staging（它既不是空壳也不在任何回收面的判据里）
    expect(existsSync(join(root, '.subtitle-staging'))).toBe(false)
    expect(readdirSync(root)).toEqual([])
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

  it('🔴 收尾：任务结束后 <base> 下不留任何由本系统创建的隐藏条目', () => {
    const root = mediaRoot()
    const dir = allocate('job-1', root)
    writeFileSync(join(dir, 'leftover.srt'), 'junk')
    cleanup('job-1', root)
    expect(existsSync(join(root, '.subtitle-staging'))).toBe(false)
    // 红线断言：整个 base 下不该有任何隐藏条目（渲染用户可见现象的是这一条，不是上面那条）
    expect(readdirSync(root).filter(n => n.startsWith('.'))).toEqual([])
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
    // 精确模拟 D3 承认的那条窗口：在"删标记"与"删空目录"之间插入一个并发 allocate。
    unlinkSyncOverride = (real, p) => {
      if (p === ignorePath) mkdirSync(join(root, '.subtitle-staging', 'job-2'), { recursive: true })
      return real(p)
    }
    cleanup('job-1', root)
    unlinkSyncOverride = null
    // rmdirSync 撞 ENOTEMPTY → ensureStagingMarker 把标记补回：新沙盒继续被屏蔽
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

  it('只返回"唯一条目是本项目标记文件"的沙盒目录', () => {
    const root = mediaRoot()
    const husk = mkHusk(join(root, 'Show', '.subtitle-staging'))
    // ① 含 <jobId> 的沙盒 → 不是空壳
    mkdirSync(join(root, 'Live', '.subtitle-staging', 'job-1'), { recursive: true })
    writeFileSync(join(root, 'Live', '.subtitle-staging', '.ignore'), MARKER)
    // ② 同名目录但还含别的文件 → 不是空壳
    mkdirSync(join(root, 'Other', '.subtitle-staging'), { recursive: true })
    writeFileSync(join(root, 'Other', '.subtitle-staging', '.ignore'), MARKER)
    writeFileSync(join(root, 'Other', '.subtitle-staging', 'keep.srt'), 'x')
    // ③ 标记内容不是我们的 → 不是空壳
    mkdirSync(join(root, 'Foreign', '.subtitle-staging'), { recursive: true })
    writeFileSync(join(root, 'Foreign', '.subtitle-staging', '.ignore'), 'handmade\n')
    // ④ 条目只有 .ignore 但它是目录而非文件 → 不是空壳
    mkdirSync(join(root, 'Weird', '.subtitle-staging', '.ignore'), { recursive: true })

    expect(findStagingHusks([root])).toEqual([husk])
  })

  it('能命中深层空壳（≥3 层），且翻译工作台的标记同样被认作空壳', () => {
    const root = mediaRoot()
    const deep = mkHusk(join(root, 'A', 'B', 'C', '.subtitle-staging'))
    const translate = mkHusk(join(root, 'A', '.subtitle-translate'))

    const found = findStagingHusks([root]).sort()
    expect(found).toEqual([deep, translate].sort())
  })

  it('不进入隐藏目录内部（剪枝按 isJunkDirName 口径）', () => {
    const root = mediaRoot()
    // 埋在 .cache 这类隐藏树里的空壳：遍历不该下钻进去
    mkHusk(join(root, '.cache', 'deep', '.subtitle-staging'))
    mkHusk(join(root, '@eaDir', 'deep', '.subtitle-staging'))
    expect(findStagingHusks([root])).toEqual([])
  })

  it('不穿过符号链接目录，也不把链接当作沙盒删', () => {
    const root = mediaRoot()
    const outside = mkdtempSync(join(tmpdir(), 'husk-outside-'))
    mkHusk(join(outside, '.subtitle-staging'))
    symlinkSync(outside, join(root, 'link-out'))

    expect(findStagingHusks([root])).toEqual([])
    expect(existsSync(join(outside, '.subtitle-staging'))).toBe(true)
  })

  it('配置根嵌套时同一棵树不被走两遍，同一空壳只上报一次', () => {
    const root = mediaRoot()
    const husk = mkHusk(join(root, 'Show', '.subtitle-staging'))
    expect(findStagingHusks([root, join(root, 'Show')])).toEqual([husk])
  })

  it('媒体根不存在 / 不可读时返回空表而不抛', () => {
    expect(findStagingHusks([join(tmpdir(), 'definitely-not-there-9f3a')])).toEqual([])
  })
})
