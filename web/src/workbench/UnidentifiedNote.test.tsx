// web/src/workbench/UnidentifiedNote.test.tsx —— 认不出来的目录**画出来之后**长什么样。
//
// ── 与 rootHealthWiring.test.tsx 的分工 ────────────────────────────────────
// 那个测**链条真的接上了**（端到端 HTTP 桩 → Shell → DOM，变异恒空要能红）；
// 这个测**渲染纪律**：
//  · dirCount 为 0 / DTO 缺席时一个字都不占屏（沉默即好消息）
//  · 信息量边界：目录名出、排障读数一律不出（R-F9/R-F10）
//  · 零排障操作面（**R-F1 已于 2026-09-18 被提案第 8 组部分推翻**——见文件尾部那一节；
//    现在只剩「指定作品」一个动作，当年被否掉的「重新识别」「忽略」依然不许加回来）
//  · Carbon 双通道：文字自己说全 + 形状（空心方块），颜色只是第三重
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, within, fireEvent, waitFor } from '@testing-library/react'
import { I18nProvider } from '../i18n/useT.js'
import { en } from '../i18n/en.js'
import { UnidentifiedNote } from './UnidentifiedNote.js'
import { prefillFromDir } from './IdentifyBindDialog.js'
import { api } from '../api/client.js'
import type { UnidentifiedHealthDTO } from '../api/types.js'

afterEach(cleanup)

declare const __STYLES_CSS__: string

function renderNote(u: UnidentifiedHealthDTO | null) {
  return render(<I18nProvider initialLang="en"><UnidentifiedNote unidentified={u} /></I18nProvider>)
}

describe('UnidentifiedNote · 沉默即好消息', () => {
  it('dirCount 为 0 → **什么都不渲染**（认得出来的库不占屏）', () => {
    const { container } = renderNote({ dirCount: 0, dirs: [] })
    expect(container.textContent).toBe('')
  })

  it('DTO 缺席（/health 还没回来）→ 什么都不渲染，**不报"都认出来了"**', () => {
    // fail-open 报绿正是这整条链要防的那句假话（同 RootHealthNote 的既有论证）。
    const { container } = renderNote(null)
    expect(container.textContent).toBe('')
  })
})

describe('UnidentifiedNote · 说什么（信息量边界：R-F9/R-F10 排障不推给用户）', () => {
  it('说后果 + 说该干什么（`title (year)`），并列出目录名', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'Unknown Show', fileCount: 24 }] })
    const line = screen.getByTestId('wb-unidentified-line')
    expect(line.textContent).toContain(en.unidentified_note)
    expect(line.textContent).toContain('Unknown Show')
  })

  // 🔴 R-F1 的下半句「底线是按 title (year) 命名」必须真的出现在用户眼前——
  // 界面上没有任何按钮，不说清格式这条提示就只是在报忧。
  it('🔴 文案里带着 `title (year)` 这个可执行的格式', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    expect(screen.getByTestId('wb-unidentified-line').textContent).toMatch(/title.*year/i)
  })

  // 2026-08-27 实测（用户第一次真人跑 setup）：旧文案「rename them to "title (year)" and
  // they'll be picked up」在两处撒谎——① 识别是 agent 做的，title (year) 不是必需格式
  // （裸 title 也能认），说"改成这个格式就能处理"对着一个本来就是 title (year) 只是括号
  // 全角的目录，用户无从照办；② "就能处理"是没有的承诺。诚实版：格式只是"最有帮助"，
  // 且说清改名之后发生什么（下轮自动检查会重试）。
  it('🔴 文案说真话：格式是建议不是必需（helps，不承诺 picked up），且交代改名后下轮会重试', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    const text = screen.getByTestId('wb-unidentified-line').textContent ?? ''
    expect(text).not.toMatch(/rename them to .+ and they'll be picked up/i)
    expect(text).toMatch(/helps/i)
    expect(text).toMatch(/retr/i) // retry / retried
  })

  it('多个目录逗号分隔，同前缀的两个也能区分', () => {
    renderNote({ dirCount: 2, dirs: [
      { dirName: 'Show S01', fileCount: 3 },
      { dirName: 'Show S02', fileCount: 4 },
    ] })
    const text = screen.getByTestId('wb-unidentified-line').textContent ?? ''
    expect(text).toContain('Show S01')
    expect(text).toContain('Show S02')
  })

  it('截断：说"另外还有 N 个"，N = dirCount - dirs.length（不是 dirs.length）', () => {
    renderNote({ dirCount: 30, dirs: Array.from({ length: 8 }, (_, i) => ({ dirName: `D${i}`, fileCount: 1 })) })
    expect(screen.getByTestId('wb-unidentified-more').textContent).toContain('22')
  })

  it('没截断（dirCount === dirs.length）→ 不出现那条尾巴', () => {
    renderNote({ dirCount: 2, dirs: [
      { dirName: 'A', fileCount: 1 }, { dirName: 'B', fileCount: 1 },
    ] })
    expect(screen.queryByTestId('wb-unidentified-more')).toBeNull()
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 R-F1：未识别资源不给用户改
// ══════════════════════════════════════════════════════════════════════════════
describe('🔴 零操作面（R-F1）', () => {
  it('没有按钮、没有链接、没有输入框', () => {
    renderNote({ dirCount: 3, dirs: [{ dirName: 'Unknown Show', fileCount: 24 }] })
    const line = screen.getByTestId('wb-unidentified-line')
    expect(within(line).queryByRole('button')).toBeNull()
    expect(within(line).queryByRole('link')).toBeNull()
    expect(within(line).queryByRole('textbox')).toBeNull()
    expect(line.querySelector('button, a, input, select')).toBeNull()
  })

  it('不是 alert（这是背景事实，不是打断用户的故障）', () => {
    renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByTestId('wb-unidentified-line')).toHaveAttribute('aria-live', 'polite')
  })
})

// ══════════════════════════════════════════════════════════════════════════════
// 🔴 Carbon 双通道
// ══════════════════════════════════════════════════════════════════════════════
describe('Carbon 双通道：形状 + 文字，颜色只是第三重', () => {
  it('形状是**空心**方块——语气与 root_health_unknown 同档，不是 failed 的告警档', () => {
    // 这不是故障（库是好的、目录读得到，只是名字没按规范写）。用实心/amber
    // 会把"你该改个名"说成"你的库坏了"。
    const { container } = renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    const mark = container.querySelector('[data-testid="wb-unidentified-line"] .root-health-mark')
    expect(mark).not.toBeNull()
    expect(mark!.className).toContain('root-health-mark-hollow')
    expect(screen.getByTestId('wb-unidentified-line')).toHaveAttribute('data-kind', 'unknown')
  })

  it('🔴 CSS 侧：复用的那两个类真的存在（形状通道不是空头支票）', () => {
    // 复用 root-health-mark 一族是刻意的（不发明第五个符号）。但"复用"必须是真的——
    // 哪天那两条规则被改名/删掉，本组件的形状通道会静默消失，只剩颜色。
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    expect(/\.root-health-mark\s*\{/.test(bare), '.root-health-mark 规则不存在').toBe(true)
    expect(/\.root-health-mark-hollow\s*\{/.test(bare), '.root-health-mark-hollow 规则不存在').toBe(true)
  })

  // 2026-08-27 实测截图：说明文字与目录名列表贴太近，人眼费力分辨哪里是话的结尾、
  // 哪里是名单的开头。目录名单前要有明确间距（跟随状态条的 12px 列距刻度）。
  it('🔴 CSS 侧：目录名单与说明文字之间有明确间距（wb-unidentified-paths 规则存在且元素挂着它）', () => {
    const { container } = renderNote({ dirCount: 1, dirs: [{ dirName: 'x', fileCount: 1 }] })
    const paths = container.querySelector('[data-testid="wb-unidentified-line"] .root-health-paths')
    expect(paths).not.toBeNull()
    expect(paths!.className).toContain('wb-unidentified-paths')
    const bare = (__STYLES_CSS__ as string).replace(/\/\*[\s\S]*?\*\//g, '')
    const m = bare.match(/\.wb-unidentified-paths\s*\{([^}]*)\}/)
    expect(m, '.wb-unidentified-paths 规则不存在').not.toBeNull()
    expect(m![1]).toMatch(/margin-left\s*:/)
  })

  it('🔴 文字是主通道：去掉全部 CSS 之后信息量一个字不少', () => {
    // jsdom 本来就不加载 styles.css——这条断言测的正好是"裸 DOM 文本"。
    const { container } = renderNote({ dirCount: 9, dirs: [{ dirName: 'Unknown Show', fileCount: 24 }] })
    const text = container.textContent ?? ''
    expect(text).toContain(en.unidentified_note)
    expect(text).toContain('Unknown Show')
    expect(text).toContain('8')  // 另外还有 8 个
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// 提案第 8 组（2026-09-18）：目录名变成「指定作品」的入口。
//
// ⚠️ 本文件头部原先写着「零操作面（R-F1「未识别资源不给用户改」）」——**那条已被本组推翻**。
// 推翻依据：R-F1 那段的原话是"这条提示对应的动作在**用户的机器上**，界面上没有任何按钮
// 能替他做"。人工绑定（D-5）落地后这个前提不成立。但 R-F1 否掉的另外两个按钮
//（「重新识别」「忽略」）**依然不许加回来**——它们不改变任何输入，只重跑或压制。
// 下面最后一例就是钉这一条的。
// ─────────────────────────────────────────────────────────────────────────────
vi.mock('../api/client.js', () => ({
  posterUrl: (p: string | null) => p,
  api: { tmdbSearch: vi.fn(), identifyBind: vi.fn() },
}))

describe('UnidentifiedNote · 人工指定作品（提案第 8 组）', () => {
  const HANDLE = 'zc2NPZAcM-rg5sQlIALfl1rrdFVIagnfvieK4D--w6E'   // 43 字符，形状合法

  function renderWithHandle(u: UnidentifiedHealthDTO, onBound?: () => void) {
    return render(
      <I18nProvider initialLang="en">
        <UnidentifiedNote unidentified={u} onBound={onBound} />
      </I18nProvider>,
    )
  }

  it('handle 在 → 目录名渲染成**按钮**（可点）', () => {
    renderWithHandle({ dirCount: 1, dirs: [{ dirName: 'Mystery', fileCount: 3, handle: HANDLE }] })
    const btn = screen.getByTestId('wb-unidentified-dir-0')
    expect(btn.tagName).toBe('BUTTON')
    expect(btn.textContent).toContain('Mystery')
    expect(screen.queryByTestId('wb-unidentified-plain-0')).toBeNull()
  })

  it('🔴 handle 缺席 → 降级成**纯文本**，绝不渲一个点了会 400 的按钮', () => {
    renderWithHandle({ dirCount: 1, dirs: [{ dirName: 'Mystery', fileCount: 3 }] })
    expect(screen.queryByTestId('wb-unidentified-dir-0')).toBeNull()
    expect(screen.getByTestId('wb-unidentified-plain-0').textContent).toContain('Mystery')
    // 而且整条提示照旧显示——"有几个目录认不出来"这个结论不依赖 handle。
    expect(screen.getByTestId('wb-unidentified-line').textContent).toContain('Mystery')
  })

  it('点击目录名 → 打开弹窗，检索词已按目录名预填', async () => {
    renderWithHandle({ dirCount: 1, dirs: [{ dirName: '[毒枭][全1-3季].Narcos.S01', fileCount: 9, handle: HANDLE }] })
    fireEvent.click(screen.getByTestId('wb-unidentified-dir-0'))
    const dlg = await screen.findByTestId('bind-dialog')
    // 预填只剥括号分组与扩展名，不做片名猜测（见 prefillFromDir 的论证）。
    const input = within(dlg).getByTestId('bind-query') as HTMLInputElement
    expect(input.value).toBe('Narcos S01')
  })

  it('🔴 搜索失败与查无结果**在界面上可区分**（提案 8.2 明文要求）', async () => {
    vi.mocked(api.tmdbSearch).mockRejectedValueOnce(new Error('boom'))
    renderWithHandle({ dirCount: 1, dirs: [{ dirName: 'X', fileCount: 1, handle: HANDLE }] })
    fireEvent.click(screen.getByTestId('wb-unidentified-dir-0'))
    await screen.findByTestId('bind-dialog')

    fireEvent.click(screen.getByTestId('bind-search'))
    // 「没问成」→ 失败态，且带上原因
    const failed = await screen.findByTestId('bind-search-failed')
    expect(failed.textContent).toContain('boom')
    expect(screen.queryByTestId('bind-no-results')).toBeNull()

    // 「问到了、没有」→ 另一条文案，且**不**出现失败态
    vi.mocked(api.tmdbSearch).mockResolvedValueOnce({ results: [] })
    fireEvent.click(screen.getByTestId('bind-search'))
    await screen.findByTestId('bind-no-results')
    expect(screen.queryByTestId('bind-search-failed')).toBeNull()
  })

  it('🔴 绑定失败 → 展示**服务端原话**，不换一句自己编的"绑定失败"', async () => {
    vi.mocked(api.tmdbSearch).mockResolvedValueOnce({
      results: [{ id: 603, name: 'The Matrix', year: 1999, posterPath: null }],
    })
    // 服务端 422 的原话（`verifyEvidence` 没过）——调用方必须原样透出，
    // 因为"你的 id 没过机械核验（可换一个再试）"与"这个目录已经被识别了"
    // 给用户的下一步动作完全不同。
    vi.mocked(api.identifyBind).mockRejectedValueOnce(
      new Error('evidence-fail: title mismatch: candidate="The Matrix" vs dir="Mystery"'),
    )
    renderWithHandle({ dirCount: 1, dirs: [{ dirName: 'Mystery', fileCount: 1, handle: HANDLE }] })
    fireEvent.click(screen.getByTestId('wb-unidentified-dir-0'))
    await screen.findByTestId('bind-dialog')

    fireEvent.click(screen.getByTestId('bind-search'))
    fireEvent.click(await screen.findByTestId('bind-hit-603'))

    const err = await screen.findByTestId('bind-error')
    expect(err.textContent).toContain('evidence-fail: title mismatch')
    expect(api.identifyBind).toHaveBeenCalledWith(HANDLE, '603')
  })

  it('绑定成功 → 回调 onBound（调用方据此重拉 /health）并关闭弹窗', async () => {
    const onBound = vi.fn()
    vi.mocked(api.tmdbSearch).mockResolvedValueOnce({
      results: [{ id: 1399, name: 'Game of Thrones', year: 2011, posterPath: null }],
    })
    vi.mocked(api.identifyBind).mockResolvedValueOnce({ ok: true, tmdbId: '1399', written: 3 })
    renderWithHandle({ dirCount: 1, dirs: [{ dirName: 'GOT', fileCount: 3, handle: HANDLE }] }, onBound)
    fireEvent.click(screen.getByTestId('wb-unidentified-dir-0'))
    await screen.findByTestId('bind-dialog')

    fireEvent.click(screen.getByTestId('bind-search'))
    fireEvent.click(await screen.findByTestId('bind-hit-1399'))

    await waitFor(() => expect(onBound).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(screen.queryByTestId('bind-dialog')).toBeNull())
  })

  it('🔴 R-F1 仍然生效：本组件**只有**这一个动作，没有"重新识别"也没有"忽略"', () => {
    // 这条防的是"既然能加按钮了，那把当年被否掉的两个也加回来吧"。
    // 它们的共同问题：**不改变任何输入**——一个拿同样的字节重跑同一个 agent（真实效果是
    // 让用户付费重摇 LLM），一个往库里写"用户说不用管"（正是 R-F1 禁的那种"改"）。
    // 要加新按钮，先回答"它改变了什么输入"。
    renderWithHandle({ dirCount: 1, dirs: [{ dirName: 'Mystery', fileCount: 3, handle: HANDLE }] })
    const line = screen.getByTestId('wb-unidentified-line')
    expect(within(line).getAllByRole('button')).toHaveLength(1)   // 只有目录名那一个
    const text = line.textContent ?? ''
    expect(text).not.toMatch(/re-?identify|ignore/i)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// prefillFromDir：**便利，不是判据**（见 IdentifyBindDialog 文件头约束③）。
// 只剥括号分组与已知媒体扩展名，绝不尝试判断"哪个片段才是片名"——那是识别轨的职责，
// 前端复刻一份必然漂移（C30）。
// ─────────────────────────────────────────────────────────────────────────────
describe('prefillFromDir', () => {
  it('剥掉方括号分组（中文全角与半角都要）', () => {
    expect(prefillFromDir('[毒枭][全1-3季][内嵌多国字幕]')).toBe('毒枭 全1-3季 内嵌多国字幕')
    expect(prefillFromDir('【高清剧集网发布 www.BBHDTV.com】藏锋[杜比视界版本]')).toBe('藏锋')
  })

  it('🔴 保住年份：`.2020` **不许**被当成扩展名吃掉', () => {
    // 第一版用 `/\.([A-Za-z0-9]{2,4})$/` 剥扩展名，它会把 `.S01` 与 `.2020` 一起吃掉。
    // 年份对 TMDB 检索很有用（同名作品靠它区分），白吃一个年份等于让用户自己补回来。
    expect(prefillFromDir('The.Matrix.1999')).toBe('The Matrix 1999')
    expect(prefillFromDir('Show.S01')).toBe('Show S01')
  })

  it('剥掉真正的媒体/字幕扩展名', () => {
    expect(prefillFromDir('Movie.2020.2160p.WEB-DL.mkv')).toBe('Movie 2020 2160p WEB-DL')
    expect(prefillFromDir('Ep01.zh-Hans.ass')).toBe('Ep01 zh-Hans')
  })

  it('整串都在括号里 → 只去括号**字符**、保留词（不退回带括号的原串）', () => {
    // 第一版直接退回原目录名，等于把一个括号最密的串原样丢进搜索框——那串里全是发布组
    // 噪音，用户得自己删半天。仍然**不猜**哪个括号里才是片名（那是识别轨的职责，C30）。
    expect(prefillFromDir('[全1-3季]')).toBe('全1-3季')
    expect(prefillFromDir('[毒枭]')).toBe('毒枭')
    expect(prefillFromDir('')).toBe('')
  })

  it('下划线也当分隔符（发布组惯例）', () => {
    expect(prefillFromDir('Some_Movie_2020')).toBe('Some Movie 2020')
  })
})