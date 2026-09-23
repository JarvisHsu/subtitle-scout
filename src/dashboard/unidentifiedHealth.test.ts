// src/dashboard/unidentifiedHealth.test.ts —— 「有几个目录我认不出来」的读出面。
//
// 本文件钉的是 unidentifiedHealth.ts 头注释里那几条**会被下一个人当成"顺手优化"改掉**的
// 裁决，尤其是：
//   ① 谓词**不含** identifyScheduler 的退避/404 条件（含 404 终态那批才是重点）；
//   ② 粒度是**目录**不是文件；
//   ③ 出目录名、**不出**绝对路径 / last_error / attempt / next_retry_at；
//      → D-5（2026-09-18）后 ③ 有一个**有意识**的收窄：多了 `handle`（base64url，可逆，
//        因此确实携带绝对路径）。破例的完整论证写在下方那条字段全集断言处——那里是下一个人
//        会来质疑的地方，所以理由写在**判据旁边**而不是只写在实现里。
//   ④ 上限截断时 dirCount 仍报全量（否则前端说不出"另外还有 N 个"）。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb, type ScoutDb } from '../v2/db.js'
import { buildUnidentifiedHealth, MAX_LISTED_DIRS } from './unidentifiedHealth.js'
import { encodeWorkDirHandle, resolveWorkDirHandle } from '../core/workDirHandle.js'

let db: ScoutDb
const NOW = 1_700_000_000_000

beforeEach(() => {
  db = openDb(':memory:')
})

function addFile(o: {
  path: string
  workDir: string
  workId?: string | null
  attempt?: number
  nextRetryAt?: number | null
  lastError?: string | null
}): void {
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, attempt, next_retry_at, last_error, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    o.path, o.workDir, 'f.mkv', 100, NOW, o.workDir, o.workId ?? null,
    o.attempt ?? 0, o.nextRetryAt ?? null, o.lastError ?? null, NOW,
  )
}

describe('buildUnidentifiedHealth', () => {
  it('库全部已识别 → dirCount 0 且 dirs 空（沉默即好消息，前端据此整段不渲染）', () => {
    db.prepare(
      `INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`,
    ).run('tmdb:1', 'Breaking Bad', 'tv', NOW, NOW)
    addFile({ path: '/m/bb/s1e1.mkv', workDir: '/m/bb', workId: 'tmdb:1' })

    expect(buildUnidentifiedHealth(db)).toEqual({ dirCount: 0, dirs: [] })
  })

  it('粒度是目录不是文件：一个目录 24 个未识别文件 → dirCount 1、fileCount 24', () => {
    for (let i = 1; i <= 24; i++) {
      addFile({ path: `/m/Unknown Show/e${i}.mkv`, workDir: '/m/Unknown Show' })
    }

    const out = buildUnidentifiedHealth(db)
    expect(out.dirCount).toBe(1)
    // `handle` 是 D-5 加进来的机器指针（不是给人看的读数）；它为什么不算"排障噪音泄漏"，
    // 论证写在下方那条字段全集断言处，不在这里重复。
    expect(out.dirs).toEqual([{
      dirName: 'Unknown Show', fileCount: 24, handle: encodeWorkDirHandle('/m/Unknown Show'),
      // P6：没有 identify-no-match 留痕 ⇒ 归 transient（"这一轮没成"，不是"搜遍了没找到"）
      reason: 'transient',
    }])
  })

  // 🔴 本文件最重要的一条：404 终态那批**永不再进识别队列**（identifyScheduler.ts:37
  // 的谓词把它们永久排除），恰恰是用户最需要知道的——其余的每天还会自动重试一次。
  // 若照抄调度谓词来算展示数字，这批文件在界面上也会永久消失，那正是本模块要修的病。
  it('🔴 含 tmdb-404 终态与退避窗未到的目录——谓词只看 work_id IS NULL', () => {
    addFile({
      path: '/m/Dead 404/e1.mkv', workDir: '/m/Dead 404',
      lastError: 'tmdb-404', attempt: 3, nextRetryAt: null,
    })
    addFile({
      path: '/m/Backing Off/e1.mkv', workDir: '/m/Backing Off',
      lastError: 'identify-failed', attempt: 5, nextRetryAt: NOW + 86_400_000,
    })
    addFile({ path: '/m/Fresh/e1.mkv', workDir: '/m/Fresh' })

    const out = buildUnidentifiedHealth(db)
    expect(out.dirCount).toBe(3)
    expect(out.dirs.map((d) => d.dirName).sort()).toEqual(['Backing Off', 'Dead 404', 'Fresh'])
  })

  // R-F9/R-F10：排障读数不进界面。这条断言直接钉 DTO 的**字段全集**——谁往里加
  // lastError/attempt/nextRetryAt/path，这里当场红，并在失败信息里指回那条裁决。
  it('🔴 只出 dirName + fileCount：不出绝对路径 / last_error / attempt / next_retry_at', () => {
    addFile({
      path: '/hostroot/media/test-library/TV/Mystery/e1.mkv',
      workDir: '/hostroot/media/test-library/TV/Mystery',
      lastError: 'evidence-fail: title mismatch', attempt: 7, nextRetryAt: NOW + 1,
    })

    const out = buildUnidentifiedHealth(db)
    expect(out.dirs).toHaveLength(1)
    // 字段全集恒等——多一个字段这条就红。
    //
    // D-5（2026-09-18）`handle` 进来了，这是**一次有意识的破例**，不是漂移。理由写在判据旁边：
    //   · 那三条裁决反对的是"**给人看**的排障噪音"，不是"机器不能有指针"。`dirName` 仍是给人
    //     看的那一个；`handle` 只回答"POST 该指向哪个目录"，前端不解释它、只原样回传。
    //   · 代价必须写明白：句柄是 base64url，**可逆**——它确实携带绝对路径。仍然接受的三个理由：
    //     (a) 它不是明文，不会在界面上被当成排障信息读出来；(b) 能看到它的人已过 dashboard 鉴权，
    //     而媒体根路径本来就是这个人自己配的；(c) 它**不是权限凭据**——能不能绑、能不能撤全由
    //     服务端另行判定（目录必须真的未识别；撤销只认 work_id_source='human'）。见
    //     src/core/workDirHandle.ts 头注释的完整论证。
    //   · 若将来有人想把绝对路径**直接**塞进 DTO 而不编码，下面三条 JSON 断言会当场红——那才是
    //     这条裁决真正要拦的东西，句柄没有绕过它。
    //   · P6（2026-09-23）加了 `reason`（`'exhausted' | 'transient'`）。**它不破例**：
    //     它不是一个排障读数，而是一个**归类**——决定界面上说"改名帮不上忙"还是"会自动重试"。
    //     它与 `last_error` 原文的区别正在这里：`last_error` 是给排障的人看的字符串（
    //     `evidence-fail: …` / LLM 异常串），而 `reason` 是把它折成**用户能据以行动的两档**。
    //     下面那三条"不许出现"的 JSON 断言仍然独立地守着原文不外泄。
    expect(Object.keys(out.dirs[0]!).sort()).toEqual(['dirName', 'fileCount', 'handle', 'reason'])
    // 目录名是最后一段，挂载点前缀不出去（对用户零信息量，且是容器内路径）。
    expect(out.dirs[0]!.dirName).toBe('Mystery')
    const json = JSON.stringify(out)
    expect(json).not.toContain('hostroot')
    expect(json).not.toContain('evidence-fail')
    expect(json).not.toContain('test-library')
  })

  it('D-5：handle 能**回指** work_dir，但明文路径片段不出 JSON', () => {
    addFile({ path: '/hostroot/media/test-library/TV/Mystery/e1.mkv', workDir: '/hostroot/media/test-library/TV/Mystery' })

    const h = buildUnidentifiedHealth(db).dirs[0]!.handle
    expect(h).toBeTruthy()
    // 机器指针的正确性判据：解出来必须**正好**是库里那个 work_dir。
    // 差一个字符，绑定端点就会去查一个不存在的目录、把一次正确的用户操作报成 404。
    expect(resolveWorkDirHandle(h, ['/hostroot/media/test-library/TV/Mystery'])).toBe('/hostroot/media/test-library/TV/Mystery')
    // 而它是编码过的——明文片段不出现在响应体里（与上一条字段全集断言共同构成破例的边界）。
    expect(h).not.toContain('/')
    expect(h).not.toContain('hostroot')
    expect(JSON.stringify(buildUnidentifiedHealth(db))).not.toContain('/hostroot')
  })

  it('文件多的目录排前面（用户先看到最值得改名的那个）', () => {
    addFile({ path: '/m/Small/e1.mkv', workDir: '/m/Small' })
    for (let i = 1; i <= 5; i++) addFile({ path: `/m/Big/e${i}.mkv`, workDir: '/m/Big' })

    const out = buildUnidentifiedHealth(db)
    expect(out.dirs.map((d) => d.dirName)).toEqual(['Big', 'Small'])
  })

  it('超过上限：dirs 截断到 MAX_LISTED_DIRS，dirCount 仍报全量', () => {
    const total = MAX_LISTED_DIRS + 5
    for (let i = 0; i < total; i++) {
      addFile({ path: `/m/D${i}/e1.mkv`, workDir: `/m/D${i}` })
    }

    const out = buildUnidentifiedHealth(db)
    expect(out.dirCount).toBe(total)
    expect(out.dirs).toHaveLength(MAX_LISTED_DIRS)
  })

  // ── 🔴 P6（第 57 轮，2026-09-23）：按"我们到底试到什么程度"分档 ──────────────────
  // 修的是什么：界面上原来只有一句通用话（"目录名清晰可辨最有帮助；改名后下轮会重试"），
  // 它对两种完全不同的处境说同一件事，而两种都是误导：
  //   · agent 已经搜遍了（改名白费力气，该走"指定作品"）
  //   · 这一轮没成（用户什么都不用做，会自动重试）
  describe('P6 · reason 两档', () => {
    /** 造一条 agent「搜遍了」的留痕（第 53 轮接上的那条 runs 通道）。 */
    function addNoMatchRun(workDir: string): void {
      db.prepare(
        `INSERT INTO runs (job_id, started_at, finished_at, decision, detail, journal_path)
         VALUES (NULL, ?, ?, 'identify-no-match', ?, NULL)`,
      ).run(NOW, NOW, `${workDir}: 目录名是噪声串，全名与去噪变体在 movie/tv 均返回 0 条`)
    }

    it('🔴 有 identify-no-match 留痕 → exhausted（agent 说搜遍了）', () => {
      addFile({ path: '/m/Searched/e1.mkv', workDir: '/m/Searched', lastError: 'identify-failed' })
      addNoMatchRun('/m/Searched')
      expect(buildUnidentifiedHealth(db).dirs[0]!.reason).toBe('exhausted')
    })

    it('🔴 没有留痕（瞬时失败/超时）→ transient（**不**敢说"我们搜遍了"）', () => {
      addFile({ path: '/m/Flaky/e1.mkv', workDir: '/m/Flaky', lastError: 'identify-failed' })
      expect(buildUnidentifiedHealth(db).dirs[0]!.reason).toBe('transient')
    })

    it('🔴 留痕是**别的目录**的 → 不串味（按 work_dir 前缀精确匹配）', () => {
      addFile({ path: '/m/Mine/e1.mkv', workDir: '/m/Mine', lastError: 'identify-failed' })
      addNoMatchRun('/m/Somebody Else')   // 另一个目录搜遍了
      expect(buildUnidentifiedHealth(db).dirs[0]!.reason, '别人的结论不许贴到我头上').toBe('transient')
    })

    it('前缀匹配精确到 `: `（兄弟目录 /m/Show2 的留痕不许命中 /m/Show）', () => {
      addFile({ path: '/m/Show/e1.mkv', workDir: '/m/Show', lastError: 'identify-failed' })
      addNoMatchRun('/m/Show2')
      // `/m/Show:%` 不匹配 `/m/Show2: …` ⇒ 不会被兄弟目录的结论污染
      expect(buildUnidentifiedHealth(db).dirs[0]!.reason).toBe('transient')
    })

    it('tmdb-404 终态（TMDB 上确实没有）也算 exhausted 吗——**不算**，留痕才是唯一凭据', () => {
      // 404 只说明"两种类型都查过、TMDB 没这部作品"，而我们**没有** agent 那份"全名+变体都搜过"
      // 的结论。宁可少说，也不要把"没搜到"说成"搜遍了"。
      addFile({ path: '/m/Dead/e1.mkv', workDir: '/m/Dead', lastError: 'tmdb-404', nextRetryAt: null })
      expect(buildUnidentifiedHealth(db).dirs[0]!.reason).toBe('transient')
    })
  })

  it('work_dir 末尾带分隔符 → 取最后一个非空段，不返回空串', () => {
    addFile({ path: '/m/Trailing/e1.mkv', workDir: '/m/Trailing/' })

    expect(buildUnidentifiedHealth(db).dirs[0]!.dirName).toBe('Trailing')
  })
})
