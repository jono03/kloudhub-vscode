# KloudHub-VSCode 개발 문서

사용자 안내는 `README.md`(확장 소개 페이지에 그대로 나온다). 이 문서는 구조·규칙·시험 방법을 적고, `.vscodeignore` 로 설치 파일에서 뺀다.

CloudStack-VSCode 프로토타입의 구조(SSH config 블록 + Remote-SSH)를 그대로 쓰고, 목록과 접속 경로를 KloudHub 에 맞췄다. `src/sshConfig.ts`·`src/remote.ts` 는 거기서 가져왔다.

## 동작 방식

```
[사이드바] --Bearer kh_…--> KloudHub /api/v1
     │  GET /me, /projects/{p}/environments?mine=true, /instances, /public-ips, /images
     ▼
접속 클릭 → 경로 계산 → ~/.ssh/config 의 KLOUDHUB-VSCODE 블록에 Host 기록
     ▼
vscode.newWindow (authority = ssh-remote+<별칭>) → Remote-SSH 가 접속
```

확장은 SSH 연결을 직접 하지 않는다. 별칭을 SSH config 에 써 두고 Remote-SSH 에 넘긴다.

## 목록 규칙

- 프로젝트: `/me` 의 `projects` 중 `status == active` 만 부른다(승인 대기·거둔 요청·보관은 접속할 서버가 없다).
- 환경: `environments?mine=true` (내가 만든 환경). 남의 환경은 서버에 내 키가 없고, 시작·정지·kubeconfig 도 주인·프로젝트 관리자만 되므로 뺀다.
- 서버: `/instances` 전체에서 `env_id` 가 내 환경 이름인 것, 그리고 `env_id == null && owner == 나` 인 것(독립 인스턴스). `spec.mgmt == "jump"`(관리 경유 서버 kh-jump)는 뺀다.
- 서버 이름: `kh-{project}-{env}-{role}{n}` 에서 접두사를 뗀다. 환경 이름을 바꿨거나 잘린 이름이면 끝의 `{role}{n}` 만 쓴다.
- 사설 IP: 공인 IP 행의 `private_address` → `spec.addresses` 의 첫 IPv4. OpenStack 은 붙은 공인 IP 도 `addresses` 에 넣으므로 공인 IP 는 뺀다.
- 로그인 계정: `spec.login.user`(로그인 비밀번호를 정한 계정) → 이미지 OS 기본 계정(backend `DEFAULT_USERS` 와 같다) → 설정 → 처음 접속할 때 묻기.

## SSH 경로

| 순서 | 경로 | SSH config |
|---|---|---|
| 1 | 그 서버의 공인 IP | `HostName <공인 IP>` |
| 2 | 같은 환경의 공인 IP 서버를 거쳐 사설 IP | `HostName <사설 IP>` + `ProxyJump <경유 서버 별칭>` |
| 3 | 사설 IP 직접 | `kloudhub.ssh.allowPrivateAddress` 를 켰을 때만 |

- 경유 서버: 실행 중 → 역할 순서(cp·mgr 먼저) → 이름 순.
- 독립 인스턴스끼리는 서로 경유하지 않는다(같은 망이라는 보장이 없다).
- 관리 경유 서버(kh-jump)는 사용자 키가 없는 nologin 계정이라 쓰지 않는다.

## 키 상태

서버에는 만들 때 등록돼 있던 키만 cloud-init 으로 들어간다(`jobs/instance_kinds.py`, 기록은 `spec.keys`). 이 PC 의 `~/.ssh/*.pub` 와 `identityFile` 옆 `.pub` 지문(`SHA256:…`, `ssh-keygen -lf` 와 같다)과 비교한다.

| 값 | 뜻 |
|---|---|
| `ok` | 겹치는 키가 있다 |
| `missing` | 기록된 키가 이 PC 의 키와 겹치지 않는다 |
| `none` | 넣은 키가 없다(`spec.keys == []`) |
| `unknown` | 기록이 없는 옛 서버(`spec.keys` 없음/null)이거나 이 PC 의 공개키를 못 찾았다 |

경유 접속은 경유 서버의 키 상태가 더 나쁘면 그것을 쓴다. 트리의 🔒 는 `missing`/`none` 이면서 SSH 비밀번호 로그인(`spec.login.ssh`)이 꺼진 경우만 붙인다.

## 트리 표시(시안 A)

- 프로젝트: 이름. 코드는 이름과 다를 때만, 환경이 없으면 "환경 없음".
- 환경: 템플릿 짧은 이름. 실행 중이 아닐 때만 상태(진행 중이면 단계 수). 서버가 여러 대이거나 손볼 서버(🔒·접속 불가)가 있으면 펼쳐 둔다.
- 서버: 접속할 곳 하나(공인 IP / `cp0 경유` / `사설 …` / `접속 불가`), 실행 중이 아니면 상태. 역할·사설 IP·로그인 계정은 툴팁.
- `contextValue`: 서버 `server.<running|stopped|busy|error|unknown>.<direct|jump|private|none>[.solo]`, 환경 `env.<상태>[.k8s]`.

## 시작·정지

- 환경 서버는 환경 단위(`POST …/environments/{env}/actions/{start|stop}`). 경유 서버도 같이 켜져야 하고 환경 상태가 어긋나지 않게 한다.
- 독립 인스턴스는 `POST …/instances/{id}/actions/{start|stop}`.
- 쓰기는 202 `{job_id}` 를 받고 `GET /jobs/{id}` 를 2초마다 본다. `succeeded` 가 아니면 작업의 `error` 를 보여 준다.

## SSH config 블록

```
# --- START KLOUDHUB-VSCODE --- managed by the KloudHub-VSCode extension. Edits inside this block are overwritten.
Host kloudhub--my-k8s-cp0-3882c14a
  # kloudhub-server-id 3882c14a-2808-4115-a832-46fcbbd0d543
  HostName 203.0.113.10
  Port 22
  User ubuntu
  HostKeyAlias kloudhub--my-k8s-cp0-3882c14a

Host kloudhub--my-k8s-worker0-7c1d9e20
  # kloudhub-server-id 7c1d9e20-…
  HostName 10.0.0.11
  Port 22
  User ubuntu
  HostKeyAlias kloudhub--my-k8s-worker0-7c1d9e20
  ProxyJump kloudhub--my-k8s-cp0-3882c14a
# --- END KLOUDHUB-VSCODE ---
```

- 블록은 첫 `Host`/`Match` 앞에 넣는다(파일 끝 `Host *` 에 덮이지 않게).
- `HostKeyAlias` 는 서버 별칭. 지운 서버의 IP 가 새 서버에 가고, 워커 사설 IP 는 환경마다 겹친다.
- 서버에서 온 값은 형식 검증 뒤에만 쓴다. 이름은 별칭에만 쓰고 `[a-z0-9-]` 로 거른다(ProxyCommand 끼워 넣기 방지).
- 새로고침 때 목록에 없는 서버 항목을 지운다. 한 프로젝트라도 불러오기에 실패하면 지우지 않는다.

## 자격 증명

- 토큰은 SecretStorage 에만, 설정에는 웹 주소만 둔다.
- 401 이면 토큰을 지우고 다시 로그인을 권한다.
- KloudHub 토큰은 사용자 권한 그대로 쓰인다(scope 를 검사하지 않는다).

## 개발

```bash
npm install
npm test          # 컴파일 + 36개 테스트 (OpenSSH 클라이언트 필요: ssh -G 로 config 해석, ssh-keygen 으로 지문 확인)
npm run package   # kloudhub-vscode-<버전>.vsix
```

테스트는 KloudHub API 를 흉내 낸 모의 서버(`src/test/mockKloudHub.ts`)와 가짜 `vscode` 모듈(`src/test/fakeVscode.ts`)로 돌린다.

| 파일 | 역할 |
|---|---|
| `src/extension.ts` | 명령, 접속 흐름, 시작·정지, kubeconfig, 토큰 만료 처리 |
| `src/kloudhub/client.ts` | Bearer 토큰 요청, 오류(`detail`) 처리, 작업 완료 대기 |
| `src/kloudhub/types.ts` | 읽는 API 응답 필드 |
| `src/inventory.ts` | API 응답 → 프로젝트/환경/서버, SSH 경로·키 상태·로그인 계정 계산 |
| `src/tree.ts` | 사이드바 트리 |
| `src/keys.ts` | 공개키 형식 검사, 지문 계산, 이 PC 의 공개키 찾기 |
| `src/sshConfig.ts` | SSH config 블록 편집과 값 검증 |
| `src/remote.ts` | Remote-SSH 계열 확장 탐지, 원격 창 열기, 터미널 |
| `src/auth.ts` | 로그인 대화, SecretStorage |

## 아직 없는 것

- 남의 서버(또는 키를 바꾼 뒤 내 서버)에 내 키 넣기 — 백엔드 기능이 필요하다.
- 브라우저 로그인으로 토큰 자동 발급 — 지금은 토큰을 붙여 넣는다.
- VNC 콘솔, 공인 IP 추가(웹에서 열기로 대신).
