import * as vscode from "vscode";
import { ClientOptions, Credentials, KloudHubClient, normalizeEndpoint, webBase } from "./kloudhub/client";
import type { Me } from "./kloudhub/types";

const SECRET_KEY = "kloudhub.credentials";
const TOKEN_RE = /^kh_[A-Za-z0-9_-]{8,}$/;

/**
 * 토큰은 VS Code SecretStorage(OS 키체인: macOS Keychain, Windows 자격 증명 관리자, Linux libsecret)에 둔다.
 * 토큰은 사용자 권한 그대로 쓰이므로 설정 파일이나 globalState 에 두지 않는다.
 */
export class AuthStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async load(): Promise<Credentials | undefined> {
    const raw = await this.secrets.get(SECRET_KEY);
    if (!raw) return undefined;
    try {
      const c = JSON.parse(raw) as Credentials;
      return c && typeof c.endpoint === "string" && typeof c.token === "string" ? c : undefined;
    } catch {
      return undefined;
    }
  }

  async save(c: Credentials): Promise<void> {
    await this.secrets.store(SECRET_KEY, JSON.stringify(c));
  }

  async clear(): Promise<void> {
    await this.secrets.delete(SECRET_KEY);
  }
}

function validateEndpoint(v: string): string | undefined {
  try {
    normalizeEndpoint(v);
    return undefined;
  } catch (e: any) {
    return e.message;
  }
}

/** 로그인 대화 흐름: 주소 → 토큰 → /me 로 확인. 취소하면 undefined. */
export async function promptLogin(
  previous: Credentials | undefined,
  opts: ClientOptions
): Promise<{ creds: Credentials; me: Me } | undefined> {
  const cfg = vscode.workspace.getConfiguration("kloudhub");
  const endpointInput = await vscode.window.showInputBox({
    title: "KloudHub 로그인 (1/2): 주소",
    prompt: "웹 주소를 그대로 넣으면 된다. 예: https://kloudhub.example.ac.kr",
    value: previous ? webBase(previous.endpoint) : cfg.get<string>("endpoint") ?? "",
    ignoreFocusOut: true,
    validateInput: validateEndpoint,
  });
  if (!endpointInput) return undefined;
  const endpoint = normalizeEndpoint(endpointInput);

  const token = await vscode.window.showInputBox({
    title: "KloudHub 로그인 (2/2): API 토큰",
    prompt: `웹 → 설정 → API 토큰에서 발급한 kh_… 값 (${webBase(endpoint)}/settings)`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (TOKEN_RE.test(v.trim()) ? undefined : "kh_ 로 시작하는 API 토큰을 붙여 넣을 것"),
  });
  if (!token) return undefined;
  const creds: Credentials = { endpoint, token: token.trim() };
  // 토큰이 맞는지 /me 로 확인한다.
  const me = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "KloudHub 토큰 확인 중…" },
    () => new KloudHubClient(creds, opts).me()
  );
  if (!cfg.get<string>("endpoint")) {
    await cfg.update("endpoint", webBase(endpoint), vscode.ConfigurationTarget.Global);
  }
  return { creds, me };
}
