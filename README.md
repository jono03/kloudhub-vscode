# KloudHub

KloudHub의 내 환경과 서버를 VS Code 사이드바에서 보고, 클릭 한 번으로 SSH 접속합니다.

## 시작하기

1. **Remote - SSH** 확장을 설치합니다. ([설치](vscode:extension/ms-vscode-remote.remote-ssh))
2. KloudHub 웹 **설정 → API 토큰**에서 토큰을 발급해 복사합니다. 발급 화면에서 한 번만 보여 줍니다.
3. VS Code 왼쪽 막대의 **KloudHub** 아이콘 → **KloudHub 로그인**을 누르고, 웹 주소(예: `https://kloudhub.example.ac.kr`)와 토큰을 차례로 넣습니다.

SSH 키(`~/.ssh/id_ed25519` 등)가 없으면 터미널에서 `ssh-keygen -t ed25519`로 만드세요. 학내망·VPN 안에서만 열리는 곳이면 그 망에 먼저 연결해야 합니다.

## 사용하기

```
▾ my-project
  ▾ my-k8s          쿠버네티스
      cp0           203.0.113.10
      worker0       cp0 경유
  ▾ 독립 인스턴스    1
      scratch       198.51.100.20
```

- 서버 줄의 **접속** 버튼을 누르면 새 VS Code 창이 열립니다. 우클릭하면 현재 창에서 접속, SSH 터미널, SSH 명령 복사도 고를 수 있습니다.
- 서버 오른쪽 글자는 접속할 곳입니다. IP는 바로 접속, `cp0 경유`는 같은 환경의 공인 IP 서버를 거쳐 접속합니다. `접속 불가`는 공인 IP가 없는 서버이고, 🔒 `키 없음`은 서버에 내 SSH 키가 없다는 뜻입니다.
- 정지된 서버를 누르면 시작할지 먼저 묻습니다.
- 환경을 우클릭하면 시작·정지, kubeconfig 받기(쿠버네티스), 웹에서 열기를 쓸 수 있습니다.
- 맨 위 계정 줄을 누르면 로그아웃이나 계정 전환을 할 수 있습니다.

접속 정보는 `~/.ssh/config`의 `KLOUDHUB-VSCODE` 블록에만 기록하고, 그 밖의 내용은 건드리지 않습니다. 토큰은 OS 키체인에 저장됩니다.

## 문제가 생기면

| 증상 | 해결 |
|---|---|
| 로그인할 때 연결 오류 | 브라우저에서 웹 주소가 열리는지 확인하세요. 자체서명 인증서를 쓰면 설정 `kloudhub.allowSelfSignedCertificate`를 켭니다 |
| 로그인이 만료됐다고 나옴 | 웹에서 새 토큰을 발급해 다시 로그인하세요 |
| `Permission denied (publickey)`, 🔒 키 없음 | 서버에는 만들 때 KloudHub에 등록한 키만 들어갑니다. 그 키를 이 PC에 두거나 설정 `kloudhub.ssh.identityFile`에 개인키 경로를 지정하세요. 제목줄 `···` → **SSH 공개키 등록**으로 등록한 키는 앞으로 만드는 서버에 들어갑니다 |
| 접속 시간 초과 | 학내망이나 VPN에 연결하세요 |
| 접속 불가 | 웹 환경 화면에서 공인 IP를 붙이세요. VPN으로 내부망에 닿는다면 `kloudhub.ssh.allowPrivateAddress`를 켭니다 |
| 원격 창이 안 열림 | 오래된 OS(Ubuntu 18.04, CentOS 7 등)는 원격 창을 지원하지 않습니다. 우클릭 → **SSH 터미널 열기**를 쓰세요 |

요청 기록은 **보기 → 출력**에서 `KloudHub`를 고르면 볼 수 있습니다. 설정 목록은 이 페이지의 **Features** 탭에서 확인할 수 있습니다.
