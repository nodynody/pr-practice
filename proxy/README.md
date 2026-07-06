# TONECHECK Proxy (Cloudflare Worker)

퍼스널컬러 앱(`personal-color.html`)이 Anthropic API 키를 브라우저에 노출하지 않고
AI 진단을 사용할 수 있게 해주는 전용 프록시입니다.

```
브라우저 (personal-color.html)          Cloudflare Worker              Anthropic API
  이미지 + 최소 파라미터만 전송  ──▶   키 보관(Secret) + 검증   ──▶   claude-opus-4-8
  키 없음                              프롬프트/스키마 고정
```

## 보안 설계

| 항목 | 내용 |
|---|---|
| 키 보관 | Cloudflare **Secret**에만 저장. 코드·저장소·클라이언트·응답 어디에도 없음 |
| 악용 방지 | 범용 프록시가 아님 — `/diagnose`, `/oxcheck` 두 작업만 지원하고 프롬프트·모델·출력 스키마는 서버 고정. 임의 프롬프트로 무료 API처럼 쓸 수 없음 |
| CORS | `ALLOWED_ORIGINS` 목록의 출처만 브라우저 호출 허용 |
| 속도 제한 | IP당 분당 10회 (`RATE_LIMITER` 바인딩) |
| 입력 검증 | 요청 4MB / 이미지 약 2MB 제한, jpeg·png·webp만 허용, base64 형식 검사 |
| 인젝션 방지 | 프롬프트에 삽입되는 유일한 사용자 문자열(`season`)은 한글·영숫자 화이트리스트로 정제 |
| 정보 노출 최소화 | 업스트림 에러 본문·이미지·응답을 로깅하지 않고, 에러는 일반화된 메시지로만 전달 |

## 배포 방법

```bash
cd proxy

# 1. wrangler 로그인 (Cloudflare 계정 필요, 무료 플랜 가능)
npx wrangler login

# 2. API 키를 '시크릿'으로 등록 — 프롬프트가 뜨면 sk-ant-... 키를 붙여넣기
#    (셸 히스토리에 남지 않도록 인자로 넘기지 말 것)
npx wrangler secret put ANTHROPIC_API_KEY

# 3. 배포
npx wrangler deploy
```

배포가 끝나면 `https://tonecheck-proxy.<계정서브도메인>.workers.dev` 주소가 출력됩니다.
이 주소를:

1. `personal-color.html`의 `DEFAULT_PROXY` 상수에 넣어 커밋하거나
2. 앱 우측 상단 **⚙ 서버 설정**에서 입력

하면 연결됩니다.

## 로컬 개발

```bash
# 로컬 전용 시크릿 파일 생성 (.gitignore에 포함되어 커밋되지 않음)
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
npx wrangler dev
```

## 운영 전 체크리스트

- [ ] `wrangler.toml`의 `ALLOWED_ORIGINS`에서 `localhost` 항목 제거
- [ ] Cloudflare 대시보드에서 Worker 요청량 알림 설정 (비용 급증 감지)
- [ ] Anthropic 콘솔에서 워크스페이스 지출 한도(spend limit) 설정
- [ ] 키가 노출된 적 있다면 즉시 폐기 후 재발급 (기존 브라우저 직접 호출 버전을 쓰던 키는 재발급 권장)

## 다음 단계 (트래픽이 커지면)

- **Cloudflare Turnstile**: 봇의 자동 호출 차단 (무료, 클라이언트에 위젯 추가 + Worker에서 토큰 검증)
- **사용자 인증**: 진짜 사용량 제어가 필요하면 로그인 기반 토큰 발급으로 전환
- **Cloudflare WAF Rate Limiting Rule**: 바인딩보다 강한 엣지 레벨 속도 제한
