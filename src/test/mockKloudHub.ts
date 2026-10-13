import * as http from "http";
import type { AddressInfo } from "net";
import type { Environment, Resource, SshKey } from "../kloudhub/types";

/**
 * KloudHub API 모의 서버. 실제 백엔드의 경로·응답 모양·인증 규칙(Bearer 토큰, 틀리면 401 `{"detail"}`)과
 * 쓰기 요청이 202 `{job_id}` 를 주고 작업이 끝나면 상태가 바뀌는 흐름을 흉내 낸다.
 */

export const TOKEN = "kh_testtoken_0123456789";
export const IP_CP = "203.0.113.5";
export const IP_SOLO = "198.51.100.9";

export function sid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export interface MockServer {
  endpoint: string;
  envs: Environment[];
  servers: Resource[];
  publicIps: Resource[];
  keys: SshKey[];
  requests: { method: string; path: string; auth?: string; body?: any }[];
  /** 다음 작업을 실패시킨다 */
  failNextJob?: string;
  close(): Promise<void>;
}

function srv(n: number, name: string, o: Partial<Resource>, spec: Resource["spec"]): Resource {
  return {
    id: sid(n),
    kind: "server",
    name,
    state: "ACTIVE",
    backend_id: "kr-a",
    env_id: null,
    owner: "me",
    ...o,
    spec: { image: "img-ubuntu", ...spec },
  };
}

function ip(server: Resource, address: string): Resource {
  return {
    id: `ip-${address}`,
    kind: "public_ip",
    name: `kh-ip-${address}`,
    state: "ACTIVE",
    backend_id: "kr-a",
    env_id: server.env_id,
    owner: server.owner,
    spec: { address, server: server.id, private_address: Object.values(server.spec.addresses ?? {})[0]?.[0] ?? null },
  };
}

export async function startMockKloudHub(myFingerprint: string): Promise<MockServer> {
  const mine = [{ name: "laptop", fingerprint: myFingerprint }];
  const cp = srv(1, "kh-lab-my-k8s-cp0", { env_id: "my-k8s" }, { role: "cp", addresses: { "kh-lab-my-k8s-net": ["10.0.0.10"] }, keys: mine });
  const w1 = srv(2, "kh-lab-my-k8s-worker1", { env_id: "my-k8s" }, { role: "worker", addresses: { n: ["10.0.0.11"] }, keys: mine });
  const dev = srv(3, "kh-lab-dev-vm0", { env_id: "dev", state: "STOPPED" }, { role: "vm", addresses: { n: ["10.1.0.4"] }, keys: mine });
  const nopub = srv(4, "kh-lab-nopub-vm0", { env_id: "nopub" }, { role: "vm", addresses: { n: ["10.2.0.4"] }, keys: mine });
  const solo = srv(5, "kh-lab-solo-scratch", {}, { addresses: { n: ["10.9.0.5"] }, keys: [{ name: "old", fingerprint: "SHA256:old" }] });
  const theirsSolo = srv(6, "kh-lab-solo-theirs", { owner: "other" }, { addresses: { n: ["10.9.0.6"] } });
  const theirsEnv = srv(7, "kh-lab-their-env-vm0", { env_id: "their-env", owner: "other" }, { role: "vm", addresses: { n: ["10.3.0.4"] } });
  const devPub = ip(dev, "203.0.113.7");

  const state: MockServer = {
    endpoint: "",
    envs: [
      { id: "e1", name: "my-k8s", state: "running", template: "k8s", version: 3, zone: "kr-a", owner: "me" },
      { id: "e2", name: "dev", state: "stopped", template: "dev-vm", version: 1, zone: "kr-a", owner: "me" },
      { id: "e3", name: "nopub", state: "running", template: "dev-vm", version: 1, zone: "kr-a", owner: "me" },
      { id: "e4", name: "their-env", state: "running", template: "dev-vm", version: 1, zone: "kr-a", owner: "other" },
    ],
    servers: [cp, w1, dev, nopub, solo, theirsSolo, theirsEnv],
    publicIps: [ip(cp, IP_CP), devPub, ip(solo, IP_SOLO)],
    keys: [],
    requests: [],
    close: async () => undefined,
  };

  // 작업: 처음 조회는 running, 다음 조회에 끝나며 효과를 낸다
  const jobs = new Map<string, { polls: number; effect: () => void; fail?: string }>();
  let jobSeq = 0;
  const submit = (effect: () => void): string => {
    const id = `job-${++jobSeq}`;
    jobs.set(id, { polls: 0, effect, fail: state.failNextJob });
    state.failNextJob = undefined;
    return id;
  };

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://x");
      const body = raw ? JSON.parse(raw) : undefined;
      state.requests.push({ method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization, body });
      const send = (status: number, data: unknown, type = "application/json") => {
        res.writeHead(status, { "Content-Type": type });
        res.end(typeof data === "string" ? data : JSON.stringify(data));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return send(401, { detail: "API 토큰이 올바르지 않거나 만료되었습니다" });
      }
      const p = url.pathname.replace(/^\/api\/v1/, "");
      let m: RegExpMatchArray | null;
      if (req.method === "GET" && p === "/me") {
        return send(200, {
          id: "u1",
          username: "me",
          display_name: "나",
          org_role: "user",
          projects: [
            { code: "lab", name: "연구실", status: "active", role: "member" },
            { code: "wait", name: "승인 대기", status: "requested", role: "admin" },
          ],
        });
      }
      if (req.method === "GET" && p === "/me/ssh-keys") return send(200, state.keys);
      if (req.method === "POST" && p === "/me/ssh-keys") {
        const k: SshKey = { id: `k${state.keys.length + 1}`, type: "ssh-ed25519", name: body.name, fingerprint: "SHA256:x", public_key: body.public_key };
        state.keys.push(k);
        return send(201, k);
      }
      if ((m = p.match(/^\/projects\/([^/]+)\/(environments|instances|public-ips|images)$/)) && req.method === "GET") {
        if (m[1] !== "lab") return send(403, { detail: "이 프로젝트에 권한이 없습니다" });
        if (m[2] === "environments") {
          const onlyMine = url.searchParams.get("mine") === "true";
          return send(200, state.envs.filter((e) => !onlyMine || e.owner === "me"));
        }
        if (m[2] === "instances") return send(200, state.servers);
        if (m[2] === "public-ips") return send(200, state.publicIps);
        return send(200, [{ id: "img-ubuntu", name: "Ubuntu 24.04", os: "ubuntu" }]);
      }
      if ((m = p.match(/^\/projects\/lab\/environments\/([^/]+)\/actions\/(start|stop)$/)) && req.method === "POST") {
        const env = state.envs.find((e) => e.name === m![1]);
        if (!env) return send(404, { detail: "환경을 찾을 수 없습니다" });
        const action = m[2];
        env.state = action === "start" ? "starting" : "stopping";
        const job = submit(() => {
          env.state = action === "start" ? "running" : "stopped";
          for (const s of state.servers) if (s.env_id === env.name) s.state = action === "start" ? "ACTIVE" : "STOPPED";
        });
        return send(202, { job_id: job, environment: env.name });
      }
      if ((m = p.match(/^\/projects\/lab\/instances\/([^/]+)\/actions\/(start|stop)$/)) && req.method === "POST") {
        const s = state.servers.find((x) => x.id === m![1]);
        if (!s) return send(404, { detail: "자원을 찾을 수 없습니다" });
        const action = m[2];
        return send(202, { job_id: submit(() => (s.state = action === "start" ? "ACTIVE" : "STOPPED")) });
      }
      if ((m = p.match(/^\/projects\/lab\/environments\/([^/]+)\/kubeconfig$/)) && req.method === "GET") {
        return send(200, `apiVersion: v1\nkind: Config\nclusters:\n- name: ${m[1]}\n  cluster:\n    server: https://${IP_CP}:6443\n`, "application/yaml");
      }
      if ((m = p.match(/^\/jobs\/([^/]+)$/)) && req.method === "GET") {
        const j = jobs.get(m[1]);
        if (!j) return send(404, { detail: "작업을 찾을 수 없습니다" });
        j.polls++;
        if (j.polls < 2) return send(200, { id: m[1], kind: "x", state: "running", error: null });
        if (j.fail) return send(200, { id: m[1], kind: "x", state: "failed", error: j.fail });
        if (j.polls === 2) j.effect();
        return send(200, { id: m[1], kind: "x", state: "succeeded", error: null });
      }
      return send(404, { detail: "Not Found" });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  state.endpoint = `http://127.0.0.1:${port}`;
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}
