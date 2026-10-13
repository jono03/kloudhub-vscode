/**
 * KloudHub REST API(`/api/v1`) 응답 중 이 확장이 읽는 필드만 적는다.
 * 서버 원본: backend/kloudhub/api/routes/{me,environments,resources,images,jobs}.py
 */

export interface MyProject {
  code: string;
  name: string;
  /** requested · active · archived · withdrawn … */
  status: string;
  /** admin · member · viewer */
  role: string;
}

/** GET /me */
export interface Me {
  id: string;
  username: string;
  display_name?: string;
  org_role?: string;
  projects: MyProject[];
}

/** GET /projects/{p}/environments 의 한 행 */
export interface Environment {
  id: string;
  name: string;
  description?: string | null;
  /** creating · running · stopping · stopped · starting · restarting · deleting · deleted · failed */
  state: string;
  /** 템플릿 코드(k8s, dev-vm …). 인스턴스를 묶어 만든 환경은 null */
  template: string | null;
  version?: number | null;
  zone: string;
  owner: string | null;
  host?: string | null;
  private_ip?: string | null;
  public?: boolean;
  progress?: { job_id: string; kind: string; state: string; done: number; total: number; step: string | null } | null;
}

/** GET /projects/{p}/{instances|public-ips} 의 한 행 (레지스트리 자원) */
export interface Resource {
  id: string;
  kind: string;
  name: string;
  /** 서버: ACTIVE · STOPPED · BUILDING · STARTING · STOPPING · REBOOTING · ERROR · DELETING … */
  state: string | null;
  backend_id: string;
  /** 속한 환경의 이름. 단독 인스턴스는 null */
  env_id: string | null;
  spec: ServerSpec & PublicIpSpec & Record<string, unknown>;
  owner: string | null;
  created_at?: string;
}

export interface ServerSpec {
  /** 네트워크 이름 → 주소 목록 (대사기가 수집) */
  addresses?: Record<string, string[]>;
  /** 환경 템플릿 안의 역할(cp, worker, mgr …) */
  role?: string;
  /** 카탈로그 이미지 id */
  image?: string;
  /** 만들 때 cloud-init 으로 넣은 키(이름·지문). 기록 전 서버는 없다 */
  keys?: { name?: string | null; fingerprint?: string | null }[];
  /** 로그인 비밀번호를 정했으면 계정과 SSH 비밀번호 로그인 여부 */
  login?: { user?: string; password?: boolean; ssh?: boolean } | null;
  /** 관리 경유 서버("jump")는 사용자 목록에서 뺀다 */
  mgmt?: string;
  display_name?: string;
  description?: string;
}

export interface PublicIpSpec {
  address?: string;
  /** 붙은 서버의 KloudHub 자원 id */
  server?: string | null;
  private_address?: string | null;
}

/** GET /projects/{p}/images 의 한 행 */
export interface Image {
  id: string;
  name: string;
  os: string | null;
}

/** GET /me/ssh-keys 의 한 행 */
export interface SshKey {
  id: string;
  type: string;
  name: string;
  fingerprint: string;
  public_key: string;
  added_at?: string;
}

/** GET /jobs/{id} */
export interface Job {
  id: string;
  kind: string;
  /** queued · running · succeeded · failed · cancelled · rolling_back · rolled_back */
  state: string;
  error: string | null;
}

export const JOB_DONE_STATES = new Set(["succeeded", "failed", "cancelled", "rolled_back"]);
