// src/dashboard/identifyBindApi.test.ts —— D-5 人工绑定通道的回归网（2026-09-18）。
//
// 这一族测的不是"HTTP 端点能不能通"（那是 server.test.ts 的活），而是**写库路径的复用**是否
// 真的成立。整条 D-5 的设计承诺是「人工绑定不开旁路」——所以下面每个用力的断言都盯着"复用"：
//   · 证据不过就**不写库**（与自动路径同一个 422，不是"用户说了算"的旁路）
//   · 写进去的 work_id_source 必须是 'human'（撤销闸的唯一凭据）
//   · 撤销闸**只认** 'human'——agent 的判定必须原地不动
// 任何一条失守，D-5 就从"人工兜底"变成"绕开核验的写库后门"，那比不做更糟。
import { describe, it, expect } from 'vitest'
import { openDb } from '../v2/db.js'
import { bindUnidentifiedDir, unbindUnidentifiedDir } from './identifyBindApi.js'
import { encodeWorkDirHandle, decodeWorkDirHandle } from '../core/workDirHandle.js'
import type { IdentifyWorkerDeps } from '../agent/identifyWorker.js'

// ─────────────────────────────────────────────────────────────────────────────
// 句柄编解码：不透明指针，必须无损往返且对垃圾输入**返回 null 而不是抛**
// ─────────────────────────────────────────────────────────────────────────────
describe('workDirHandle · 不透明句柄编解码', () => {
  it('往返无损（含 CJK / 空格 / 方括号 / 反斜杠 等真实发布组命名）', () => {
    const cases = [
      '/media/quark/影视/[西虹市首富] (2018)',
      'C:\\Media\\TV\\Show S01',
      '/mnt/quark/动漫/[爱情公寓][全1-5季+电影+番外篇][国语中字][4K高码][203G]',
      '/a/b/c',
    ]
    for (const dir of cases) {
      expect(decodeWorkDirHandle(encodeWorkDirHandle(dir))).toBe(dir)
    }
  })

  it('句柄是 URL 安全的（不含 + / = 这三个要不要转义的字符）', () => {
    // 这是选 base64**url** 而不是 base64 的全部理由：句柄要被前端原样塞进 JSON / query，
    // 一旦产出 `+` `=`，某些前端框架的表单编码会把它改成空格 → 服务端解出另一个目录。
    for (const dir of ['/media/a?b', '/media/~~', '/media/ÿ', '/x'.repeat(40)]) {
      const h = encodeWorkDirHandle(dir)
      expect(h).not.toMatch(/[+/=]/)
    }
  })

  it('垃圾输入 → null（不是抛异常，也不是解出半个路径）', () => {
    for (const bad of ['', '=', 'not-base64!!', '!!', '----', '____']) {
      expect(decodeWorkDirHandle(bad)).toBeNull()
    }
  })

  it('长度 ≡ 1 (mod 4) → null：往返校验**唯一**能拒绝的形状（实测，不是推算）', () => {
    // 实测结论（node -e 打过一遍，`probe` 见下）——base64 对"畸形"的容忍度比直觉宽得多：
    //   · `'L2E'` / `'L2Ev'` / `'L2EvYg'` 都是**完全合法**的非填充句柄（分别是 '/a'、'/a/'、'/a/b'）；
    //   · 在合法句柄尾部**追加**字符也是合法的——它只是指向另一个路径
    //     （`'/a/b' + 'A'` → 解出 `'/a/b\u0000'`，一个真实的字符串，往返一致）。
    // 唯一无法被**任何**字符串编出来的形状是长度 4k+1：那种长度下最后 2 个 bit 无处安放，
    // canonical 编码永远不会产出它。所以往返校验拦的就是"位宽对不上"这一类。
    //
    // 这条界桩是写给下一个人的：别把"追加了字符 / 截短了"想当然当成篡改判据——它们各有各的
    // 合法读法，写了那种断言只会得到一条假红。真正的防线不是句柄的不可伪造性，而是**服务端
    // 另行判定**（目录必须真的未识别；撤销只认 work_id_source='human'）。
    for (const bad of ['A', 'AAAAA', 'Zm9vY', encodeWorkDirHandle('/a/b').slice(0, 5)]) {
      expect(bad.length % 4).toBe(1)
      expect(decodeWorkDirHandle(bad)).toBeNull()
    }
  })

  it('格式合法但目录不存在的句柄 → **照样解得出**（"解不开" ≠ "没有这个目录"）', () => {
    // 界桩：往返校验只回答"这是不是我们发出的句柄"，不回答"这个目录在不在库里"。
    // 后者由 DB 查询回答（→ 404）。把两者混进一个判据，一个**完全合法**的句柄就会被
    // 报成 400 "invalid handle"——用户看到"你给的句柄有问题"，而真相是"这个目录没有
    // 未识别文件"。这两句话给用户的下一步动作完全不同。
    const h = encodeWorkDirHandle('foo')
    expect(h).toBe('Zm9v')
    expect(decodeWorkDirHandle(h)).toBe('foo')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 绑定
// ─────────────────────────────────────────────────────────────────────────────
const WORK_DIR = '/media/影视/[西虹市首富] (2018)'

/** 播种一簇**未识别**文件（work_id IS NULL）——绑定端点的入口条件。 */
function seedUnidentified(db: ReturnType<typeof openDb>, workDir = WORK_DIR, files = ['西虹市首富.2018.2160p.mkv']) {
  for (const n of files) {
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, updated_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(`${workDir}/${n}`, workDir, n, 100, 1000, workDir, 1000)
  }
  return encodeWorkDirHandle(workDir)
}

/** 用户的 id 指向一部**标题对得上**的作品：目录名 `[西虹市首富] (2018)` + 年份 2018 两条证据都过。 */
const MATCHING_DETAILS = {
  id: 439418,
  title: 'Hello, Mr. Billionaire',
  originalTitle: '西虹市首富',
  year: 2018,
  genreIds: [] as number[],
  chineseTitles: ['西虹市首富'],
}

function tmdbReturning(details: unknown | null, calls?: string[]): IdentifyWorkerDeps['tmdb'] {
  return {
    search: async () => [],
    getDetails: (async (mt: string, _id: string) => {
      calls?.push(mt)
      // `as any`：这里只喂 verifyEvidence 真正会读的那几个字段，不假装构造完整 TmdbDetails。
      return details as any
    }) as IdentifyWorkerDeps['tmdb']['getDetails'],
  } as IdentifyWorkerDeps['tmdb']
}

describe('bindUnidentifiedDir · 人工绑定走的是**同一条**核验+写库路径', () => {
  it('✅ 标题+年份都过 → 落库，且 work_id_source = human（撤销闸的唯一凭据）', async () => {
    const db = openDb(':memory:')
    const handle = seedUnidentified(db)

    const r = await bindUnidentifiedDir(
      { db, tmdb: tmdbReturning(MATCHING_DETAILS) },
      { handle, tmdbId: '439418' },
    )

    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.error)
    expect(r.tmdbId).toBe('439418')
    expect(r.written).toBe(1)

    const row = db.prepare('SELECT work_id, work_id_source, identify_gate_version, last_error, attempt FROM files WHERE work_dir = ?').get(WORK_DIR) as any
    expect(row.work_id).toBe('tmdb:439418')
    // 🔴 这一行是整个 D-5 的关键：没有它，撤销闸就没有"这是我绑的"的凭据。
    expect(row.work_id_source).toBe('human')
    // 版本戳必须与自动路径同源——否则队列谓词会把已绑定的行当成"旧版本未识别"重新入队。
    expect(row.identify_gate_version).not.toBeNull()
    expect(row.last_error).toBeNull()
    expect(row.attempt).toBe(0)
    db.close()
  })

  it('✅ works 行也落了（人工绑定不是"只盖一个 work_id"）', async () => {
    const db = openDb(':memory:')
    const handle = seedUnidentified(db)
    await bindUnidentifiedDir({ db, tmdb: tmdbReturning(MATCHING_DETAILS) }, { handle, tmdbId: '439418' })

    const w = db.prepare('SELECT id, title FROM works WHERE id = ?').get('tmdb:439418') as any
    expect(w).toBeTruthy()
    expect(w.title).toBe('Hello, Mr. Billionaire')
    db.close()
  })

  it('🔴 用户的 id 未被证据支持 → 422，且**一个字都不写库**（人工不是免检通道）', async () => {
    const db = openDb(':memory:')
    const handle = seedUnidentified(db)

    // 用户选错了作品：这是一部完全无关的片子（标题与年份都对不上目录）。
    const wrong = { id: 603, title: 'The Matrix', originalTitle: 'The Matrix', year: 1999, genreIds: [], chineseTitles: [] }
    const r = await bindUnidentifiedDir({ db, tmdb: tmdbReturning(wrong) }, { handle, tmdbId: '603' })

    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unexpected ok')
    expect(r.status).toBe(422)
    expect(r.error).toContain('evidence-fail')

    // 核心断言：写坏身份比不写更糟（字幕会装到错的作品上）——所以必须原样保持未识别。
    const row = db.prepare('SELECT work_id, work_id_source FROM files WHERE work_dir = ?').get(WORK_DIR) as any
    expect(row.work_id).toBeNull()
    expect(row.work_id_source).toBeNull()
    expect(db.prepare('SELECT COUNT(*) AS n FROM works').get()).toEqual({ n: 0 })
    db.close()
  })

  it('🔴 目录已识别 → 404（不许用人工请求改绑一部已有证据链的作品）', async () => {
    const db = openDb(':memory:')
    const handle = seedUnidentified(db)
    db.prepare("UPDATE files SET work_id = 'tmdb:1', work_id_source = 'auto' WHERE work_dir = ?").run(WORK_DIR)

    const r = await bindUnidentifiedDir({ db, tmdb: tmdbReturning(MATCHING_DETAILS) }, { handle, tmdbId: '439418' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unexpected ok')
    expect(r.status).toBe(404)
    db.close()
  })

  it('🔴 句柄解不开 → 400（且不碰 TMDB、不碰库）', async () => {
    const db = openDb(':memory:')
    seedUnidentified(db)
    const calls: string[] = []
    const r = await bindUnidentifiedDir({ db, tmdb: tmdbReturning(MATCHING_DETAILS, calls) }, { handle: '@@@', tmdbId: '439418' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unexpected ok')
    expect(r.status).toBe(400)
    expect(calls).toEqual([])
    db.close()
  })

  it('🔴 tmdbId 不是纯数字 → 400（防注入进 provider_ids 的 `tmdb:` 前缀）', async () => {
    const db = openDb(':memory:')
    const handle = seedUnidentified(db)
    for (const bad of ['', 'abc', '439418; DROP TABLE files', 'tmdb:1', ' 1']) {
      const r = await bindUnidentifiedDir({ db, tmdb: tmdbReturning(MATCHING_DETAILS) }, { handle, tmdbId: bad })
      expect(r.ok).toBe(false)
      if (r.ok) throw new Error(`unexpected ok for ${JSON.stringify(bad)}`)
      expect(r.status).toBe(400)
    }
    db.close()
  })

  it('🔴 TMDB 两种类型都查不到 → 502（TMDB 侧问题，不是用户的错）', async () => {
    const db = openDb(':memory:')
    const handle = seedUnidentified(db)
    const r = await bindUnidentifiedDir({ db, tmdb: tmdbReturning(null) }, { handle, tmdbId: '439418' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unexpected ok')
    expect(r.status).toBe(502)
    db.close()
  })

  it('✅ 推定类型猜错也能绑上（D-4 双向核验在人工路径同样生效）', async () => {
    // 扁平目录 + 无季标记 → 推定 movie；但用户选的其实是一部剧集。
    // 若人工路径绕开 D-4 的双向核验，这里会落 tmdb-404 —— 而"回退类型"正是它要救的场景。
    const db = openDb(':memory:')
    const workDir = '/media/影视/[爱情公寓] (2020)'
    const handle = seedUnidentified(db, workDir, ['01.mp4'])
    const calls: string[] = []
    const tmdb = {
      search: async () => [],
      getDetails: (async (mt: string) => {
        calls.push(mt)
        if (mt !== 'tv') return null
        return { id: 95897, title: 'iPartment', originalTitle: 'iPartment', year: 2020, genreIds: [], chineseTitles: ['爱情公寓'] } as any
      }) as IdentifyWorkerDeps['tmdb']['getDetails'],
    } as IdentifyWorkerDeps['tmdb']

    const r = await bindUnidentifiedDir({ db, tmdb }, { handle, tmdbId: '95897' })
    expect(calls).toEqual(['movie', 'tv'])
    expect(r.ok).toBe(true)
    const row = db.prepare('SELECT work_id, work_id_source FROM files WHERE work_dir = ?').get(workDir) as any
    expect(row.work_id).toBe('tmdb:95897')
    expect(row.work_id_source).toBe('human')
    db.close()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 撤销：这张网的全部价值在于"只认 human"
// ─────────────────────────────────────────────────────────────────────────────
describe('unbindUnidentifiedDir · 撤销闸只认 work_id_source = human', () => {
  it('🔴 混合目录（human + auto 各一行）→ 只清 human，agent 的判定原地不动', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/影视/混合 (2020)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, work_id_source, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/a.mkv`, workDir, 'a.mkv', 100, 1000, workDir, 'tmdb:9', 'human', 1000)
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, work_id_source, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/b.mkv`, workDir, 'b.mkv', 100, 1000, workDir, 'tmdb:9', 'auto', 1000)

    const r = unbindUnidentifiedDir({ db }, { handle: encodeWorkDirHandle(workDir) })
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error(r.error)
    expect(r.cleared).toBe(1)

    const human = db.prepare("SELECT work_id FROM files WHERE filename = 'a.mkv'").get() as any
    const auto = db.prepare("SELECT work_id FROM files WHERE filename = 'b.mkv'").get() as any
    expect(human.work_id).toBeNull()
    // 🔴 这是本测试文件的中心断言：agent 的判定不许被这个端点抹掉。
    expect(auto.work_id).toBe('tmdb:9')
    db.close()
  })

  it('撤销后目录回到未识别队列（work_id/source 都清空，不是只清一半）', async () => {
    const db = openDb(':memory:')
    const handle = seedUnidentified(db)
    await bindUnidentifiedDir({ db, tmdb: tmdbReturning(MATCHING_DETAILS) }, { handle, tmdbId: '439418' })

    const r = unbindUnidentifiedDir({ db }, { handle })
    expect(r.ok).toBe(true)
    const row = db.prepare('SELECT work_id, work_id_source FROM files WHERE work_dir = ?').get(WORK_DIR) as any
    expect(row.work_id).toBeNull()
    // 清一半会让下一轮队列谓词把这一行当成"已识别"而不再入队 —— 撤销就成了死路。
    expect(row.work_id_source).toBeNull()
    db.close()
  })

  it('🔴 没有人工绑定可撤 → 409（不静默成功：用户必须知道什么都没发生）', async () => {
    const db = openDb(':memory:')
    const workDir = '/media/影视/只有自动 (2020)'
    db.prepare(`INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, work_id_source, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(`${workDir}/a.mkv`, workDir, 'a.mkv', 100, 1000, workDir, 'tmdb:9', 'auto', 1000)

    const r = unbindUnidentifiedDir({ db }, { handle: encodeWorkDirHandle(workDir) })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unexpected ok')
    expect(r.status).toBe(409)
    const auto = db.prepare('SELECT work_id FROM files WHERE work_dir = ?').get(workDir) as any
    expect(auto.work_id).toBe('tmdb:9')
    db.close()
  })

  it('🔴 句柄解不开 → 400', () => {
    const db = openDb(':memory:')
    const r = unbindUnidentifiedDir({ db }, { handle: '' })
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unexpected ok')
    expect(r.status).toBe(400)
    db.close()
  })
})
