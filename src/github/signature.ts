import { Webhooks } from "@octokit/webhooks";

const SIGNATURE = /^sha256=[0-9a-f]{64}$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * X-Hub-Signature-256 を、生の本文に対する HMAC-SHA256 と定数時間で比べる（原則 IV、FR-002）。
 * 比較は @octokit/webhooks の verify（node:crypto の timingSafeEqual）に任せる。
 * verify は文字列を受け取るので、生の本文を厳格な UTF-8 で文字列に戻す。壊れた UTF-8・空の値は例外にせず false。
 */
export async function verifySignature(
  secret: string,
  rawBody: Uint8Array,
  signatureHeader: string | undefined,
): Promise<boolean> {
  if (!secret || !signatureHeader || !SIGNATURE.test(signatureHeader) || rawBody.length === 0) {
    return false;
  }
  let text: string;
  try {
    text = decoder.decode(rawBody);
  } catch {
    return false;
  }
  try {
    return await new Webhooks({ secret }).verify(text, signatureHeader);
  } catch {
    return false;
  }
}
