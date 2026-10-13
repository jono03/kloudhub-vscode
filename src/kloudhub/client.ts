import * as http from "http";
import * as https from "https";
import { URL } from "url";
import { Environment, Image, Job, JOB_DONE_STATES, Me, Resource, SshKey } from "./types";

/** 웹 설정 화면에서 발급한 개인 API 토큰(`kh_…`)과 API 주소 */
export interface Credentials {
  /** `https://host/api/v1` 형태로 맞춘 주소 */
  endpoint: string;
  token: string;
}

export interface ClientOptions {
  /** 학내 서버처럼 자체서명 인증서를 쓰는 주소용. 기본 false. */
  allowSelfSigned?: boolean;
  timeoutMs?: number;
  log?: (line: string) => void;
}

export class KloudHubError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "KloudHubError";
  }
}

/** 토큰이 틀렸거나 만료(HTTP 401). 새 토큰으로 다시 로그인해야 한다. */
export class AuthError extends KloudHubError {
  constructor(message: string, httpStatus?: number) {
    super(message, httpStatus);
    this.name = "AuthError";
  }
}

const API_PATH = "/api/v1";

/**
 * 사용자는 웹 주소를 넣는다. 웹(nginx)이 `/api/` 를 백엔드로 넘기므로 같은 출처의 `/api/v1` 로 맞춘다.
 *   https://kloudhub.example.ac.kr/p/lab/environments -> https://kloudhub.example.ac.kr/api/v1
 *   http://localhost:8000/api/v1                     -> 그대로 (개발용 API 직접 주소)
 */
export function normalizeEndpoint(input: string): string {
  const s = input.trim();
  if (!/^https?:\/\//i.test(s)) {
    throw new KloudHubError("주소는 http:// 또는 https:// 로 시작해야 한다: " + input);
  }
  const u = new URL(s);
  const at = u.pathname.indexOf(API_PATH);
  const prefix = at >= 0 ? u.pathname.slice(0, at) : "";
  return `${u.origin}${prefix}${API_PATH}`;
}

/** API 주소에서 웹 화면 주소(출처)를 얻는다. 화면 경로는 `/p/{project}/…` */
export function webBase(endpoint: string): string {
  return endpoint.endsWith(API_PATH) ? endpoint.slice(0, -API_PATH.length) : endpoint;
}

/** FastAPI 오류 본문 `{"detail": "…"}` 또는 검증 오류 목록에서 사람이 읽을 문구를 꺼낸다. */
function detailOf(text: string): string | undefined {
  try {
    const d = JSON.parse(text)?.detail;
    if (typeof d === "string") return d;
    if (Array.isArray(d)) return d.map((x) => x?.msg ?? JSON.stringify(x)).join("; ");
  } catch {
    /* JSON 아님 */
  }
  return undefined;
}

interface RawResponse {
  status: number;
  body: string;
}

export class KloudHubClient {
  constructor(
    readonly credentials: Credentials,
    private readonly opts: ClientOptions = {}
  ) {}

  private send(method: string, path: string, body?: unknown): Promise<RawResponse> {
    const u = new URL(this.credentials.endpoint + path);
    const isHttps = u.protocol === "https:";
    const mod = isHttps ? https : http;
    const agent = isHttps ? new https.Agent({ rejectUnauthorized: !this.opts.allowSelfSigned }) : undefined;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${this.credentials.token}`,
    };
    if (payload !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload).toString();
    }
    this.opts.log?.(`-> ${method} ${u.pathname}${u.search}`);
    return new Promise((resolve, reject) => {
      const req = mod.request(u, { method, agent, headers, timeout: this.opts.timeoutMs ?? 30000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("timeout", () => req.destroy(new Error("요청 시간 초과: " + u.host)));
      req.on("error", reject);
      req.end(payload);
    });
  }

  private async call(method: string, path: string, body?: unknown): Promise<RawResponse> {
    const res = await this.send(method, path, body);
    if (res.status === 401) {
      throw new AuthError(detailOf(res.body) ?? "인증 실패 (HTTP 401)", res.status);
    }
    if (res.status >= 400) {
      const msg = detailOf(res.body) ?? res.body.slice(0, 200).replace(/\s+/g, " ");
      throw new KloudHubError(`${msg} (HTTP ${res.status})`, res.status);
    }
    return res;
  }

  async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.call(method, path, body);
    if (res.status === 204 || res.body === "") return undefined as T;
    try {
      return JSON.parse(res.body) as T;
    } catch {
      const snippet = res.body.slice(0, 200).replace(/\s+/g, " ");
      throw new KloudHubError(`JSON 이 아닌 응답 (HTTP ${res.status}). 주소를 확인할 것: ${snippet}`, res.status);
    }
  }

  me(): Promise<Me> {
    return this.json<Me>("GET", "/me");
  }

  /** 내가 만든 환경만 (`mine=true`) */
  myEnvironments(project: string): Promise<Environment[]> {
    return this.json<Environment[]>("GET", `/projects/${enc(project)}/environments?mine=true`);
  }

  /** 프로젝트의 서버 전부(환경 서버 + 단독 인스턴스). 누구 것인지는 `owner`·`env_id` 로 거른다. */
  instances(project: string): Promise<Resource[]> {
    return this.json<Resource[]>("GET", `/projects/${enc(project)}/instances`);
  }

  publicIps(project: string): Promise<Resource[]> {
    return this.json<Resource[]>("GET", `/projects/${enc(project)}/public-ips`);
  }

  images(project: string): Promise<Image[]> {
    return this.json<Image[]>("GET", `/projects/${enc(project)}/images`);
  }

  sshKeys(): Promise<SshKey[]> {
    return this.json<SshKey[]>("GET", "/me/ssh-keys");
  }

  addSshKey(publicKey: string, name?: string): Promise<SshKey> {
    return this.json<SshKey>("POST", "/me/ssh-keys", { public_key: publicKey, ...(name ? { name } : {}) });
  }

  async environmentAction(project: string, env: string, action: "start" | "stop"): Promise<string> {
    const r = await this.json<{ job_id: string }>(
      "POST",
      `/projects/${enc(project)}/environments/${enc(env)}/actions/${action}`
    );
    return r.job_id;
  }

  async instanceAction(project: string, id: string, action: "start" | "stop"): Promise<string> {
    const r = await this.json<{ job_id: string }>("POST", `/projects/${enc(project)}/instances/${enc(id)}/actions/${action}`);
    return r.job_id;
  }

  /** 쿠버네티스 환경의 내 kubeconfig(클라이언트 인증서 90일). 환경을 바꿀 수 있는 사람만 받는다. */
  async kubeconfig(project: string, env: string): Promise<string> {
    return (await this.call("GET", `/projects/${enc(project)}/environments/${enc(env)}/kubeconfig`)).body;
  }

  job(id: string): Promise<Job> {
    return this.json<Job>("GET", `/jobs/${enc(id)}`);
  }

  /** 작업이 끝날 때까지 기다린다. succeeded 가 아니면 작업의 실패 원인으로 예외를 올린다. */
  async waitForJob(
    id: string,
    o: { intervalMs?: number; timeoutMs?: number; onState?: (j: Job) => void } = {}
  ): Promise<Job> {
    const interval = o.intervalMs ?? 2000;
    const deadline = Date.now() + (o.timeoutMs ?? 15 * 60 * 1000);
    for (;;) {
      const j = await this.job(id);
      o.onState?.(j);
      if (JOB_DONE_STATES.has(j.state)) {
        if (j.state !== "succeeded") throw new KloudHubError(j.error || `작업이 ${j.state} 상태로 끝났다 (${id})`);
        return j;
      }
      if (Date.now() > deadline) throw new KloudHubError(`작업이 끝나지 않았다 (${id}, ${j.state}). 웹 활동 화면에서 확인할 것.`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}
