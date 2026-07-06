/**
 * TONECHECK Proxy — Cloudflare Worker
 *
 * Anthropic API 키를 브라우저에 노출하지 않기 위한 전용 프록시.
 * 범용 중계기가 아니라 딱 두 가지 작업만 수행한다:
 *   POST /diagnose : 셀카 → 퍼스널컬러 진단
 *   POST /oxcheck  : 아이템 사진 + 진단 톤 → O/X 판별
 *
 * 보안 원칙
 *  - API 키는 Cloudflare Secret(ANTHROPIC_API_KEY)에만 존재. 코드/저장소/응답에 없음.
 *  - 프롬프트·모델·출력 스키마는 전부 서버 측 고정 → 임의 프롬프트 주입/무료 API 악용 불가.
 *  - Origin 허용 목록(ALLOWED_ORIGINS) 밖의 브라우저 요청은 거부.
 *  - IP당 속도 제한(RATE_LIMITER 바인딩), 요청 크기·이미지 타입·base64 검증.
 *  - season 파라미터는 문자 화이트리스트로 정제(프롬프트 인젝션 방지).
 *  - 이미지·업스트림 응답 본문은 로깅하지 않고, 업스트림 에러는 상태만 매핑해 전달.
 */

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-opus-4-8";
const MAX_BODY_BYTES = 4 * 1024 * 1024;      // 요청 전체 4MB 제한
const MAX_B64_CHARS = 2_800_000;             // 이미지 원본 약 2MB 제한
const ALLOWED_MEDIA = new Set(["image/jpeg", "image/png", "image/webp"]);

/* ---------- 서버 측 고정 프롬프트 / 스키마 ---------- */
const DIAG_PROMPT = `당신은 20만 원짜리 오프라인 퍼스널컬러 진단에 준하는 분석을 제공하는 전문 컬러리스트입니다.
이 셀카를 단순 RGB 수치가 아니라 시각적 맥락 전체로 분석하세요:
1) 조명(색온도, 방향, 강도)을 먼저 파악하고 그 영향을 머릿속에서 보정한 뒤 판단할 것
2) 피부의 언더톤(웜/쿨), 명도, 채도 수용력
3) 머리카락·눈동자·눈썹의 고유 색과 피부와의 대비감
4) 얼굴 전체의 인상(선명/부드러움)
이를 종합해 12타입 퍼스널컬러(봄웜 라이트/브라이트, 여름쿨 라이트/뮤트/브라이트, 가을웜 뮤트/스트롱/딥, 겨울쿨 브라이트/스트롱/딥 등) 중 하나로 진단하세요.
얼굴이 잘 보이지 않는 사진이면 is_face를 false로 하고 나머지는 빈 값 대신 임의의 기본값을 넣으세요.
말투는 밝고 다정하게, 사용자의 매력을 칭찬하는 톤으로 작성하세요. 모든 텍스트는 한국어.`;

const DIAG_SCHEMA = {
  type: "object",
  properties: {
    is_face: { type: "boolean", description: "사람 얼굴이 충분히 보이는 사진인지" },
    season: { type: "string", description: "12타입 한국어 명칭. 예: 가을 뮤트 소프트, 봄 웜 라이트" },
    season_en: { type: "string", description: "영문 표기. 예: Autumn Mute Soft" },
    hashtags: { type: "array", items: { type: "string" }, description: "# 포함 감성 해시태그 3개" },
    confidence: { type: "integer", description: "진단 확신도 0~100" },
    lighting_note: { type: "string", description: "조명 상태와 보정 방법 한 문장" },
    features: { type: "array", items: { type: "string" }, description: "핵심 특징 4가지, 사진 근거 포함" },
    celebrities: { type: "array", items: { type: "string" }, description: "같은 톤 한국 연예인 4명" },
    best_colors: { type: "array", items: { type: "object", properties: { name: { type: "string" }, hex: { type: "string" } }, required: ["name", "hex"], additionalProperties: false }, description: "베스트 컬러 8개" },
    worst_colors: { type: "array", items: { type: "object", properties: { name: { type: "string" }, hex: { type: "string" } }, required: ["name", "hex"], additionalProperties: false }, description: "워스트 컬러 4개" },
    tips: { type: "string", description: "메이크업/헤어/패션 팁 3~4문장" }
  },
  required: ["is_face", "season", "season_en", "hashtags", "confidence", "lighting_note", "features", "celebrities", "best_colors", "worst_colors", "tips"],
  additionalProperties: false
};

const OX_SCHEMA = {
  type: "object",
  properties: {
    item: { type: "string", description: "사진 속 아이템/컬러가 무엇인지 한 문장" },
    verdict: { type: "string", enum: ["O", "X", "triangle"], description: "O=찰떡, X=비추, triangle=조건부" },
    score: { type: "integer", description: "어울림 점수 0~100" },
    reason: { type: "string", description: "판정 이유 2~3문장, 다정한 말투" }
  },
  required: ["item", "verdict", "score", "reason"],
  additionalProperties: false
};

function oxPrompt(season) {
  return `사용자의 퍼스널컬러는 [${season}]입니다. 사진 속 화장품 색상(또는 염색 컬러/의류 색상)이 이 톤과 어울리는지 전문 컬러리스트로서 판별하세요. 조명 영향을 감안해 실제 색을 추정한 뒤 판단하세요. 모든 텍스트는 한국어, 다정한 말투.`;
}

/* ---------- helpers ---------- */
function json(obj, status, headers) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}

/**
 * Origin 검사. 허용되면 CORS 헤더를, 차단이면 null을 반환.
 * Origin 헤더가 없는 요청(서버 간 호출 등)은 CORS로 막을 수 없으므로 통과시키되
 * 속도 제한·입력 검증은 동일하게 적용된다.
 */
function corsFor(request, env) {
  const origin = request.headers.get("Origin");
  const base = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "content-type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin"
  };
  if (!origin) return base;
  const allowed = String(env.ALLOWED_ORIGINS || "")
    .split(",").map(s => s.trim()).filter(Boolean);
  if (allowed.includes("*")) return { ...base, "Access-Control-Allow-Origin": "*" };
  if (allowed.includes(origin)) return { ...base, "Access-Control-Allow-Origin": origin };
  return null;
}

function validImage(image) {
  if (!image || typeof image !== "object") return null;
  const media = String(image.media_type || "");
  const data = String(image.data || "");
  if (!ALLOWED_MEDIA.has(media)) return null;
  if (!data || data.length > MAX_B64_CHARS) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) return null;
  return { media_type: media, data };
}

/** 프롬프트에 삽입되는 유일한 사용자 문자열 — 화이트리스트 정제 */
function sanitizeSeason(s) {
  const clean = String(s || "").replace(/[^0-9A-Za-z가-힣 ·]/g, "").trim().slice(0, 30);
  return clean.length >= 2 ? clean : null;
}

/* ---------- worker ---------- */
export default {
  async fetch(request, env) {
    const cors = corsFor(request, env);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (!cors) return json({ error: "허용되지 않은 출처입니다." }, 403, { "Vary": "Origin" });
    if (request.method !== "POST") return json({ error: "POST 요청만 지원합니다." }, 405, cors);

    const path = new URL(request.url).pathname;
    if (path !== "/diagnose" && path !== "/oxcheck") {
      return json({ error: "존재하지 않는 경로입니다." }, 404, cors);
    }

    // IP당 속도 제한 (바인딩이 설정된 경우)
    if (env.RATE_LIMITER) {
      try {
        const ip = request.headers.get("cf-connecting-ip") || "unknown";
        const { success } = await env.RATE_LIMITER.limit({ key: `${path}:${ip}` });
        if (!success) return json({ error: "요청이 너무 잦아요. 잠시 후 다시 시도해 주세요." }, 429, cors);
      } catch (_) { /* 바인딩 오류 시에도 서비스는 유지 */ }
    }

    const declared = Number(request.headers.get("content-length") || 0);
    if (declared > MAX_BODY_BYTES) return json({ error: "이미지가 너무 커요. (최대 약 2MB)" }, 413, cors);

    let body;
    try { body = await request.json(); } catch { return json({ error: "잘못된 요청 형식입니다." }, 400, cors); }

    const image = validImage(body.image);
    if (!image) return json({ error: "지원하지 않는 이미지 형식이거나 이미지가 너무 커요." }, 400, cors);

    let prompt, schema, maxTokens;
    if (path === "/diagnose") {
      prompt = DIAG_PROMPT; schema = DIAG_SCHEMA; maxTokens = 4096;
    } else {
      const season = sanitizeSeason(body.season);
      if (!season) return json({ error: "먼저 퍼스널컬러 진단을 받아 주세요." }, 400, cors);
      prompt = oxPrompt(season); schema = OX_SCHEMA; maxTokens = 2048;
    }

    if (!env.ANTHROPIC_API_KEY) {
      console.error("ANTHROPIC_API_KEY secret is not set");
      return json({ error: "서버 설정 오류입니다. 관리자에게 문의해 주세요." }, 500, cors);
    }

    let upstream;
    try {
      upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01"
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: maxTokens,
          output_config: { format: { type: "json_schema", schema } },
          messages: [{
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: image.media_type, data: image.data } },
              { type: "text", text: prompt }
            ]
          }]
        })
      });
    } catch (e) {
      console.error("upstream fetch failed");
      return json({ error: "AI 서버 연결에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502, cors);
    }

    if (!upstream.ok) {
      // 업스트림 에러 본문은 클라이언트에 그대로 노출하지 않는다 (키/내부 정보 유출 방지)
      console.error(`anthropic error status=${upstream.status}`);
      if (upstream.status === 429 || upstream.status === 529) {
        return json({ error: "지금 이용자가 많아요. 잠시 후 다시 시도해 주세요." }, 429, cors);
      }
      if (upstream.status === 401 || upstream.status === 403) {
        return json({ error: "서버 설정 오류입니다. 관리자에게 문의해 주세요." }, 500, cors);
      }
      return json({ error: "분석에 실패했어요. 잠시 후 다시 시도해 주세요." }, 502, cors);
    }

    let data;
    try { data = await upstream.json(); } catch { return json({ error: "응답 해석에 실패했어요." }, 502, cors); }

    if (data.stop_reason === "refusal") {
      return json({ error: "이 이미지는 분석할 수 없어요. 다른 사진으로 시도해 주세요." }, 422, cors);
    }
    const textBlock = (data.content || []).find(b => b.type === "text");
    if (!textBlock) return json({ error: "응답 해석에 실패했어요." }, 502, cors);

    let result;
    try { result = JSON.parse(textBlock.text); } catch { return json({ error: "응답 해석에 실패했어요." }, 502, cors); }

    return json(result, 200, cors);
  }
};
