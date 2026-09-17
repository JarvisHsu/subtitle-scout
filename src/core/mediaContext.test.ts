import { describe, it, expect, vi } from 'vitest'
import * as fs from 'node:fs'
import { mkdtempSync, chmodSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePathMappings, mapPath, isUnderRoots, containingRoot, isDirWritable, sweepWriteProbes, stagingDirName } from './mediaContext.js'

describe('parsePathMappings', () => {
  it('parses comma-separated pairs', () => {
    expect(parsePathMappings('/media=/mnt/nas,/tv=/mnt/tv')).toEqual([
      { from: '/media', to: '/mnt/nas' }, { from: '/tv', to: '/mnt/tv' },
    ])
  })
  it('empty/undefined → identity (empty list)', () => {
    expect(parsePathMappings(undefined)).toEqual([])
    expect(parsePathMappings('')).toEqual([])
  })
  it('throws on malformed pair', () => {
    expect(() => parsePathMappings('/media')).toThrow(/invalid/i)
  })
})

describe('mapPath', () => {
  it('longest prefix wins', () => {
    const m = [{ from: '/media', to: '/A' }, { from: '/media/movies', to: '/B' }]
    expect(mapPath('/media/movies/x.mkv', m)).toBe('/B/x.mkv')
    expect(mapPath('/media/tv/y.mkv', m)).toBe('/A/tv/y.mkv')
  })
})

describe('isUnderRoots', () => {
  it('empty roots → unrestricted', () => {
    expect(isUnderRoots('/anywhere/x', [])).toBe(true)
  })
  it('accepts paths under a root, rejects outside and sibling-prefix tricks', () => {
    const roots = ['/mnt/media']
    expect(isUnderRoots('/mnt/media/Movies/x', roots)).toBe(true)
    expect(isUnderRoots('/mnt/media', roots)).toBe(true)
    expect(isUnderRoots('/etc', roots)).toBe(false)
    expect(isUnderRoots('/mnt/media-evil/x', roots)).toBe(false)
  })
})

describe('containingRoot', () => {
  it('returns the root that contains a deep path', () => {
    const roots = ['/mnt/media']
    expect(containingRoot('/mnt/media/Show/Season 01/x.mkv', roots)).toBe('/mnt/media')
  })
  it('returns the path itself when it equals a root exactly', () => {
    expect(containingRoot('/mnt/media', ['/mnt/media'])).toBe('/mnt/media')
  })
  it('returns null when no root is a prefix (including sibling-prefix tricks)', () => {
    expect(containingRoot('/etc/x', ['/mnt/media'])).toBeNull()
    expect(containingRoot('/mnt/media-evil/x', ['/mnt/media'])).toBeNull()
  })
  it('returns null for an empty roots list', () => {
    expect(containingRoot('/anywhere/x', [])).toBeNull()
  })
  it('picks the longest (most specific) matching root when roots are nested', () => {
    const roots = ['/mnt/media', '/mnt/media/tv']
    expect(containingRoot('/mnt/media/tv/Show/x.mkv', roots)).toBe('/mnt/media/tv')
    expect(containingRoot('/mnt/media/movies/x.mkv', roots)).toBe('/mnt/media')
  })
})

describe('isDirWritable', () => {
  it('returns true for a writable directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ok-'))
    expect(isDirWritable(dir)).toBe(true)
  })
  it('leaves no probe file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-clean-'))
    isDirWritable(dir)
    expect(readdirSync(dir).some(f => f.startsWith('.subtitle-scout-writetest'))).toBe(false)
  })
  it('returns false for a non-existent directory', () => {
    expect(isDirWritable(join(tmpdir(), 'wp-does-not-exist-zzz', 'nope'))).toBe(false)
  })
  it('returns false for a read-only directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-ro-'))
    chmodSync(dir, 0o555)
    // 以 root 运行时权限位被绕过,该断言不成立 → 条件跳过
    if (process.getuid && process.getuid() === 0) return
    expect(isDirWritable(dir)).toBe(false)
  })

  // 🔴 2026-07-29 生产事故回归锁（云盘误判 + 175 个残留垃圾）：旧实现把「删成功」当成可写的
  // 必要条件——云盘（rclone WebDAV）最终一致性下 writeFileSync 成功但紧随的 unlinkSync 抛错，
  // 于是①误报不可写（昨夜 job 34 全线拒装云盘目标，而手工 touch 证明可写）②每次留一个垃圾。
  // 正确语义：**写成功即可写，删除只是清理**。
  //
  // ESM 下无法 spyOn 模块导出（Cannot redefine property），改用注入式的可测接缝：
  // isDirWritable 接受可选的 unlink 实现，生产走真实 fs，测试注入一个会抛错的。
  it('🔴 写成功但删除失败时仍判定可写（云盘最终一致性形状）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-unlinkfail-'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const writable = isDirWritable(dir, () => { throw new Error('EAGAIN: eventual consistency') })
      expect(writable).toBe(true) // 旧实现在这里返回 false
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('write probe left behind'))
      // 探针文件确实残留了（这正是云盘上发生的），留给 sweepWriteProbes 兜底
      expect(readdirSync(dir).some(f => f.startsWith('.subtitle-scout-writetest'))).toBe(true)
    } finally {
      errSpy.mockRestore()
    }
  })
})

describe('sweepWriteProbes', () => {
  it('清掉残留的写探针文件，返回删除数量', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-sweep-'))
    writeFileSync(join(dir, '.subtitle-scout-writetest-7-1'), '')
    writeFileSync(join(dir, '.subtitle-scout-writetest-7-2'), '')
    writeFileSync(join(dir, 'real-subtitle.srt'), 'keep me')
    const removed = sweepWriteProbes(dir, readdirSync)
    expect(removed).toBe(2)
    expect(readdirSync(dir)).toEqual(['real-subtitle.srt'])
  })

  it('目录读不了时返回 0，不抛错', () => {
    expect(sweepWriteProbes(join(tmpdir(), 'wp-nope-zzz'), readdirSync)).toBe(0)
  })

  it('单个文件删不掉不影响其余（尽力而为）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wp-sweep-partial-'))
    writeFileSync(join(dir, '.subtitle-scout-writetest-9-1'), '')
    writeFileSync(join(dir, '.subtitle-scout-writetest-9-2'), '')
    // 注入式 unlink：对 -9-1 抛错，其余走真实删除
    const removed = sweepWriteProbes(dir, readdirSync, (p) => {
      if (p.endsWith('-9-1')) throw new Error('EPERM')
      fs.unlinkSync(p)
    })
    expect(removed).toBe(1) // 只删掉了能删的那个
    expect(readdirSync(dir)).toEqual(['.subtitle-scout-writetest-9-1'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// stagingDirName · 沙盒目录名映射（2026-09-17 生产实测：夸克网盘经 alist 拒绝目录名里的 `:`，
// 而同一个位置的**文件名**允许 `:`；rclone 的 VFS 写缓存又把 mkdir 失败伪装成本地成功，
// 于是含冒号的沙盒目录建不起来、也删不掉，任务每次结束都在用户媒体目录里留一个空壳）。
// 这一族用例钉住映射本身；三处消费点由 stagingSandbox.test.ts 钉。
// ─────────────────────────────────────────────────────────────────────────────
describe('stagingDirName', () => {
  it('🔴 生产形态的 jobId 映射后不含冒号', () => {
    // 这一条就是本次缺陷的红线：旧代码把 `subtitle:tmdb:60948` 逐字当目录名。
    expect(stagingDirName('subtitle:tmdb:60948')).toBe('subtitle-tmdb-60948')
    expect(stagingDirName('subtitle:tmdb:60948')).not.toContain(':')
  })

  it('幂等：对已映射过的名字再映射一次结果不变', () => {
    // 承重性质——"调用方传原始 jobId"与"传已映射名字"必须同结果，否则又变成了两份纪律。
    const once = stagingDirName('subtitle:tmdb:60948')
    expect(stagingDirName(once)).toBe(once)
  })

  it('无非法字符的 jobId（jobs 表自增整数）逐字不变', () => {
    expect(stagingDirName('17')).toBe('17')
    expect(stagingDirName('job-1')).toBe('job-1')
  })

  it('非法字符逐个替换为 `-`（路径分隔符 + 文件系统保留集）', () => {
    expect(stagingDirName('a:b')).toBe('a-b')
    expect(stagingDirName('a?b')).toBe('a-b')
    expect(stagingDirName('a*b')).toBe('a-b')
    expect(stagingDirName('a|b')).toBe('a-b')
    expect(stagingDirName('a"b')).toBe('a-b')
    expect(stagingDirName('a<b')).toBe('a-b')
    expect(stagingDirName('a>b')).toBe('a-b')
    expect(stagingDirName('a/b')).toBe('a-b')
    expect(stagingDirName('a\\b')).toBe('a-b')
    expect(stagingDirName('a:b?c*d|e"f<g>h/i\\j')).toBe('a-b-c-d-e-f-g-h-i-j')
  })

  it('🔴 合法字符必须逐字保留（误伤它们等于把沙盒换到别处建不起来）', () => {
    // 生产的目录名里就有全角冒号、括号、方括号、空格与中文——全角冒号不是保留字符。
    const mixed = 'subtitle：tmdb（2024）[测试] v2 已修复'
    expect(stagingDirName(mixed)).toBe(mixed)
  })

  it('只返回单层目录名（不含路径分隔符残留）', () => {
    expect(stagingDirName('a/b/c')).not.toMatch(/[/\\]/)
    expect(stagingDirName('a/b/c')).toBe('a-b-c')
  })
})
