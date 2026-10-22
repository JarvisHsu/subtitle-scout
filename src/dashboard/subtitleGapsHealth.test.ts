// subtitleGapsHealth 的用例：这条读数存在的唯一理由是"用户能看见、能据此行动"，
// 故每条用例都盯一个"会误导用户"的失败模式。
import { describe, it, expect, beforeEach } from 'vitest'
import { openDb } from '../v2/db.js'
import { buildSubtitleGaps, MAX_LISTED_GAPS } from './subtitleGapsHealth.js'

const NOW = 1_000_000_000_000
let db: ReturnType<typeof openDb>

beforeEach(() => {
  db = openDb(':memory:')
  db.prepare(`INSERT INTO works (id, title, media_type, created_at, updated_at) VALUES (?,?,?,?,?)`)
    .run('tmdb:1', 'Show', 'tv', NOW, NOW)
})

function add(o: {
  filename: string
  workId?: string | null
  season?: number | null
  episode?: number | null
  needs?: number | null
  status?: string | null
  attempt?: number
  recheckAfter?: number | null
  lastError?: string | null
}): void {
  db.prepare(
    `INSERT INTO files (path, dir, filename, size, mtime, work_dir, work_id, season, episode,
                        needs_subtitle, sub_status, sub_attempt, recheck_after, last_error, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    `/m/${o.filename}`, '/m', o.filename, 100, NOW, '/m',
    o.workId === undefined ? 'tmdb:1' : o.workId,
    o.season ?? 1, o.episode ?? 1,
    o.needs === undefined ? 1 : o.needs,
    o.status === undefined ? null : o.status,
    o.attempt ?? 0, o.recheckAfter === undefined ? null : o.recheckAfter,
    o.lastError === undefined ? null : o.lastError, NOW,
  )
}

describe('buildSubtitleGaps · 只报"试过但没有"的', () => {
  it('🔴 还没排队（attempt=0 且 status NULL）**不报** —— 那是正常等待，混进来会让人以为系统全挂了', () => {
    add({ filename: 'queued.mkv', attempt: 0 })
    expect(buildSubtitleGaps(db)).toEqual({ count: 0, files: [] })
  })

  it('🔴 已 covered 的不报', () => {
    add({ filename: 'done.mkv', status: 'covered', attempt: 3 })
    expect(buildSubtitleGaps(db)).toEqual({ count: 0, files: [] })
  })

  it('试过但仍 NULL / 已停牌 → 报', () => {
    add({ filename: 'tried.mkv', attempt: 1, lastError: 'sub:retry-later' })
    add({ filename: 'parked.mkv', status: 'unsolvable', attempt: 7, lastError: 'sub:no-outcome' })
    const out = buildSubtitleGaps(db)
    expect(out.count).toBe(2)
    expect(out.files.map((f) => f.filename).sort()).toEqual(['parked.mkv', 'tried.mkv'])
  })

  it('needs_subtitle=0（不需要字幕）不报', () => {
    add({ filename: 'nope.mkv', needs: 0, attempt: 3, status: 'unsolvable' })
    expect(buildSubtitleGaps(db).count).toBe(0)
  })
})

describe('buildSubtitleGaps · 四档原因', () => {
  it('🔴 sub:retry-later → source-silent；sub:no-outcome → no-match；sub:timeout → timeout', () => {
    add({ filename: 'a.mkv', attempt: 1, lastError: 'sub:retry-later' })
    add({ filename: 'b.mkv', attempt: 1, lastError: 'sub:no-outcome' })
    add({ filename: 'c.mkv', attempt: 1, lastError: 'sub:timeout' })
    const by = Object.fromEntries(buildSubtitleGaps(db).files.map((f) => [f.filename, f.reason]))
    expect(by).toEqual({ 'a.mkv': 'source-silent', 'b.mkv': 'no-match', 'c.mkv': 'timeout' })
  })

  it('handoff_translate → awaiting-translate（**且不可催**：归翻译台，点了会被拒）', () => {
    add({ filename: 't.mkv', status: 'handoff_translate', attempt: 7, lastError: 'sub:no-outcome' })
    const f = buildSubtitleGaps(db).files[0]!
    expect(f.reason).toBe('awaiting-translate')
    expect(f.retryable, 'handoff_translate 归翻译台，planSubtitleFetch 会跳过它').toBe(false)
  })

  it('认识的原因之外 → other（**不猜**，不硬塞进某一档）', () => {
    add({ filename: 'x.mkv', attempt: 1, lastError: 'evidence-fail: title mismatch' })
    expect(buildSubtitleGaps(db).files[0]!.reason).toBe('other')
  })

  it('unsolvable 可催（planSubtitleFetch 会把它 revive 到当下）', () => {
    add({ filename: 'u.mkv', status: 'unsolvable', attempt: 7, lastError: 'sub:no-outcome' })
    expect(buildSubtitleGaps(db).files[0]!.retryable).toBe(true)
  })
})

describe('buildSubtitleGaps · 排序与截断', () => {
  it('🔴 下次重试**最早**的排前面（最快会有结果的最该先被看到），没排期的排最后', () => {
    add({ filename: 'far.mkv', attempt: 1, recheckAfter: NOW + 86_400_000 })
    add({ filename: 'nosched.mkv', attempt: 1, recheckAfter: null })
    add({ filename: 'soon.mkv', attempt: 1, recheckAfter: NOW + 60_000 })
    expect(buildSubtitleGaps(db).files.map((f) => f.filename))
      .toEqual(['soon.mkv', 'far.mkv', 'nosched.mkv'])
  })

  it('超过上限：files 截断，count 报全量（不许拿 files.length 当总数）', () => {
    const total = MAX_LISTED_GAPS + 3
    for (let i = 0; i < total; i++) add({ filename: `f${i}.mkv`, attempt: 1, recheckAfter: NOW + i * 1000 })
    const out = buildSubtitleGaps(db)
    expect(out.count).toBe(total)
    expect(out.files).toHaveLength(MAX_LISTED_GAPS)
  })

  it('works 行缺席 → title 为 null（不编一个标题），workId 仍给（重试要靠它）', () => {
    add({ filename: 'orphan.mkv', workId: null, attempt: 1 })
    const f = buildSubtitleGaps(db).files[0]!
    expect(f.title).toBeNull()
    // workId 空 ⇒ 无法按作品重试，故 retryable 必须是 false（不画点了会失败的按钮）
    expect(f.retryable).toBe(false)
  })
})
