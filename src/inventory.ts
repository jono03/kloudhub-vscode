import type { Environment, Image, MyProject, Resource } from "./kloudhub/types";

/**
 * API 응답을 사이드바 트리 모양(프로젝트 → 환경 → 서버, 그리고 단독 인스턴스 묶음)으로 바꾸고,
 * 서버마다 SSH 로 닿는 경로와 내 키가 들어 있는지를 계산한다. vscode 에 의존하지 않는다.
 *
 * KloudHub 는 보통 환경 하나에 공인 IP 하나다(k8s 는 cp, swarm 은 mgr). 공인 IP 가 없는 서버는
 * 같은 환경의 공인 IP 서버를 ProxyJump 로 거친다. 환경 안 서버끼리는 보안그룹이 열려 있다.
 * 관리용 경유 서버(kh-jump)는 사용자 키가 없는 nologin 계정이라 경로로 쓰지 않는다.
 */

export type ServerState = "running" | "stopped" | "busy" | "error" | "unknown";

export type RouteKind = "direct" | "jump" | "private" | "none";

export interface Route {
  kind: RouteKind;
  /** ssh 가 붙을 주소. jump 이면 사설 IP */
  host?: string;
  port: number;
  /** jump 일 때 거칠 서버 */
  via?: ServerNode;
  /** 트리 설명·툴팁용 한 줄 */
  label: string;
}

/**
 * ok: 이 PC 의 공개키 중 하나가 서버에 들어 있다
 * missing: 서버에 넣은 키 기록이 있는데 이 PC 의 키와 겹치지 않는다
 * none: 만들 때 넣은 키가 하나도 없다(키 등록 전에 만든 서버)
 * unknown: 기록이 없는 옛 서버이거나 이 PC 의 공개키 파일을 못 찾았다
 */
export type KeyStatus = "ok" | "missing" | "none" | "unknown";

export interface ServerNode {
  res: Resource;
  project: string;
  /** 환경 서버면 환경 이름, 단독 인스턴스면 undefined */
  envName?: string;
  /** 트리에 보일 이름(kh-<프로젝트>-<환경>- 접두사를 뗀 것) */
  label: string;
  role?: string;
  roleLabel?: string;
  state: ServerState;
  privateIp?: string;
  publicIp?: string;
  /** 로그인 계정(정한 비밀번호 계정 → 이미지 OS 기본 계정). 모르면 undefined */
  user?: string;
  /** SSH 비밀번호 로그인이 켜져 있다 */
  passwordSsh: boolean;
  route: Route;
  keys: KeyStatus;
}

export interface TemplateInfo {
  title: string;
  /** 트리 설명에 쓰는 짧은 이름 */
  short: string;
  /** codicon 이름 */
  icon: string;
}

export interface EnvNode {
  env: Environment;
  project: string;
  info: TemplateInfo;
  servers: ServerNode[];
}

export interface ProjectNode {
  project: MyProject;
  envs: EnvNode[];
  /** 환경에 속하지 않은 내 인스턴스 */
  standalone: ServerNode[];
  error?: string;
}

export interface ProjectData {
  envs: Environment[];
  servers: Resource[];
  publicIps: Resource[];
  images: Image[];
}

export interface BuildOptions {
  username: string;
  /** 이 PC 의 공개키 지문 */
  localFingerprints: Set<string>;
  /** 공인 경로가 없을 때 사설 IP 로 직접 시도(VPN 등) */
  allowPrivate: boolean;
  sshPort?: number;
}

/** 템플릿 코드 → 화면 이름(templates/seed/<code>/template.yaml 의 title)과 아이콘 */
const TEMPLATES: Record<string, TemplateInfo> = {
  "dev-vm": { title: "개발 VM", short: "개발 VM", icon: "vm" },
  "docker-host": { title: "Docker 호스트", short: "Docker 호스트", icon: "package" },
  database: { title: "데이터베이스", short: "데이터베이스", icon: "database" },
  minio: { title: "S3 호환 저장소 (MinIO)", short: "S3 저장소", icon: "archive" },
  "s3-store": { title: "S3 호환 저장소 (Garage)", short: "S3 저장소", icon: "archive" },
  registry: { title: "컨테이너 레지스트리 (Harbor)", short: "레지스트리", icon: "library" },
  gitlab: { title: "GitLab + Runner", short: "GitLab", icon: "git-merge" },
  jenkins: { title: "Jenkins", short: "Jenkins", icon: "tools" },
  "ci-runner": { title: "CI 러너", short: "CI 러너", icon: "run-all" },
  k8s: { title: "쿠버네티스", short: "쿠버네티스", icon: "type-hierarchy" },
  "docker-swarm": { title: "Docker Swarm", short: "Docker Swarm", icon: "layers" },
};

export function templateInfo(code: string | null | undefined): TemplateInfo {
  if (!code) return { title: "인스턴스 묶음", short: "인스턴스 묶음", icon: "folder" };
  return TEMPLATES[code] ?? { title: code, short: code, icon: "server-environment" };
}

/** 템플릿 역할 → 화면 이름. 정렬 순서도 이 순서(제어·매니저 노드가 위) */
const ROLES: [string, string][] = [
  ["cp", "제어 노드"],
  ["mgr", "매니저"],
  ["mgrx", "매니저"],
  ["vm", "VM"],
  ["db", "DB"],
  ["gitlab", "GitLab"],
  ["jenkins", "Jenkins"],
  ["harbor", "Harbor"],
  ["minio", "MinIO"],
  ["store", "저장소"],
  ["runner", "러너"],
  ["worker", "워커"],
];
const ROLE_LABEL = new Map(ROLES);
const ROLE_RANK = new Map(ROLES.map(([r], i) => [r, i]));

export function roleLabel(role: string | undefined): string | undefined {
  return role ? ROLE_LABEL.get(role) ?? role : undefined;
}

/** 이미지 OS → 기본 로그인 계정(backend api/routes/environments.py DEFAULT_USERS 와 같다) */
const DEFAULT_USERS: Record<string, string> = {
  ubuntu: "ubuntu",
  debian: "debian",
  rocky: "rocky",
  almalinux: "almalinux",
  centos: "centos",
  fedora: "fedora",
};

export function serverState(raw: string | null | undefined): ServerState {
  const s = (raw ?? "").toUpperCase();
  if (s === "ACTIVE" || s === "RUNNING") return "running";
  if (s === "STOPPED" || s === "SHUTOFF") return "stopped";
  if (s === "ERROR") return "error";
  if (!s || s === "UNKNOWN" || s === "MISSING") return "unknown";
  return "busy";
}

export const SERVER_STATE_LABEL: Record<string, string> = {
  ACTIVE: "실행 중",
  STOPPED: "정지됨",
  SHUTOFF: "정지됨",
  BUILDING: "생성 중",
  STARTING: "시작 중",
  STOPPING: "정지 중",
  REBOOTING: "재시작 중",
  RESIZING: "크기 변경 중",
  VERIFY_RESIZE: "크기 변경 중",
  ERROR: "오류",
  DELETING: "삭제 중",
  MISSING: "사라짐",
};

export const ENV_STATE_LABEL: Record<string, string> = {
  creating: "만드는 중",
  running: "실행 중",
  stopping: "정지 중",
  stopped: "정지됨",
  starting: "시작 중",
  restarting: "재시작 중",
  deleting: "삭제 중",
  failed: "실패",
};

/** 첫 IPv4 사설 주소. OpenStack 은 붙은 공인 IP 도 addresses 에 넣으므로 공인 IP 는 뺀다. */
function firstAddress(spec: Resource["spec"], publicAddrs: Set<string>): string | undefined {
  for (const list of Object.values(spec.addresses ?? {})) {
    const ip = Array.isArray(list)
      ? list.find((a) => typeof a === "string" && a.includes(".") && !publicAddrs.has(a))
      : undefined;
    if (ip) return ip;
  }
  return undefined;
}

/** `kh-<프로젝트>-<환경>-cp1` → `cp1`, `kh-<프로젝트>-solo-scratch` → `scratch` */
function shortName(r: Resource, project: string): string {
  const shown = typeof r.spec.display_name === "string" ? r.spec.display_name.trim() : "";
  if (shown) return shown;
  // backend core/naming.py: 환경 서버 kh-{project}-{env}-{role}{n}, 단독 kh-{project}-solo-{name}
  const prefix = r.env_id ? `kh-${project}-${r.env_id}-` : `kh-${project}-solo-`;
  if (r.name.startsWith(prefix) && r.name.length > prefix.length) return r.name.slice(prefix.length);
  // 환경 이름을 바꿨거나 길어서 잘린 이름은 접두사가 다르다. 끝의 {role}{n} 만 쓴다.
  const role = r.spec.role?.replace(/[^a-z0-9]/g, "");
  const m = role ? r.name.match(new RegExp(`-(${role}\\d*)$`)) : null;
  return m ? m[1] : r.name;
}

function keyStatus(r: Resource, local: Set<string>): KeyStatus {
  const keys = r.spec.keys;
  if (!Array.isArray(keys)) return "unknown";
  if (!keys.length) return "none";
  if (!local.size) return "unknown";
  return keys.some((k) => k?.fingerprint && local.has(k.fingerprint)) ? "ok" : "missing";
}

/** 경유 서버의 키 상태가 더 나쁘면 그것을 쓴다(첫 단계에서 막히므로) */
const KEY_SEVERITY: Record<KeyStatus, number> = { ok: 0, unknown: 1, none: 2, missing: 3 };

function compareServers(a: ServerNode, b: ServerNode): number {
  const ra = ROLE_RANK.get(a.role ?? "") ?? 50;
  const rb = ROLE_RANK.get(b.role ?? "") ?? 50;
  return ra - rb || a.label.localeCompare(b.label, undefined, { numeric: true });
}

export function buildProject(project: MyProject, data: ProjectData, o: BuildOptions): ProjectNode {
  const port = o.sshPort ?? 22;
  const osById = new Map(data.images.map((i) => [i.id, (i.os ?? "").toLowerCase()]));
  const publicByServer = new Map<string, { address: string; privateAddress?: string }>();
  for (const ip of data.publicIps) {
    const sid = ip.spec.server;
    const addr = ip.spec.address;
    if (sid && addr && !publicByServer.has(sid)) {
      publicByServer.set(sid, { address: addr, privateAddress: ip.spec.private_address ?? undefined });
    }
  }
  const publicAddrs = new Set([...publicByServer.values()].map((p) => p.address));
  const myEnvs = new Map(data.envs.filter((e) => e.state !== "deleted").map((e) => [e.name, e]));

  const toNode = (r: Resource): ServerNode => {
    const pub = publicByServer.get(r.id);
    const login = r.spec.login ?? undefined;
    const os = r.spec.image ? osById.get(r.spec.image) : undefined;
    return {
      res: r,
      project: project.code,
      envName: r.env_id ?? undefined,
      label: shortName(r, project.code),
      role: r.spec.role,
      roleLabel: roleLabel(r.spec.role),
      state: serverState(r.state),
      privateIp: pub?.privateAddress || firstAddress(r.spec, publicAddrs),
      publicIp: pub?.address,
      user: login?.user || (os ? DEFAULT_USERS[os] : undefined),
      passwordSsh: !!login?.ssh,
      route: { kind: "none", port, label: "" },
      keys: keyStatus(r, o.localFingerprints),
    };
  };

  const alive = data.servers.filter(
    (r) => r.kind === "server" && r.spec.mgmt !== "jump" && (r.state ?? "").toUpperCase() !== "DELETED"
  );
  const byEnv = new Map<string, ServerNode[]>();
  const standalone: ServerNode[] = [];
  for (const r of alive) {
    if (r.env_id) {
      if (!myEnvs.has(r.env_id)) continue; // 남의 환경
      const list = byEnv.get(r.env_id) ?? [];
      list.push(toNode(r));
      byEnv.set(r.env_id, list);
    } else if (r.owner === o.username) {
      standalone.push(toNode(r));
    }
  }

  for (const list of byEnv.values()) assignRoutes(list, o, port);
  assignRoutes(standalone, o, port, false);
  standalone.sort(compareServers);

  const envs: EnvNode[] = [...myEnvs.values()]
    .map((env) => ({
      env,
      project: project.code,
      info: templateInfo(env.template),
      servers: (byEnv.get(env.name) ?? []).sort(compareServers),
    }))
    .sort((a, b) => a.env.name.localeCompare(b.env.name, undefined, { numeric: true }));

  return { project, envs, standalone };
}

/**
 * 1) 자기 공인 IP  2) 같은 묶음의 공인 IP 서버를 거쳐 사설 IP(환경 안에서만)  3) 설정했으면 사설 IP 직접
 * 경유 서버는 실행 중인 것 → 역할 순서(cp·mgr 먼저) → 이름 순으로 고른다.
 */
function assignRoutes(list: ServerNode[], o: BuildOptions, port: number, sameEnvJump = true): void {
  const gateways = list
    .filter((s) => s.publicIp)
    .sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || compareServers(a, b));
  for (const s of list) {
    if (s.publicIp) {
      s.route = { kind: "direct", host: s.publicIp, port, label: `공인 IP ${s.publicIp}` };
      continue;
    }
    const via = sameEnvJump ? gateways.find((g) => g !== s) : undefined;
    if (via && s.privateIp) {
      s.route = {
        kind: "jump",
        host: s.privateIp,
        port,
        via,
        label: `${s.privateIp} (${via.label} 경유)`,
      };
      if (KEY_SEVERITY[via.keys] > KEY_SEVERITY[s.keys]) s.keys = via.keys;
      continue;
    }
    if (o.allowPrivate && s.privateIp) {
      s.route = { kind: "private", host: s.privateIp, port, label: `사설 IP ${s.privateIp} (VPN 등 같은 망에서만)` };
      continue;
    }
    s.route = {
      kind: "none",
      port,
      label: s.privateIp ? `공인 IP 없음 (${s.privateIp})` : "주소 없음",
    };
  }
}

/** 키도 없고 SSH 비밀번호 로그인도 꺼져 있어 접속이 거절될 서버 */
export function keyBlocked(s: ServerNode): boolean {
  return (s.keys === "missing" || s.keys === "none") && !s.passwordSsh;
}

/** 접속 불가 이유(툴팁·오류 문구) */
export function noRouteReason(s: ServerNode): string {
  if (!s.privateIp) return "아직 주소가 수집되지 않았다. 잠시 뒤 새로고침할 것.";
  if (s.envName) {
    return "이 환경에는 공인 IP 가 붙은 서버가 없어 밖에서 닿지 않는다. 웹의 환경 화면에서 '리소스 더하기'로 공인 IP 를 붙이거나, VPN 안이라면 설정 kloudhub.ssh.allowPrivateAddress 를 켤 것.";
  }
  return "이 인스턴스에는 공인 IP 가 없어 밖에서 닿지 않는다. 웹에서 공인 IP 를 붙이거나, VPN 안이라면 설정 kloudhub.ssh.allowPrivateAddress 를 켤 것.";
}

/** 트리·quick pick 에서 서버를 찾기 위한 평탄화 */
export function allServers(projects: ProjectNode[]): ServerNode[] {
  return projects.flatMap((p) => [...p.envs.flatMap((e) => e.servers), ...p.standalone]);
}
