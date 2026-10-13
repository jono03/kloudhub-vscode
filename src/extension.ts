import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { AuthStore, promptLogin } from "./auth";
import { buildProject, EnvNode, noRouteReason, ProjectNode, ServerNode } from "./inventory";
import { AuthError, ClientOptions, Credentials, KloudHubClient, webBase } from "./kloudhub/client";
import type { Me } from "./kloudhub/types";
import { localFingerprints, PUBKEY_RE } from "./keys";
import {
  findRemoteSshExtension,
  markRemotePlatformLinux,
  openRemote,
  openSshTerminal,
  removeRemotePlatform,
  resolveSshConfigPath,
  sshCommandLine,
} from "./remote";
import { editConfigFile, expandHome, HostEntry, listManagedEntries, makeAlias, upsertEntries } from "./sshConfig";
import { EnvItem, KloudHubTreeProvider, ServerItem } from "./tree";

const USERS_KEY = "kloudhub.sshUsers"; // 서버 id -> SSH 사용자명
const SSH_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}$/;

let log: vscode.LogOutputChannel;
let auth: AuthStore;
let client: KloudHubClient | undefined;
let me: Me | undefined;
let tree: KloudHubTreeProvider;
let ctx: vscode.ExtensionContext;
let refreshTimer: NodeJS.Timeout | undefined;

function clientOptions(): ClientOptions {
  const cfg = vscode.workspace.getConfiguration("kloudhub");
  return {
    allowSelfSigned: cfg.get<boolean>("allowSelfSignedCertificate", false),
    log: (l) => log.debug(l),
  };
}

function sshSettings() {
  const c = vscode.workspace.getConfiguration("kloudhub.ssh");
  const identity = c.get<string>("identityFile")?.trim();
  return {
    identityFile: identity ? expandHome(identity) : undefined,
    defaultUser: c.get<string>("defaultUser")?.trim() || undefined,
    allowPrivate: c.get<boolean>("allowPrivateAddress", false),
    openPath: c.get<string>("openPath")?.trim() || undefined,
  };
}

async function setClient(c: Credentials | undefined): Promise<void> {
  client = c ? new KloudHubClient(c, clientOptions()) : undefined;
  if (!client) me = undefined;
  await vscode.commands.executeCommand("setContext", "kloudhub.loggedIn", !!client);
  if (!client) tree.setLoggedOut();
}

/** API 호출 공통 처리: 401 이면 토큰을 버리고 다시 로그인을 권한다. */
async function withClient<T>(fn: (c: KloudHubClient) => Promise<T>): Promise<T | undefined> {
  if (!client) {
    const pick = await vscode.window.showWarningMessage("KloudHub 에 로그인되어 있지 않다.", "로그인");
    if (pick) await vscode.commands.executeCommand("kloudhub.login");
    return undefined;
  }
  try {
    return await fn(client);
  } catch (e: any) {
    if (e instanceof AuthError) {
      log.warn(`인증 실패: ${e.message}`);
      await auth.clear();
      await setClient(undefined);
      const pick = await vscode.window.showErrorMessage(
        "KloudHub API 토큰이 만료됐거나 올바르지 않다. 웹 설정에서 새 토큰을 발급해 다시 로그인할 것.",
        "다시 로그인"
      );
      if (pick) await vscode.commands.executeCommand("kloudhub.login");
      return undefined;
    }
    log.error(e?.stack ?? String(e));
    throw e;
  }
}

async function loadProject(c: KloudHubClient, p: Me["projects"][number], fps: Set<string>): Promise<ProjectNode> {
  try {
    const [envs, servers, publicIps, images] = await Promise.all([
      c.myEnvironments(p.code),
      c.instances(p.code),
      c.publicIps(p.code),
      // 이미지는 로그인 계정을 맞히는 데만 쓴다. 실패해도 목록은 보인다.
      c.images(p.code).catch((e) => {
        log.warn(`${p.code} 이미지 목록 실패(무시): ${e.message}`);
        return [];
      }),
    ]);
    return buildProject(
      p,
      { envs, servers, publicIps, images },
      { username: me!.username, localFingerprints: fps, allowPrivate: sshSettings().allowPrivate }
    );
  } catch (e: any) {
    if (e instanceof AuthError) throw e;
    log.warn(`${p.code} 불러오기 실패: ${e.message}`);
    return { project: p, envs: [], standalone: [], error: `불러오지 못했다: ${e.message}` };
  }
}

async function refresh(): Promise<void> {
  if (!client) return;
  try {
    const projects = await withClient(async (c) => {
      me = await c.me();
      const fps = await localFingerprints(sshSettings().identityFile);
      // 승인 대기·거둔 요청·보관된 프로젝트에는 접속할 서버가 없다
      const active = me.projects.filter((p) => p.status === "active");
      return Promise.all(active.map((p) => loadProject(c, p, fps)));
    });
    if (!projects) return;
    tree.setData(projects);
    // 한 프로젝트라도 실패했으면 지운 서버를 가려낼 수 없으므로 정리하지 않는다.
    if (projects.every((p) => !p.error)) await pruneSshConfig(new Set(tree.getServers().map((s) => s.res.id)));
  } catch (e: any) {
    tree.setError(`목록을 가져오지 못했다: ${e.message}`);
  }
}

/** 지워졌거나 더 이상 내 것이 아닌 서버의 SSH config 항목과 remotePlatform 설정을 지운다. */
async function pruneSshConfig(existing: Set<string>): Promise<void> {
  const configPath = resolveSshConfigPath();
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return;
  }
  const stale = listManagedEntries(text).filter((e) => !existing.has(e.vmId));
  if (!stale.length) return;
  await editConfigFile(configPath, (t) => upsertEntries(t, [], existing));
  await removeRemotePlatform(stale.map((s) => s.alias));
  log.info(`없어진 서버 항목 ${stale.length}개를 SSH config 에서 지웠다`);
}

function scheduleAutoRefresh(): void {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  const sec = vscode.workspace.getConfiguration("kloudhub").get<number>("refreshIntervalSeconds", 0);
  if (sec && sec >= 10) refreshTimer = setInterval(() => void refresh(), sec * 1000);
}

function findServer(id: string): ServerNode | undefined {
  return tree.getServers().find((s) => s.res.id === id);
}

function findEnv(project: string, name: string): EnvNode | undefined {
  return tree
    .getProjects()
    .find((p) => p.project.code === project)
    ?.envs.find((e) => e.env.name === name);
}

/** 명령 팔레트에서 부르면 서버를 고르게 한다. */
async function resolveServer(arg: unknown, filter?: (s: ServerNode) => boolean): Promise<ServerNode | undefined> {
  if (arg instanceof ServerItem) return findServer(arg.server.res.id) ?? arg.server;
  if (!client) {
    await vscode.commands.executeCommand("kloudhub.login");
    if (!client) return undefined;
  }
  if (!tree.getServers().length) await refresh();
  const list = tree.getServers().filter(filter ?? (() => true));
  if (!list.length) {
    vscode.window.showInformationMessage("고를 수 있는 서버가 없다.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    list.map((s) => ({
      label: s.envName ? `${s.envName} / ${s.label}` : s.label,
      description: [s.roleLabel, s.route.kind === "none" ? "접속 불가" : s.route.host].filter(Boolean).join(" · "),
      detail: s.project,
      s,
    })),
    { title: "서버 선택", matchOnDescription: true, matchOnDetail: true }
  );
  return pick?.s;
}

async function resolveEnv(arg: unknown, filter?: (e: EnvNode) => boolean): Promise<EnvNode | undefined> {
  if (arg instanceof EnvItem) return findEnv(arg.node.project, arg.node.env.name) ?? arg.node;
  if (!client) {
    await vscode.commands.executeCommand("kloudhub.login");
    if (!client) return undefined;
  }
  if (!tree.getProjects().length) await refresh();
  const list = tree
    .getProjects()
    .flatMap((p) => p.envs)
    .filter(filter ?? (() => true));
  if (!list.length) {
    vscode.window.showInformationMessage("고를 수 있는 환경이 없다.");
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    list.map((e) => ({ label: e.env.name, description: `${e.info.title} · ${e.env.state}`, detail: e.project, e })),
    { title: "환경 선택", matchOnDescription: true }
  );
  return pick?.e;
}

// ---------------------------------------------------------------------------
// 시작·정지 (환경 서버는 환경 단위로, 단독 인스턴스는 인스턴스 단위로)
// ---------------------------------------------------------------------------

async function runJob(title: string, submit: (c: KloudHubClient) => Promise<string>): Promise<boolean> {
  const r = await vscode.window
    .withProgress({ location: vscode.ProgressLocation.Notification, title: `${title}…` }, (progress) =>
      withClient(async (c) => {
        const jobId = await submit(c);
        log.info(`${title}: 작업 ${jobId}`);
        await c.waitForJob(jobId, { onState: (j) => progress.report({ message: j.state }) });
        return true;
      })
    )
    .then(
      (v) => v,
      (e: any) => {
        vscode.window.showErrorMessage(`${title} 실패: ${e.message}`);
        return false;
      }
    );
  await refresh();
  return !!r;
}

function envPower(e: EnvNode, action: "start" | "stop"): Promise<boolean> {
  return runJob(`환경 ${e.env.name} ${action === "start" ? "시작" : "정지"}`, (c) =>
    c.environmentAction(e.project, e.env.name, action)
  );
}

function instancePower(s: ServerNode, action: "start" | "stop"): Promise<boolean> {
  return runJob(`${s.label} ${action === "start" ? "시작" : "정지"}`, (c) => c.instanceAction(s.project, s.res.id, action));
}

async function startEnv(arg: unknown): Promise<void> {
  const e = await resolveEnv(arg, (e) => e.env.state === "stopped" || e.env.state === "failed");
  if (e) await envPower(e, "start");
}

async function stopEnv(arg: unknown): Promise<void> {
  const e = await resolveEnv(arg, (e) => e.env.state === "running" || e.env.state === "failed");
  if (!e) return;
  const ok = await vscode.window.showWarningMessage(
    `환경 ${e.env.name} 의 서버 ${e.servers.length}대를 모두 정지할까? 저장하지 않은 작업은 사라진다.`,
    { modal: true },
    "정지"
  );
  if (ok) await envPower(e, "stop");
}

async function startServer(arg: unknown): Promise<void> {
  const s = await resolveServer(arg, (s) => s.state === "stopped");
  if (!s) return;
  if (s.envName) {
    const e = findEnv(s.project, s.envName);
    if (e) await envPower(e, "start");
    return;
  }
  await instancePower(s, "start");
}

async function stopServer(arg: unknown): Promise<void> {
  const s = await resolveServer(arg, (s) => !s.envName && s.state === "running");
  if (!s) return;
  const ok = await vscode.window.showWarningMessage(
    `${s.label} 을(를) 정지할까? 저장하지 않은 작업은 사라진다.`,
    { modal: true },
    "정지"
  );
  if (ok) await instancePower(s, "stop");
}

// ---------------------------------------------------------------------------
// 접속
// ---------------------------------------------------------------------------

/** 정지된 서버면 시작을 권한다. 환경 서버는 환경을 시작한다(경유 서버도 같이 켜진다). */
async function ensureRunning(s: ServerNode): Promise<ServerNode | undefined> {
  const needsVia = s.route.kind === "jump" && s.route.via!.state !== "running";
  if (s.state === "running" && !needsVia) return s;
  if (s.state === "busy" || (s.route.via && s.route.via.state === "busy")) {
    vscode.window.showWarningMessage(`${s.label}: 상태가 바뀌는 중이다. 끝난 뒤 다시 시도할 것.`);
    return undefined;
  }
  if (s.state !== "stopped" && !needsVia) {
    vscode.window.showWarningMessage(`${s.label}: 서버 상태가 ${s.res.state ?? "알 수 없음"} 이라 접속할 수 없다.`);
    return undefined;
  }
  const what = s.envName ? `환경 ${s.envName}` : s.label;
  const pick = await vscode.window.showInformationMessage(`${what} 이(가) 정지 상태다. 시작한 뒤 접속할까?`, "시작 후 접속");
  if (!pick) return undefined;
  if (s.envName) {
    const e = findEnv(s.project, s.envName);
    if (!e || !(await envPower(e, "start"))) return undefined;
  } else if (!(await instancePower(s, "start"))) {
    return undefined;
  }
  const fresh = findServer(s.res.id);
  if (!fresh || fresh.state !== "running") {
    vscode.window.showWarningMessage(`${s.label}: 아직 실행 중으로 보이지 않는다. 잠시 뒤 다시 시도할 것.`);
    return undefined;
  }
  return fresh;
}

/** 이 PC 의 키가 서버에 없을 때 알린다. 계속하면 true. */
async function confirmKeys(s: ServerNode): Promise<boolean> {
  if (s.keys !== "missing" && s.keys !== "none") return true;
  if (s.passwordSsh) return true; // 비밀번호로 들어갈 수 있다
  const why =
    s.keys === "missing"
      ? "이 PC 의 SSH 공개키가 서버에 들어 있지 않다. 서버에는 만들 때 KloudHub 에 등록돼 있던 키만 들어간다."
      : "이 서버에는 만들 때 넣은 SSH 키가 없다(키를 등록하기 전에 만든 서버).";
  const pick = await vscode.window.showWarningMessage(
    `${s.label}: ${why} 그 키가 ssh-agent 에 있지 않다면 접속이 거절된다.`,
    { modal: true },
    "그래도 접속"
  );
  return pick === "그래도 접속";
}

async function sshUserFor(s: ServerNode, forcePrompt = false): Promise<string | undefined> {
  const users = ctx.globalState.get<Record<string, string>>(USERS_KEY, {});
  if (!forcePrompt && users[s.res.id]) return users[s.res.id];
  if (!forcePrompt && s.user && SSH_USER_RE.test(s.user)) return s.user;
  const def = sshSettings().defaultUser;
  if (!forcePrompt && def && SSH_USER_RE.test(def)) return def;
  const user = await vscode.window.showInputBox({
    title: `${s.label}: SSH 사용자명`,
    prompt: "이미지마다 다르다. 예: Ubuntu ubuntu, Rocky Linux rocky, Debian debian",
    value: users[s.res.id] ?? s.user ?? def ?? "",
    ignoreFocusOut: true,
    validateInput: (v) => (SSH_USER_RE.test(v.trim()) ? undefined : "영문·숫자·_ . - 만, 32자 이하"),
  });
  if (!user) return undefined;
  await ctx.globalState.update(USERS_KEY, { ...users, [s.res.id]: user.trim() });
  return user.trim();
}

function aliasFor(s: ServerNode): string {
  return makeAlias(s.envName ? `${s.envName}-${s.label}` : s.label, s.res.id);
}

/** 접속 전 공통 단계: 실행 확인 → 경로 → 키 → 사용자 → SSH config 기록. 별칭을 돌려준다. */
async function prepareSsh(arg: unknown): Promise<{ alias: string; server: ServerNode; configPath: string } | undefined> {
  let s = await resolveServer(arg);
  if (!s) return undefined;
  if (s.route.kind === "none") {
    const pick = await vscode.window.showErrorMessage(`${s.label}: 접속할 수 없다. ${noRouteReason(s)}`, "웹에서 열기");
    if (pick) await openServerInWeb(s);
    return undefined;
  }
  s = await ensureRunning(s);
  if (!s) return undefined;
  if (s.route.kind === "none") return undefined;
  if (!(await confirmKeys(s))) return undefined;
  const user = await sshUserFor(s);
  if (!user) return undefined;

  const { identityFile } = sshSettings();
  const entries: HostEntry[] = [];
  let proxyJump: string | undefined;
  const via = s.route.kind === "jump" ? s.route.via : undefined;
  if (via) {
    const viaUser = await sshUserFor(via);
    if (!viaUser) return undefined;
    proxyJump = aliasFor(via);
    entries.push({ vmId: via.res.id, alias: proxyJump, hostName: via.publicIp!, port: via.route.port, user: viaUser, identityFile });
  }
  const alias = aliasFor(s);
  entries.push({ vmId: s.res.id, alias, hostName: s.route.host!, port: s.route.port, user, identityFile, proxyJump });
  const configPath = resolveSshConfigPath();
  const r = await editConfigFile(configPath, (t) => upsertEntries(t, entries));
  if (r.changed) log.info(`${r.path} 에 ${alias} 기록 (${s.route.label}, user=${user})`);
  return { alias, server: s, configPath };
}

async function connect(arg: unknown, newWindow: boolean): Promise<void> {
  const remoteExt = findRemoteSshExtension();
  if (!remoteExt) {
    const pick = await vscode.window.showWarningMessage(
      "Remote - SSH 확장이 없다. 설치하면 서버 안의 파일을 VS Code 창으로 바로 연다.",
      "Remote - SSH 설치",
      "SSH 터미널로 열기"
    );
    if (pick === "Remote - SSH 설치") {
      await vscode.commands.executeCommand("workbench.extensions.installExtension", "ms-vscode-remote.remote-ssh");
      vscode.window.showInformationMessage("설치가 끝나면 다시 접속을 누를 것.");
    } else if (pick === "SSH 터미널로 열기") {
      await openTerminal(arg);
    }
    return;
  }
  const prep = await prepareSsh(arg);
  if (!prep) return;
  await markRemotePlatformLinux(prep.alias);
  log.info(`Remote-SSH(${remoteExt.id}) 로 ${prep.alias} 열기`);
  await openRemote(prep.alias, newWindow, sshSettings().openPath);
}

async function openTerminal(arg: unknown): Promise<void> {
  const prep = await prepareSsh(arg);
  if (!prep) return;
  openSshTerminal(prep.alias, prep.server.label, prep.configPath);
}

async function copySshCommand(arg: unknown): Promise<void> {
  const prep = await prepareSsh(arg);
  if (!prep) return;
  const cmd = sshCommandLine(prep.alias, prep.configPath);
  await vscode.env.clipboard.writeText(cmd);
  vscode.window.showInformationMessage(`복사했다: ${cmd}`);
}

// ---------------------------------------------------------------------------
// 환경 부가 기능: kubeconfig, 웹에서 열기
// ---------------------------------------------------------------------------

async function downloadKubeconfig(arg: unknown): Promise<void> {
  const e = await resolveEnv(arg, (e) => e.env.template === "k8s");
  if (!e) return;
  const text = await withClient((c) => c.kubeconfig(e.project, e.env.name)).catch((err: any) => {
    vscode.window.showErrorMessage(`kubeconfig 받기 실패: ${err.message}`);
    return undefined;
  });
  if (!text) return;
  const target = await vscode.window.showSaveDialog({
    title: `${e.env.name} kubeconfig 저장`,
    defaultUri: vscode.Uri.file(path.join(os.homedir(), ".kube", `kloudhub-${e.project}-${e.env.name}.yaml`)),
  });
  if (!target) return;
  await fs.mkdir(path.dirname(target.fsPath), { recursive: true, mode: 0o700 });
  // 클라이언트 인증서와 개인키가 들어 있다
  await fs.writeFile(target.fsPath, text, { mode: 0o600 });
  await fs.chmod(target.fsPath, 0o600).catch(() => undefined);
  const cmd = `export KUBECONFIG=${JSON.stringify(target.fsPath)}`;
  const pick = await vscode.window.showInformationMessage(
    `kubeconfig 를 저장했다(인증서 90일 유효): ${target.fsPath}`,
    "KUBECONFIG 명령 복사"
  );
  if (pick) await vscode.env.clipboard.writeText(cmd);
}

async function openInBrowser(p: string): Promise<void> {
  if (!client) return;
  await vscode.env.openExternal(vscode.Uri.parse(webBase(client.credentials.endpoint) + p));
}

async function openServerInWeb(s: ServerNode): Promise<void> {
  const p = encodeURIComponent(s.project);
  await openInBrowser(
    s.envName ? `/p/${p}/environments/${encodeURIComponent(s.envName)}` : `/p/${p}/instances/${encodeURIComponent(s.res.id)}`
  );
}

async function openInWeb(arg: unknown): Promise<void> {
  if (arg instanceof ServerItem) return openServerInWeb(arg.server);
  const e = arg instanceof EnvItem ? arg.node : await resolveEnv(arg);
  if (e) await openInBrowser(`/p/${encodeURIComponent(e.project)}/environments/${encodeURIComponent(e.env.name)}`);
}

// ---------------------------------------------------------------------------
// SSH 공개키 등록
// ---------------------------------------------------------------------------

async function registerSshKey(): Promise<void> {
  const sshDir = path.join(os.homedir(), ".ssh");
  let pubs: string[] = [];
  try {
    pubs = (await fs.readdir(sshDir)).filter((f) => f.endsWith(".pub")).map((f) => path.join(sshDir, f));
  } catch {
    /* ~/.ssh 없음 */
  }
  const OTHER = "$(folder-opened) 다른 파일 선택…";
  const pick = await vscode.window.showQuickPick([...pubs, OTHER], {
    title: "KloudHub 에 등록할 공개키",
    placeHolder: pubs.length ? undefined : "~/.ssh 에 공개키가 없다. ssh-keygen -t ed25519 로 먼저 만들 것",
  });
  if (!pick) return;
  let pubPath = pick;
  if (pick === OTHER) {
    const sel = await vscode.window.showOpenDialog({ canSelectMany: false, defaultUri: vscode.Uri.file(sshDir) });
    if (!sel?.length) return;
    pubPath = sel[0].fsPath;
  }
  const publicKey = (await fs.readFile(pubPath, "utf8")).trim();
  if (!PUBKEY_RE.test(publicKey) || publicKey.includes("\n")) {
    vscode.window.showErrorMessage("OpenSSH 공개키 한 줄이 아니다. 개인키를 고르지 않았는지 확인할 것. (DSA 키는 받지 않는다)");
    return;
  }
  const defName = `vscode-${os.hostname()}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 60);
  const name = await vscode.window.showInputBox({
    title: "KloudHub 에 보일 키 이름",
    value: defName,
    validateInput: (v) => (v.trim().length >= 1 && v.trim().length <= 64 ? undefined : "1~64자"),
  });
  if (!name) return;
  const ok = await withClient((c) => c.addSshKey(publicKey, name.trim())).catch((e: any) => {
    vscode.window.showErrorMessage(`키 등록 실패: ${e.message}`);
    return undefined;
  });
  if (!ok) return;
  const privPath = pubPath.replace(/\.pub$/, "");
  const cfg = vscode.workspace.getConfiguration("kloudhub.ssh");
  const hasPriv = await fs.stat(privPath).then(
    () => true,
    () => false
  );
  const actions = hasPriv && !cfg.get<string>("identityFile") ? ["이 키를 접속에 사용"] : [];
  const sel = await vscode.window.showInformationMessage(
    `키 '${ok.name}' 을(를) 등록했다. 앞으로 만드는 환경·인스턴스에 들어간다. 이미 있는 서버에는 들어가지 않는다.`,
    ...actions
  );
  if (sel) await cfg.update("identityFile", privPath, vscode.ConfigurationTarget.Global);
  await refresh();
}

// ---------------------------------------------------------------------------
// 로그인
// ---------------------------------------------------------------------------

async function login(): Promise<void> {
  try {
    const r = await promptLogin(client?.credentials ?? (await auth.load()), clientOptions());
    if (!r) return;
    await auth.save(r.creds);
    await setClient(r.creds);
    me = r.me;
    log.info(`로그인: ${webBase(r.creds.endpoint)} (${r.me.username})`);
    await refresh();
  } catch (e: any) {
    log.error(e?.stack ?? String(e));
    vscode.window.showErrorMessage(`로그인 실패: ${e.message}`);
  }
}

async function logout(): Promise<void> {
  await auth.clear();
  await setClient(undefined);
  log.info("로그아웃 (토큰은 이 PC 에서만 지웠다. 폐기하려면 웹 설정 → API 토큰)");
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ctx = context;
  log = vscode.window.createOutputChannel("KloudHub", { log: true });
  auth = new AuthStore(context.secrets);
  tree = new KloudHubTreeProvider();
  const view = vscode.window.createTreeView("kloudhub.servers", { treeDataProvider: tree, showCollapseAll: true });

  const reg = (id: string, fn: (...a: any[]) => any) => vscode.commands.registerCommand(id, fn);
  context.subscriptions.push(
    log,
    view,
    reg("kloudhub.login", login),
    reg("kloudhub.logout", logout),
    reg("kloudhub.refresh", refresh),
    reg("kloudhub.connect", (a) => connect(a, true)),
    reg("kloudhub.connectCurrentWindow", (a) => connect(a, false)),
    reg("kloudhub.openTerminal", openTerminal),
    reg("kloudhub.copySshCommand", copySshCommand),
    reg("kloudhub.setSshUser", async (a) => {
      const s = await resolveServer(a);
      if (s) await sshUserFor(s, true);
    }),
    reg("kloudhub.startServer", startServer),
    reg("kloudhub.stopServer", stopServer),
    reg("kloudhub.startEnv", startEnv),
    reg("kloudhub.stopEnv", stopEnv),
    reg("kloudhub.downloadKubeconfig", downloadKubeconfig),
    reg("kloudhub.openInWeb", openInWeb),
    reg("kloudhub.registerSshKey", registerSshKey),
    reg("kloudhub.openSshConfig", async () => {
      const p = resolveSshConfigPath();
      try {
        await vscode.window.showTextDocument(vscode.Uri.file(p));
      } catch {
        vscode.window.showInformationMessage(`아직 파일이 없다: ${p}`);
      }
    }),
    view.onDidChangeVisibility((e) => {
      if (e.visible) void refresh();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kloudhub.refreshIntervalSeconds")) scheduleAutoRefresh();
      if (e.affectsConfiguration("kloudhub.ssh.allowPrivateAddress") || e.affectsConfiguration("kloudhub.ssh.identityFile")) {
        void refresh();
      }
      if (e.affectsConfiguration("kloudhub.allowSelfSignedCertificate") && client) {
        client = new KloudHubClient(client.credentials, clientOptions());
      }
    }),
    { dispose: () => refreshTimer && clearInterval(refreshTimer) }
  );

  await setClient(await auth.load());
  scheduleAutoRefresh();
  if (client && view.visible) await refresh();
}

export function deactivate(): void {
  if (refreshTimer) clearInterval(refreshTimer);
}
