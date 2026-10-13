import { createHash } from "crypto";
import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";

/** KloudHub 가 받는 공개키 종류(backend auth/ssh_keys.py ALLOWED_TYPES). DSA 는 서버가 거절한다. */
export const PUBKEY_RE =
  /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(256|384|521)|sk-(ssh-ed25519|ecdsa-sha2-nistp256)@openssh\.com) [A-Za-z0-9+/=]+( .*)?$/;

/**
 * OpenSSH 공개키 한 줄의 지문. `ssh-keygen -lf` 와 같은 `SHA256:<base64, 패딩 없음>` 이고
 * KloudHub 가 서버 `spec.keys[].fingerprint` 에 기록하는 형식과 같다.
 */
export function fingerprint(publicKeyLine: string): string | undefined {
  const parts = publicKeyLine.trim().split(/\s+/);
  if (parts.length < 2) return undefined;
  let blob: Buffer;
  try {
    blob = Buffer.from(parts[1], "base64");
  } catch {
    return undefined;
  }
  if (!blob.length) return undefined;
  return "SHA256:" + createHash("sha256").update(blob).digest("base64").replace(/=+$/, "");
}

/**
 * 이 PC 에 있는 공개키 지문들. `~/.ssh/*.pub` 와 설정한 개인키 옆의 `.pub` 를 읽는다.
 * ssh-agent 에만 있는 키는 알 수 없으므로, 비어 있으면 "모름"으로 다룬다.
 */
export async function localFingerprints(identityFile?: string): Promise<Set<string>> {
  const files: string[] = [];
  const sshDir = path.join(os.homedir(), ".ssh");
  try {
    for (const f of await fs.readdir(sshDir)) if (f.endsWith(".pub")) files.push(path.join(sshDir, f));
  } catch {
    /* ~/.ssh 없음 */
  }
  if (identityFile) files.push(identityFile.endsWith(".pub") ? identityFile : identityFile + ".pub");
  const out = new Set<string>();
  for (const f of files) {
    try {
      const line = (await fs.readFile(f, "utf8")).trim();
      if (!PUBKEY_RE.test(line)) continue;
      const fp = fingerprint(line);
      if (fp) out.add(fp);
    } catch {
      /* 읽을 수 없는 파일은 건너뛴다 */
    }
  }
  return out;
}
