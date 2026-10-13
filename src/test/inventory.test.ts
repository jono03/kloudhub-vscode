import { strict as assert } from "assert";
import { test } from "node:test";
import { allServers, buildProject, BuildOptions, ProjectData, serverState } from "../inventory";
import type { Environment, Resource } from "../kloudhub/types";

const P = { code: "lab", name: "연구실", status: "active", role: "member" };
const FP_MINE = "SHA256:mine";
const FP_OLD = "SHA256:old-laptop";

function env(name: string, template: string | null, state = "running"): Environment {
  return { id: `e-${name}`, name, state, template, zone: "kr-a", owner: "me" };
}

let seq = 0;
function server(name: string, o: Partial<Resource> & { spec?: Resource["spec"] } = {}): Resource {
  seq++;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kind: "server",
    name,
    state: "ACTIVE",
    backend_id: "kr-a",
    env_id: null,
    owner: "me",
    ...o,
    spec: { image: "img-ubuntu", keys: [{ name: "laptop", fingerprint: FP_MINE }], ...(o.spec ?? {}) },
  };
}

function pip(serverId: string, address: string, privateAddress?: string): Resource {
  return {
    id: `ip-${address}`,
    kind: "public_ip",
    name: `ip-${address}`,
    state: "ACTIVE",
    backend_id: "kr-a",
    env_id: null,
    owner: "me",
    spec: { address, server: serverId, private_address: privateAddress ?? null },
  };
}

const OPTS: BuildOptions = { username: "me", localFingerprints: new Set([FP_MINE]), allowPrivate: false };

function k8sData(): { data: ProjectData; cp: Resource; w1: Resource; w2: Resource } {
  const cp = server("kh-lab-my-k8s-cp0", { env_id: "my-k8s", spec: { role: "cp", addresses: { net: ["10.0.0.10"] } } });
  const w1 = server("kh-lab-my-k8s-worker1", { env_id: "my-k8s", spec: { role: "worker", addresses: { net: ["10.0.0.11"] } } });
  const w2 = server("kh-lab-my-k8s-worker2", { env_id: "my-k8s", spec: { role: "worker", addresses: { net: ["10.0.0.12"] } } });
  return {
    cp,
    w1,
    w2,
    data: {
      envs: [env("my-k8s", "k8s")],
      // API 순서가 섞여 있어도 역할 순서(cp 먼저)로 정렬돼야 한다
      servers: [w2, cp, w1],
      publicIps: [pip(cp.id, "203.0.113.5", "10.0.0.10")],
      images: [{ id: "img-ubuntu", name: "Ubuntu 24.04", os: "ubuntu" }],
    },
  };
}

test("쿠버네티스: cp 는 공인 IP 로 직접, 워커는 cp 를 거쳐 사설 IP 로", () => {
  const { data, cp } = k8sData();
  const node = buildProject(P, data, OPTS);
  assert.equal(node.envs.length, 1);
  const e = node.envs[0];
  assert.equal(e.info.title, "쿠버네티스");
  assert.deepEqual(
    e.servers.map((s) => [s.label, s.roleLabel, s.route.kind, s.route.host]),
    [
      ["cp0", "제어 노드", "direct", "203.0.113.5"],
      ["worker1", "워커", "jump", "10.0.0.11"],
      ["worker2", "워커", "jump", "10.0.0.12"],
    ]
  );
  assert.equal(e.servers[1].route.via?.res.id, cp.id);
  assert.equal(e.servers[1].user, "ubuntu", "이미지 OS 로 로그인 계정을 안다");
  assert.equal(e.servers[1].keys, "ok");
});

test("남의 환경은 빼고, 단독 인스턴스는 내 것만 따로 모은다", () => {
  const { data } = k8sData();
  const mineSolo = server("kh-lab-solo-scratch", { spec: { addresses: { n: ["10.9.0.5"] } } });
  const othersSolo = server("kh-lab-solo-theirs", { owner: "other" });
  const othersEnvServer = server("kh-lab-their-env-vm0", { env_id: "their-env", owner: "other" });
  const jump = server("kh-lab-jump", { spec: { mgmt: "jump" } });
  data.servers.push(mineSolo, othersSolo, othersEnvServer, jump);
  data.publicIps.push(pip(mineSolo.id, "198.51.100.9"));

  const node = buildProject(P, data, OPTS);
  assert.deepEqual(node.envs.map((e) => e.env.name), ["my-k8s"]);
  assert.deepEqual(node.standalone.map((s) => s.label), ["scratch"]);
  assert.equal(node.standalone[0].route.kind, "direct");
  assert.ok(!allServers([node]).some((s) => s.res.spec.mgmt === "jump"), "관리 경유 서버는 목록에 없다");
});

test("공인 IP 가 없는 환경은 접속 불가, allowPrivate 면 사설 IP 로", () => {
  const vm = server("kh-lab-dev-vm0", { env_id: "dev", spec: { role: "vm", addresses: { net: ["10.1.0.4"] } } });
  const data: ProjectData = { envs: [env("dev", "dev-vm")], servers: [vm], publicIps: [], images: [] };
  const off = buildProject(P, data, OPTS).envs[0].servers[0];
  assert.equal(off.route.kind, "none");
  assert.equal(off.user, undefined, "이미지를 모르면 계정도 모른다");
  const on = buildProject(P, data, { ...OPTS, allowPrivate: true }).envs[0].servers[0];
  assert.deepEqual([on.route.kind, on.route.host], ["private", "10.1.0.4"]);
});

test("단독 인스턴스끼리는 서로 경유하지 않는다", () => {
  const a = server("kh-lab-solo-a", { spec: { addresses: { n: ["10.2.0.1"] } } });
  const b = server("kh-lab-solo-b", { spec: { addresses: { n: ["10.3.0.1"] } } });
  const data: ProjectData = { envs: [], servers: [a, b], publicIps: [pip(a.id, "198.51.100.1")], images: [] };
  const node = buildProject(P, data, OPTS);
  assert.deepEqual(node.standalone.map((s) => s.route.kind), ["direct", "none"]);
});

test("키 상태: 겹침 / 다른 키만 / 넣은 키 없음 / 기록 없음 / 이 PC 키 모름", () => {
  const ok = server("kh-lab-solo-ok");
  const missing = server("kh-lab-solo-missing", { spec: { keys: [{ name: "old", fingerprint: FP_OLD }] } });
  const none = server("kh-lab-solo-none", { spec: { keys: [] } });
  const legacy = server("kh-lab-solo-legacy");
  delete (legacy.spec as any).keys;
  const data: ProjectData = { envs: [], servers: [ok, missing, none, legacy], publicIps: [], images: [] };
  const by = (o: BuildOptions) =>
    Object.fromEntries(buildProject(P, data, o).standalone.map((s) => [s.label, s.keys]));
  assert.deepEqual(by(OPTS), { legacy: "unknown", missing: "missing", none: "none", ok: "ok" });
  assert.equal(by({ ...OPTS, localFingerprints: new Set() }).ok, "unknown");
});

test("워커 키는 괜찮아도 경유할 cp 에 내 키가 없으면 missing", () => {
  const { data, cp } = k8sData();
  cp.spec.keys = [{ name: "old", fingerprint: FP_OLD }];
  const e = buildProject(P, data, OPTS).envs[0];
  assert.deepEqual(e.servers.map((s) => s.keys), ["missing", "missing", "missing"]);
});

test("로그인 비밀번호 계정이 있으면 그 계정을 쓴다", () => {
  const s = server("kh-lab-solo-pw", { spec: { login: { user: "admin", password: true, ssh: true } } });
  const n = buildProject(P, { envs: [], servers: [s], publicIps: [], images: [{ id: "img-ubuntu", name: "u", os: "ubuntu" }] }, OPTS)
    .standalone[0];
  assert.equal(n.user, "admin");
  assert.equal(n.passwordSsh, true);
});

test("경유 서버는 실행 중인 공인 IP 서버를 고른다", () => {
  const m1 = server("kh-lab-sw-mgr0", { env_id: "sw", state: "STOPPED", spec: { role: "mgr", addresses: { n: ["10.4.0.1"] } } });
  const m2 = server("kh-lab-sw-mgrx1", { env_id: "sw", spec: { role: "mgrx", addresses: { n: ["10.4.0.2"] } } });
  const w = server("kh-lab-sw-worker1", { env_id: "sw", spec: { role: "worker", addresses: { n: ["10.4.0.3"] } } });
  const data: ProjectData = {
    envs: [env("sw", "docker-swarm")],
    servers: [m1, m2, w],
    publicIps: [pip(m1.id, "203.0.113.1"), pip(m2.id, "203.0.113.2")],
    images: [],
  };
  const worker = buildProject(P, data, OPTS).envs[0].servers.find((s) => s.label === "worker1")!;
  assert.equal(worker.route.via?.label, "mgrx1");
});

test("서버 상태 분류", () => {
  assert.deepEqual(
    ["ACTIVE", "STOPPED", "SHUTOFF", "BUILDING", "ERROR", null, "MISSING"].map(serverState),
    ["running", "stopped", "stopped", "busy", "error", "unknown", "unknown"]
  );
});

test("실데이터 모양: addresses 에 공인 IP 가 섞여 있고, 환경 이름을 바꿔 서버 접두사가 다르다", () => {
  // 개발 DB 의 실제 행 모양(값은 바꿈): OpenStack 은 붙은 공인 IP 도 addresses 에 넣는다
  const cp = server("kh-lab-k8s-1-cp0", {
    env_id: "k8s-renamed",
    spec: { role: "cp", addresses: { "kh-lab-k8s-1-net": ["10.0.3.121", "172.16.0.192"] }, keys: [], login: null },
  });
  const w = server("kh-lab-k8s-1-worker0", {
    env_id: "k8s-renamed",
    spec: { role: "worker", addresses: { "kh-lab-k8s-1-net": ["10.0.3.122"] }, keys: [] },
  });
  const solo = server("kh-lab-solo-box", { spec: { addresses: { n: ["172.16.0.50", "10.0.9.9"] }, keys: null as any } });
  const data: ProjectData = {
    envs: [env("k8s-renamed", "k8s")],
    servers: [cp, w, solo],
    // 단독 인스턴스는 public_ip 행에 private_address 가 없어도 addresses 의 공인 IP 를 빼야 한다
    publicIps: [pip(cp.id, "172.16.0.192", "10.0.3.121"), pip(solo.id, "172.16.0.50")],
    images: [],
  };
  const node = buildProject(P, data, OPTS);
  const e = node.envs[0];
  assert.deepEqual(
    e.servers.map((s) => [s.label, s.privateIp, s.route.kind, s.keys]),
    [
      ["cp0", "10.0.3.121", "direct", "none"],
      ["worker0", "10.0.3.122", "jump", "none"],
    ]
  );
  assert.equal(node.standalone[0].privateIp, "10.0.9.9");
  assert.equal(node.standalone[0].keys, "unknown", "keys 가 null 이면 기록 없음");
});
