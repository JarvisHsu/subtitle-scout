// src/core/workDirHandle.ts —— D-5（2026-09-18）：`work_dir` 与"不透明句柄"的映射。
//
// 单独成一个模块（而不是放在 identifyBindApi 里）是为了**不把 agent 层拖进只读路径**：
// `unidentifiedHealth`（`/api/v2/health` 的 `unidentified` 段）要用 encode，而它是个纯读
// 端点，不该因为一个摘要而 import 整条识别轨（identifyScheduler → agent → LLM SDK）。
//
// ── 句柄是**摘要**，不是编码后的路径（2026-09-18 修正，规格 §7.1）────────────────
// 本文件第一版用 `base64url(work_dir)` 当句柄。那**违反提案 §7.1 的原文**：
// 「不透明句柄（服务端生成的**摘要**，**非路径**）」——base64 可逆，等于把绝对路径换个
// 字母表发出去（issues.md #1 里留了当时那条"有意识破例"的记录，本轮据规格收回）。
//
// 现在：`handle = base64url(sha256(work_dir))`。摘要**不可逆**，服务端仍能反查——因为候选集
// **有界且已知**（库里"未识别"或"人工绑定过"的 work_dir，生产实测只有几十个），对每个候选
// 算一次摘要比对即可。这是摘要式句柄能成立的关键前提，也是它不需要签名、不需要密钥、
// 不需要新表的原因。
//
// ⚠️ 摘要**不是权限凭据**：它只回答"指哪个目录"，能不能绑/能不能撤由服务端另行判定
//    （目录必须真的未识别；撤销只认 `work_id_source='human'`）。故不需要签名或加密。
import { createHash } from 'node:crypto'

/** 句柄的规范形状：base64url(sha256) = 43 个字符，字母表 `A-Za-z0-9-_`。 */
const HANDLE_RE = /^[A-Za-z0-9_-]{43}$/

/** `work_dir` → 不透明句柄（SHA-256 摘要的 base64url 形态）。
 *
 *  用 base64url 而不是十六进制：URL 安全（无 `+` `/` `=` 需转义），可直接放进查询串或 JSON。
 *  用摘要而不是编码：句柄不再携带路径信息（见文件头的规格依据）。 */
export function encodeWorkDirHandle(workDir: string): string {
  return createHash('sha256').update(workDir, 'utf8').digest('base64url')
}

/** 句柄的**形状**判据（不看内容，只看它像不像我们发出去的）。
 *
 *  存在的理由：把"畸形句柄"（400）与"形状对但库里没有这个目录"（404/409）分成两种答复。
 *  这两句话给用户的下一步动作完全不同——前者是"你的请求坏了"，后者是"这个目录现在没有
 *  未识别文件了（可能刚被识别掉）"。混成一个判据会让用户白排查。 */
export function isWorkDirHandle(handle: string): boolean {
  return HANDLE_RE.test(handle)
}

/** 在**候选集合**里按摘要反查 `work_dir`。
 *
 *  @param candidates 调用方给的候选集，必须与该操作的作用域一致：
 *    · 绑定 → 库里 `work_id IS NULL` 的 work_dir（只许绑未识别的目录）
 *    · 撤销 → 库里 `work_id_source = 'human'` 的 work_dir（只许撤人绑的）
 *    候选集给错会让句柄命中一个不该被这个操作碰到的目录——**这是本函数唯一的风险点**，
 *    所以两个调用点的候选集 SQL 都写在各自那处、各自带论证，不在这里统一。
 *
 *  找不到 → null（由调用方决定报 404 还是 409）。
 *  这是摘要式句柄**唯一可能的反查方式**：算不出原像，只能拿候选去撞。 */
export function resolveWorkDirHandle(handle: string, candidates: readonly string[]): string | null {
  if (!isWorkDirHandle(handle)) return null
  for (const dir of candidates) {
    if (encodeWorkDirHandle(dir) === handle) return dir
  }
  return null
}
