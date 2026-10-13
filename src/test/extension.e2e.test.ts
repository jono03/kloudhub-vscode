import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync } from "fs";
import * as os from "os";
import * as path from "path";
import { after, before, test } from "node:test";
import { IP_CP, IP_SOLO, MockServer, sid, startMockKloudHub, TOKEN } from "./mockKloudHub";

// --- 실제 확장 코드(out/extension.js)를 가짜 vscode 모듈과 가짜 HOME 으로 돌린다 ---
const HOME = mkdtempSync(path.join(os.tmpdir(), "khhome-"));
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
const Module = require("module");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request: string, ...rest: any[]) {
  if (request === "vscode") return require.resolve("./fakeVscode");
  return origResolve.call(this, request, ...rest);
};
const fake = require("./fakeVscode") as typeof import("./fakeVscode");
const ext = require("../extension") as typeof import("../extension");

const CONFIG = path.join(HOME, ".ssh", "config");
const ALIAS_CP = "kloudhub--my-k8s-cp0-00000000";
const ALIAS_W1 = "kloudhub--my-k8s-worker1-00000000";

let mock: MockServer;
let ctx: ReturnType<typeof fake.makeContext>;

function sshG(alias: string): Record<string, string> {
  const out = execFileSync("ssh", ["-G", "-F", CONFIG, alias], { encoding: "utf8" });
  const map: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const i = line.indexOf(" ");
    if (i > 0 && !(line.slice(0, i) in map)) map[line.slice(0, i)] = line.slice(i + 1);
  }
  return map;
}

/** 트리를 "프로젝트/환경/서버 설명" 줄로 펼친다 */
function outline(): string[] {
  const p = fake.recorded.treeProvider;
  const lines: string[] = [];
  const walk = (items: any[], depth: number) => {
    for (const it of items) {
      lines.push(`${"  ".repeat(depth)}${it.label}${it.description ? ` [${it.description}]` : ""}`);
      walk(p.getChildren(it), depth + 1);
    }
  };
  walk(p.getChildren(), 0);
  return lines;
}

function find(pred: (it: any) => boolean): any {
  const p = fake.recorded.treeProvider;
  const stack = [...p.getChildren()];
  while (stack.length) {
    const it = stack.shift();
    if (pred(it)) return it;
    stack.push(...p.getChildren(it));
  }
  assert.fail("트리에서 찾지 못함");
}
const serverItem = (id: string) => find((it) => it.server?.res.id === id);
const envItem = (name: string) => find((it) => it.node?.env?.name === name);

before(async () => {
  // 가짜 HOME 에 내 키를 만든다. 모의 서버는 이 지문을 "만들 때 넣은 키"로 기록한다
  mkdirSync(path.join(HOME, ".ssh"), { recursive: true, mode: 0o700 });
  const key = path.join(HOME, ".ssh", "id_ed25519");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "me@pc", "-f", key]);
  const fp = execFileSync("ssh-keygen", ["-lf", key + ".pub"], { encoding: "utf8" }).split(" ")[1];
  mock = await startMockKloudHub(fp);
  fake.installedExtensions.add("ms-vscode-remote.remote-ssh");
  ctx = fake.makeContext();
  await ext.activate(ctx as any);
});
after(() => mock.close());

test("활성화 직후에는 로그아웃 상태", () => {
  assert.equal(fake.recorded.contexts["kloudhub.loggedIn"], false);
  assert.deepEqual(outline(), []);
});

test("로그인: 웹 주소 → 토큰, 토큰은 SecretStorage 에만", async () => {
  fake.responders.input = (o) =>
    ({
      "KloudHub 로그인 (1/2): 주소": mock.endpoint + "/p/lab/environments",
      "KloudHub 로그인 (2/2): API 토큰": TOKEN,
    })[o.title as string];
  await fake.commands.executeCommand("kloudhub.login");
  assert.equal(fake.recorded.contexts["kloudhub.loggedIn"], true);
  assert.ok([...ctx._secrets.values()].join("").includes(TOKEN));
  assert.equal(fake.settings["kloudhub.endpoint"], mock.endpoint, "설정에는 웹 주소만");
  assert.ok(mock.requests.every((r) => !r.path.includes("/projects/wait/")), "승인 대기 프로젝트는 부르지 않는다");
});

test("트리(시안 A): 프로젝트 → 내 환경 → 서버, 설명은 접속할 곳 하나만", () => {
  assert.deepEqual(outline(), [
    "연구실 [lab]",
    "  dev [개발 VM · 정지됨]",
    "    vm0 [203.0.113.7 · 정지됨]",
    "  my-k8s [쿠버네티스]",
    `    cp0 [${IP_CP}]`,
    "    worker1 [cp0 경유]",
    "  nopub [개발 VM]",
    "    vm0 [접속 불가]",
    "  독립 인스턴스 [1]",
    "    scratch [키 없음]",
  ]);
  assert.equal(serverItem(sid(2)).contextValue, "server.running.jump");
  assert.equal(serverItem(sid(5)).contextValue, "server.running.direct.solo");
  assert.equal(envItem("my-k8s").contextValue, "env.running.k8s");
  // 여러 대·손볼 서버가 있는 환경만 펼쳐 둔다 (1 = Collapsed, 2 = Expanded)
  assert.deepEqual(
    ["dev", "my-k8s", "nopub"].map((n) => envItem(n).collapsibleState),
    [1, 2, 2]
  );
  assert.equal(serverItem(sid(5)).iconPath.id, "lock");
});

test("워커 접속: cp 항목과 ProxyJump 가 붙은 워커 항목을 쓰고 Remote-SSH 로 연다", async () => {
  fake.resetRecorded();
  await fake.commands.executeCommand("kloudhub.connect", serverItem(sid(2)));

  const w = sshG(ALIAS_W1);
  assert.equal(w.hostname, "10.0.0.11");
  assert.equal(w.user, "ubuntu", "이미지 OS 로 계정을 알아서 묻지 않는다");
  assert.equal(w.proxyjump, ALIAS_CP);
  assert.equal(w.hostkeyalias, ALIAS_W1);
  const c = sshG(ALIAS_CP);
  assert.equal(c.hostname, IP_CP);
  assert.equal(c.proxyjump, undefined);

  const open = fake.recorded.executed.find((e) => e.id === "vscode.newWindow");
  assert.deepEqual(open?.args[0], { remoteAuthority: `ssh-remote+${ALIAS_W1}`, reuseWindow: false });
  assert.equal(fake.settings["remote.SSH.remotePlatform"][ALIAS_W1], "linux");
});

test("공인 IP 없는 환경: 이유를 알리고 접속하지 않는다", async () => {
  fake.resetRecorded();
  fake.responders.message = () => undefined;
  await fake.commands.executeCommand("kloudhub.connect", serverItem(sid(4)));
  assert.ok(fake.recorded.messages.some((m) => m.level === "error" && /공인 IP 가 붙은 서버가 없어/.test(m.text)));
  assert.ok(!readFileSync(CONFIG, "utf8").includes("nopub"));
});

test("내 키가 없는 서버: 경고하고, 취소하면 접속하지 않는다", async () => {
  fake.resetRecorded();
  fake.responders.message = () => undefined;
  await fake.commands.executeCommand("kloudhub.copySshCommand", serverItem(sid(5)));
  assert.ok(fake.recorded.messages.some((m) => m.level === "warn" && /SSH 공개키가 서버에 들어 있지 않다/.test(m.text)));
  assert.equal(fake.recorded.clipboard, "");

  fake.responders.message = (_l, _t, items) => items.find((i) => i === "그래도 접속");
  await fake.commands.executeCommand("kloudhub.copySshCommand", serverItem(sid(5)));
  assert.equal(fake.recorded.clipboard, "ssh kloudhub--scratch-00000000");
});

test("정지된 환경의 서버에 접속하면 환경을 시작한 뒤 접속한다", async () => {
  fake.resetRecorded();
  fake.responders.message = (_l, _t, items) => items.find((i) => i === "시작 후 접속");
  await fake.commands.executeCommand("kloudhub.openTerminal", serverItem(sid(3)));
  assert.ok(mock.requests.some((r) => r.method === "POST" && r.path === "/api/v1/projects/lab/environments/dev/actions/start"));
  assert.equal(fake.recorded.terminals.length, 1);
  assert.deepEqual(fake.recorded.terminals[0].shellArgs, ["kloudhub--dev-vm0-00000000"]);
  assert.ok(outline().includes("  dev [개발 VM]"));
});

test("kubeconfig 받기: 0600 으로 저장하고 KUBECONFIG 명령을 복사한다", async () => {
  fake.resetRecorded();
  const target = path.join(HOME, ".kube", "lab-my-k8s.yaml");
  fake.responders.saveDialog = () => target;
  fake.responders.message = (_l, _t, items) => items[0];
  await fake.commands.executeCommand("kloudhub.downloadKubeconfig", envItem("my-k8s"));
  assert.ok(readFileSync(target, "utf8").includes(`server: https://${IP_CP}:6443`));
  assert.equal(statSync(target).mode & 0o777, 0o600);
  assert.equal(fake.recorded.clipboard, `export KUBECONFIG=${JSON.stringify(target)}`);
});

test("웹에서 열기: 환경 화면 주소", async () => {
  fake.resetRecorded();
  await fake.commands.executeCommand("kloudhub.openInWeb", envItem("my-k8s"));
  assert.deepEqual(fake.recorded.opened, [`${mock.endpoint}/p/lab/environments/my-k8s`]);
});

test("서버가 지워지면 새로고침 때 SSH config 항목도 지운다", async () => {
  mock.servers = mock.servers.filter((s) => s.id !== sid(2));
  await fake.commands.executeCommand("kloudhub.refresh");
  const text = readFileSync(CONFIG, "utf8");
  assert.ok(!text.includes(ALIAS_W1));
  assert.ok(text.includes(ALIAS_CP));
  assert.equal(fake.settings["remote.SSH.remotePlatform"][ALIAS_W1], undefined);
});

test("토큰이 만료되면 로그아웃하고 다시 로그인을 권한다", async () => {
  fake.resetRecorded();
  fake.responders.message = () => undefined;
  const saved = [...ctx._secrets.entries()];
  ctx._secrets.set("kloudhub.credentials", JSON.stringify({ endpoint: mock.endpoint + "/api/v1", token: "kh_expired_token" }));
  // 저장소를 바꿔도 메모리의 클라이언트는 그대로이므로 다시 활성화해 읽게 한다
  await ext.activate(ctx as any);
  await fake.commands.executeCommand("kloudhub.refresh");
  assert.equal(fake.recorded.contexts["kloudhub.loggedIn"], false);
  assert.equal(ctx._secrets.get("kloudhub.credentials"), undefined);
  assert.ok(fake.recorded.messages.some((m) => m.level === "error" && /토큰이 만료/.test(m.text)));
  for (const [k, v] of saved) ctx._secrets.set(k, v);
});
