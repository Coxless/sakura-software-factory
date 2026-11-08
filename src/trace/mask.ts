export const REDACTED = "[REDACTED]";

const PATTERNS: [RegExp, string][] = [
  // PEM の秘密鍵のブロック
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, REDACTED],
  // Authorization ヘッダーなどの Bearer トークン
  [/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/g, `Bearer ${REDACTED}`],
  // GitHub のトークン（PAT・インストールトークンなど）
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g, REDACTED],
];

/** 既知の形の秘密情報を [REDACTED] に置き換える。ログと軌跡（004）で共用する */
export function maskSecrets(text: string): string {
  let masked = text;
  for (const [pattern, replacement] of PATTERNS) masked = masked.replace(pattern, replacement);
  return masked;
}
