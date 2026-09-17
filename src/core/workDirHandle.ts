// src/core/workDirHandle.ts —— D-5（2026-09-18）：`work_dir` 与"不透明句柄"的双向编解码。
//
// 单独成一个模块（而不是放在 identifyBindApi 里）是为了**不把 agent 层拖进只读路径**：
// `unidentifiedHealth`（`/api/v2/health` 的 `unidentified` 段）要用 encode，而它是个纯读
// 端点，不该因为一个 base64 而 import 整条识别轨（identifyScheduler → agent → LLM SDK）。
//
// 为什么是**不透明**句柄而不是直接给绝对路径：`unidentifiedHealth.ts` 头注释的既有纪律是
// 「出**目录名**而不是**绝对路径**：前面的挂载点前缀对用户毫无信息量，且把容器内路径贴给
// 用户是纯排障噪音」。句柄让 POST 能回指同时不破坏那条纪律——前端只把它当字符串原样回传。
//
// 用 base64url（而非标准 base64）：URL 安全，无 `+` `/` `=` 需要转义，可以直接放进查询串或
// JSON 而不出岔子。
//
// ⚠️ 句柄**不是**权限凭据：它只回答"指哪个目录"，而能不能绑/能不能撤由服务端另行判定
// （目录必须真的未识别；撤销只认 `work_id_source='human'`）。故这里不需要签名或加密。

/** `work_dir` → 不透明句柄。 */
export function encodeWorkDirHandle(workDir: string): string {
  return Buffer.from(workDir, 'utf8').toString('base64url')
}

/** 句柄 → `work_dir`。解不出（空串 / 畸形 base64 / 空结果）返回 null，由调用方报 400。
 *
 *  **往返校验**是必要的：base64url 解码对畸形输入相当宽容（会尽力解出点东西），所以"解得出来"
 *  不等于"这是我们发出去的句柄"。再编码一次与原串比对，不等即拒——这样 `decode` 的失败
 *  判据是确定的，不依赖 Buffer 对畸形输入的具体容忍行为。 */
export function decodeWorkDirHandle(handle: string): string | null {
  if (!handle) return null
  try {
    const s = Buffer.from(handle, 'base64url').toString('utf8')
    return s.length > 0 && encodeWorkDirHandle(s) === handle ? s : null
  } catch {
    return null
  }
}
