// web/src/workbench/IdentifyBindDialog.tsx —— 提案第 8 组：把认不出来的目录**人工指定**到 TMDB 作品。
//
// ══════════════════════════════════════════════════════════════════════════════
// 这一步填的是哪个洞
// ══════════════════════════════════════════════════════════════════════════════
// D-2/D-3/D-4 修的是**机械判据**（标题门、文件名证据、双向类型核验）。但判据再宽也架不住
// agent 一开始就搜错了作品——那时用户需要一个"就是它"的开关，而此前**一个都没有**
// （提案原话：「人工介入通道为零……用户当前唯一的手动手段是去文件管理器改目录名」）。
//
// 服务端端点 `POST /api/v2/identify/bind` 已由 D-5 提供；本组件是它的**可见形态**。
//
// ── 三条不可动摇的设计约束 ────────────────────────────────────────────────────
// ① **用户选定的 id 不是免检通道**。服务端会拿它过完整的 `verifyEvidence`（D-2/D-3/D-4 的
//    全部证据腿）。所以本组件**必须把服务端那句 error 原样展示**，绝不自己编一句
//    "绑定失败"——"你的 id 没过机械核验（可换一个再试）"与"这个目录已经被识别了"
//    给用户的下一步动作完全不同。自编文案会把两种可区分的状态压成一句无用的话。
// ② **搜索失败 ≠ 查无结果**（提案 8.2 明文要求界面上可区分）。两者都是"列表是空的"，
//    但一个是"没问成"、一个是"问到了，没有"。前者该让用户重试，后者该让用户换检索词。
//    把它们渲成同一句话是本仓反复栽过的"把中间量当结论量"。
// ③ **检索词只是预填，不做"猜片名"**。下面那个 `prefillFromDir` 是**便利**，不是判据：
//    它只剥掉方括号分组与扩展名，绝不尝试判断"哪个片段才是片名"——那是识别轨的职责，
//    前端复刻一份必然漂移（C30 老教训）。用户看到的输入框随时可改。
import { useState } from 'react'
import { Button } from '../components/ui/button.js'
import { Input } from '../components/ui/input.js'
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '../components/ui/dialog.js'
import { api, posterUrl } from '../api/client.js'
import type { TmdbSearchResultDTO } from '../api/types.js'
import { useT } from '../i18n/useT.js'

/** 从目录名预填一个检索词。**只剥括号分组与已知媒体扩展名，不做片名猜测**（见文件头约束③）。 */
export function prefillFromDir(dirName: string): string {
  // 🔴 扩展名走**白名单**，不是"任意 2–4 位字母数字"。第一版写的是后者，测试当场逮住：
  // `Narcos.S01` 里的 `.S01` 被当成扩展名吃掉了。同一条正则还会吃掉 `.2020`——而**年份对
  // TMDB 检索很有用**（同名作品靠它区分），白吃一个年份等于让用户自己补回来。
  // 白名单漏掉某个冷门格式时的代价只是"检索词里多一个后缀"，方向安全。
  const MEDIA_EXT = /\.(mkv|mp4|avi|ts|m2ts|mov|wmv|flv|webm|rmvb|rm|iso|ass|srt|ssa|sub|vtt|idx|sup)$/i
  const tidy = (s: string) => s.replace(MEDIA_EXT, '').replace(/[._]+/g, ' ').replace(/\s+/g, ' ').trim()

  const stripped = tidy(
    dirName
      .replace(/【[^】]*】/g, ' ')
      .replace(/\[[^\]]*\]/g, ' ')
      .replace(/\{[^}]*\}/g, ' '),
  )
  if (stripped !== '') return stripped

  // 🔴 全被剥光（整串都在括号里，如 `[毒枭][全1-3季][内嵌多国字幕]`）→ **退一步**：
  // 只去掉括号**字符**、保留里面的词。第一版直接退回原目录名，等于把一个括号最密的串
  // 原样丢进搜索框——那一串里全是发布组的噪音，用户得自己删半天。
  // 仍然**不猜**"哪个括号里才是片名"（那是识别轨的职责，C30）：片名会留在原位，用户改起来短。
  const ungrouped = tidy(dirName.replace(/[【】\[\]{}]/g, ' '))
  return ungrouped === '' ? dirName : ungrouped
}

type SearchState = { kind: 'idle' } | { kind: 'loading' } | { kind: 'failed'; message: string }

export function IdentifyBindDialog({
  open, onOpenChange, dirName, handle, onBound,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  dirName: string
  handle: string
  /** 绑定成功后回调（调用方据此刷新 /health，让这一行从名单里消失）。 */
  onBound: () => void
}) {
  const { t } = useT()
  const [query, setQuery] = useState(() => prefillFromDir(dirName))
  const [type, setType] = useState<'tv' | 'movie'>('tv')
  const [search, setSearch] = useState<SearchState>({ kind: 'idle' })
  const [results, setResults] = useState<TmdbSearchResultDTO[] | null>(null)
  const [bindError, setBindError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)

  const runSearch = async (q: string, ty: 'tv' | 'movie') => {
    if (q.trim() === '') return
    setSearch({ kind: 'loading' })
    setResults(null)
    setBindError(null)
    try {
      const r = await api.tmdbSearch(q.trim(), ty)
      setResults(r.results)
      setSearch({ kind: 'idle' })
    } catch (e) {
      // 约束②：这是"没问成"，与下面的 `results.length === 0`（问到了、没有）分开渲染。
      setSearch({ kind: 'failed', message: e instanceof Error ? e.message : String(e) })
    }
  }

  const doBind = async (id: number) => {
    setBusyId(id)
    setBindError(null)
    try {
      await api.identifyBind(handle, String(id))
      onBound()
      onOpenChange(false)
    } catch (e) {
      // 约束①：原样展示服务端的 error，不加工、不翻译。
      setBindError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="bind-dialog">
        <DialogHeader>
          <DialogTitle>{t('bind_title')}</DialogTitle>
          {/* 目录名出在这里：用户必须确认自己绑的是哪个目录。
              走 mono（与名单里那套"技术性读数"的排印语言一致）。 */}
          <DialogDescription className="wb-bind-dir">{dirName}</DialogDescription>
        </DialogHeader>

        <div className="wb-bind-form">
          <Input
            data-testid="bind-query"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(query, type) }}
            aria-label={t('bind_query_label')}
          />
          {/* 类型是**必填**（服务端只接受 tv|movie）。让用户自己选而不是前端猜：
              猜错类型正是 D-4 修的那个洞（拿 TV id 去查 movie 端点 → 假 404），
              前端再猜一遍等于把这个洞搬到浏览器里。 */}
          <div className="wb-bind-type" role="group" aria-label={t('bind_type_label')}>
            <Button
              type="button" size="sm"
              variant={type === 'tv' ? 'default' : 'outline'}
              data-testid="bind-type-tv"
              onClick={() => setType('tv')}
            >{t('bind_type_tv')}</Button>
            <Button
              type="button" size="sm"
              variant={type === 'movie' ? 'default' : 'outline'}
              data-testid="bind-type-movie"
              onClick={() => setType('movie')}
            >{t('bind_type_movie')}</Button>
          </div>
          <Button
            type="button" size="sm"
            data-testid="bind-search"
            disabled={search.kind === 'loading'}
            onClick={() => void runSearch(query, type)}
          >{search.kind === 'loading' ? t('bind_searching') : t('bind_search')}</Button>
        </div>

        <div className="wb-bind-results">
          {search.kind === 'failed' && (
            <p data-testid="bind-search-failed" role="alert" className="wb-bind-msg">
              {t('bind_search_failed')}
              {': '}
              {search.message}
            </p>
          )}
          {search.kind === 'idle' && results !== null && results.length === 0 && (
            <p data-testid="bind-no-results" className="wb-bind-msg">{t('bind_no_results')}</p>
          )}
          {results !== null && results.length > 0 && (
            <ul className="wb-bind-list" data-testid="bind-results">
              {results.map((r) => {
                const poster = posterUrl(r.posterPath)
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="wb-bind-hit"
                      data-testid={`bind-hit-${r.id}`}
                      disabled={busyId !== null}
                      onClick={() => void doBind(r.id)}
                    >
                      {poster !== null && <img className="wb-bind-poster" src={poster} alt="" />}
                      <span className="wb-bind-hit-name">{r.name}</span>
                      {r.year !== null && <span className="wb-bind-hit-year">({r.year})</span>}
                      <span className="wb-bind-hit-id">tmdb:{r.id}</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>

        {bindError !== null && (
          <p data-testid="bind-error" role="alert" className="wb-bind-msg wb-bind-error">
            {t('bind_failed')}
            {': '}
            {bindError}
          </p>
        )}

        <DialogFooter>
          <DialogClose><Button type="button" variant="outline" size="sm">{t('common_cancel')}</Button></DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
