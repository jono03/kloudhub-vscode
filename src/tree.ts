import * as vscode from "vscode";
import {
  allServers,
  ENV_STATE_LABEL,
  EnvNode,
  keyBlocked,
  noRouteReason,
  ProjectNode,
  SERVER_STATE_LABEL,
  ServerNode,
} from "./inventory";

function md(text: string): string {
  // 서버에서 온 문자열을 마크다운 툴팁에 넣기 전에 특수문자를 이스케이프한다.
  return text.replace(/[\\`*_{}\[\]()#+\-.!|<>]/g, "\\$&");
}

function serverIcon(s: ServerNode): vscode.ThemeIcon {
  switch (s.state) {
    case "running":
      return new vscode.ThemeIcon("vm-running", new vscode.ThemeColor("testing.iconPassed"));
    case "busy":
      return new vscode.ThemeIcon("loading~spin");
    case "stopped":
      return new vscode.ThemeIcon("vm-outline", new vscode.ThemeColor("disabledForeground"));
    case "error":
      return new vscode.ThemeIcon("vm", new vscode.ThemeColor("testing.iconFailed"));
    default:
      return new vscode.ThemeIcon("vm");
  }
}

export class ServerItem extends vscode.TreeItem {
  constructor(readonly server: ServerNode) {
    super(server.label, vscode.TreeItemCollapsibleState.None);
    const s = server;
    this.id = `server:${s.res.id}`;
    // 설명은 접속할 곳 하나만. 역할·사설 IP·로그인 방식은 툴팁에 둔다.
    // 키가 없어도 SSH 비밀번호 로그인이 켜져 있으면 들어갈 수 있으므로 그때는 표시하지 않는다.
    const blocked = keyBlocked(s);
    const where =
      s.route.kind === "direct"
        ? s.publicIp
        : s.route.kind === "jump"
          ? `${s.route.via!.label} 경유`
          : s.route.kind === "private"
            ? `사설 ${s.route.host}`
            : "접속 불가";
    const state = s.state === "running" ? undefined : SERVER_STATE_LABEL[(s.res.state ?? "").toUpperCase()];
    this.description = [blocked ? "키 없음" : where, state].filter(Boolean).join(" · ");
    this.iconPath = blocked && s.route.kind !== "none" ? new vscode.ThemeIcon("lock", new vscode.ThemeColor("list.warningForeground")) : serverIcon(s);
    // 메뉴 when 절: server.<running|stopped|busy|error|unknown>.<direct|jump|private|none>[.solo]
    this.contextValue = `server.${s.state}.${s.route.kind}${s.envName ? "" : ".solo"}`;

    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = false;
    const stateText = SERVER_STATE_LABEL[(s.res.state ?? "").toUpperCase()] ?? s.res.state ?? "알 수 없음";
    tip.appendMarkdown(`**${md(s.label)}** · ${md(stateText)}\n\n`);
    const rows: [string, string | undefined][] = [
      ["접속", s.route.kind === "none" ? "불가" : s.route.kind === "jump" ? `${s.route.via!.label} 경유` : s.route.host],
      ["계정", s.user],
      ["환경", s.envName],
    ];
    for (const [k, v] of rows) if (v) tip.appendMarkdown(`${k}: ${md(String(v))}  \n`);
    const desc = typeof s.res.spec.description === "string" ? s.res.spec.description.trim() : "";
    if (desc) tip.appendMarkdown(`\n${md(desc)}\n`);
    // 문제가 있을 때만 한 줄 덧붙인다
    if (s.route.kind === "none") {
      tip.appendMarkdown(`\n$(warning) ${md(noRouteReason(s))}\n`);
    } else if (s.keys === "missing") {
      tip.appendMarkdown(`\n$(warning) 이 PC 의 SSH 키가 서버에 없다. 접속이 거절될 수 있다.\n`);
    } else if (s.keys === "none") {
      tip.appendMarkdown(`\n$(warning) 이 서버에는 SSH 키가 등록돼 있지 않다.\n`);
    }
    this.tooltip = tip;
  }
}

export class EnvItem extends vscode.TreeItem {
  constructor(readonly node: EnvNode) {
    // 여러 대인 환경과 손볼 서버(접속 불가·키 없음)가 있는 환경만 펼쳐 둔다
    const open = node.servers.length > 1 || node.servers.some((s) => keyBlocked(s) || s.route.kind === "none");
    super(node.env.name, open ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    const e = node.env;
    this.id = `env:${node.project}:${e.id}`;
    const p = e.progress;
    const state = ENV_STATE_LABEL[e.state] ?? e.state;
    // 실행 중은 쓰지 않는다(서버 아이콘 색으로 보인다)
    const shownState = e.state === "running" ? undefined : `${state}${p && p.total ? ` ${p.done}/${p.total}` : ""}`;
    this.description = [node.info.short, shownState].filter(Boolean).join(" · ");
    this.iconPath = new vscode.ThemeIcon(
      node.info.icon,
      e.state === "failed" ? new vscode.ThemeColor("testing.iconFailed") : undefined
    );
    // 메뉴 when 절: env.<상태>[.k8s]
    this.contextValue = `env.${e.state}${e.template === "k8s" ? ".k8s" : ""}`;
    const tip = new vscode.MarkdownString(undefined, true);
    tip.isTrusted = false;
    tip.appendMarkdown(`**${md(e.name)}** · ${md(state)}\n\n`);
    const rows: [string, string | undefined][] = [
      ["종류", node.info.title],
      ["서버", `${node.servers.length}대`],
      ["진행", p && p.total ? `${p.done}/${p.total} 단계${p.step ? ` · ${p.step}` : ""}` : undefined],
    ];
    for (const [k, v] of rows) if (v) tip.appendMarkdown(`${k}: ${md(v)}  \n`);
    if (e.description) tip.appendMarkdown(`\n${md(e.description)}\n`);
    this.tooltip = tip;
  }
}

export class ProjectItem extends vscode.TreeItem {
  constructor(readonly node: ProjectNode) {
    super(node.project.name || node.project.code, vscode.TreeItemCollapsibleState.Expanded);
    this.id = `project:${node.project.code}`;
    const empty = !node.envs.length && !node.standalone.length;
    const code = node.project.name && node.project.name !== node.project.code ? node.project.code : undefined;
    this.description = node.error ? "불러오기 실패" : [code, empty ? "환경 없음" : undefined].filter(Boolean).join(" · ");
    if (empty && !node.error) this.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    this.iconPath = new vscode.ThemeIcon(node.error ? "warning" : "project");
    this.contextValue = "project";
    this.tooltip = node.error ? `${node.project.code}\n${node.error}` : node.project.code;
  }
}

export class StandaloneGroupItem extends vscode.TreeItem {
  constructor(readonly node: ProjectNode) {
    super("독립 인스턴스", vscode.TreeItemCollapsibleState.Expanded);
    this.id = `solo:${node.project.code}`;
    this.description = `${node.standalone.length}`;
    this.iconPath = new vscode.ThemeIcon("inbox");
    this.contextValue = "standalone";
    this.tooltip = "환경에 속하지 않은 내 인스턴스";
  }
}

export class InfoItem extends vscode.TreeItem {
  constructor(label: string, icon: string, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.iconPath = new vscode.ThemeIcon(icon);
    this.command = command;
    this.contextValue = "info";
  }
}

export class KloudHubTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private projects: ProjectNode[] = [];
  private error: string | undefined;
  private loggedIn = false;
  private account: string | undefined;

  setAccount(label: string | undefined): void {
    this.account = label;
    this.emitter.fire();
  }

  setLoggedOut(): void {
    this.loggedIn = false;
    this.account = undefined;
    this.projects = [];
    this.error = undefined;
    this.emitter.fire();
  }

  setData(projects: ProjectNode[]): void {
    this.loggedIn = true;
    this.projects = projects;
    this.error = undefined;
    this.emitter.fire();
  }

  setError(message: string): void {
    this.error = message;
    this.emitter.fire();
  }

  getProjects(): ProjectNode[] {
    return this.projects;
  }

  getServers(): ServerNode[] {
    return allServers(this.projects);
  }

  getTreeItem(e: vscode.TreeItem): vscode.TreeItem {
    return e;
  }

  getChildren(e?: vscode.TreeItem): vscode.TreeItem[] {
    if (!this.loggedIn) return []; // 로그인 전에는 viewsWelcome 이 보인다
    if (!e) {
      const items: vscode.TreeItem[] = [];
      if (this.account) {
        const a = new InfoItem(this.account, "account", { command: "kloudhub.account", title: "계정" });
        a.tooltip = "누르면 로그아웃·웹 열기 메뉴가 나온다";
        items.push(a);
      }
      if (this.error) {
        items.push(new InfoItem(this.error, "error", { command: "kloudhub.refresh", title: "새로고침" }));
      }
      if (!this.projects.length && !this.error) items.push(new InfoItem("속한 프로젝트가 없다", "info"));
      for (const p of this.projects) items.push(new ProjectItem(p));
      return items;
    }
    if (e instanceof ProjectItem) {
      const n = e.node;
      if (n.error) return [new InfoItem(n.error, "error", { command: "kloudhub.refresh", title: "새로고침" })];
      const items: vscode.TreeItem[] = n.envs.map((env) => new EnvItem(env));
      if (n.standalone.length) items.push(new StandaloneGroupItem(n));
      if (!items.length) items.push(new InfoItem("내 환경·인스턴스가 없다", "info"));
      return items;
    }
    if (e instanceof EnvItem) {
      if (!e.node.servers.length) {
        return [new InfoItem(e.node.env.state === "creating" ? "서버를 만드는 중" : "서버가 없다", "info")];
      }
      return e.node.servers.map((s) => new ServerItem(s));
    }
    if (e instanceof StandaloneGroupItem) return e.node.standalone.map((s) => new ServerItem(s));
    return [];
  }
}
