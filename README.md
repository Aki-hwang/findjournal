# Journal Finder

논문 제목·초록을 넣으면 게재할 저널을 추천해주는 웹 앱. 데이터는 [OpenAlex](https://openalex.org) API를 사용합니다.

- `index.html` — 메인 앱 (저널 검색·추천)
- `eval.html` + `gold.jsonl` — 추천 정확도 평가 도구 (방법론은 `EVALUATION.md`)
- `server.js` — 정적 파일 서빙 + OpenAlex 프록시 서버 (의존성 없음, Node 18+)

## 실행

```bash
npm start          # http://localhost:3000
```

서버 없이 `index.html`을 정적 호스팅(GitHub Pages 등)에 올려도 동작합니다 —
이 경우 브라우저가 OpenAlex를 직접 호출합니다.

## 서버가 해주는 것

브라우저가 OpenAlex를 직접 호출하면 방문자 IP당 하루 약 1,000회 무료 한도를
공유하게 됩니다. `server.js`의 `/api/oa/*` 프록시는:

- **응답 캐싱 (24시간)** — 같은 검색·저널 지표 요청을 재사용해 예산과 시간 절약
- **공용 API 키** — `OPENALEX_API_KEY` 환경 변수를 설정하면 모든 방문자가 서버
  키의 예산을 사용 (방문자가 개인 키를 등록하면 그 키를 그대로 전달)
- **IP별 rate limit** — 분당 120회

## 환경 변수

| 변수 | 설명 |
|---|---|
| `PORT` | 서버 포트 (기본 3000, Railway가 자동 주입) |
| `OPENALEX_API_KEY` | 서버 공용 OpenAlex API 키 (선택) |
| `OPENALEX_MAILTO` | polite pool용 이메일 (선택) |

## Railway 배포

저장소를 Railway에 연결하면 `package.json`을 감지해 `npm start`로 실행합니다.
Variables에 `OPENALEX_API_KEY`를 넣으면 공용 키 모드가 켜집니다.
