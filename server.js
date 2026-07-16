/*
 * Journal Finder server — 정적 파일 서빙 + OpenAlex 프록시.
 *
 * 의존성 없음 (Node 18+). 실행: node server.js
 *
 * 프록시(/api/oa/*)가 해결하는 문제:
 *  - OpenAlex 무료 예산은 IP당 하루 약 1,000회 — 방문자가 몰리면 금방 소진된다.
 *    서버가 OPENALEX_API_KEY(환경 변수)로 대신 호출하면 서버 예산 하나로 통합된다.
 *  - 같은 검색·저널 지표 요청이 반복되므로 응답을 캐싱해 예산과 시간을 아낀다.
 *
 * 환경 변수:
 *  - PORT              (기본 3000)
 *  - OPENALEX_API_KEY  서버 공용 OpenAlex API 키 (없으면 mailto 폴백)
 *  - OPENALEX_MAILTO   polite pool용 이메일 (기본 openalex@example.org)
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const UPSTREAM = "https://api.openalex.org";
const ALLOWED_OA = /^(works|sources|topics|autocomplete)(\/|$)/;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

/* ── 응답 캐시 (TTL 24h, 최대 1000건) ────────────────────────────── */
const CACHE_TTL = 24 * 60 * 60 * 1000;
const CACHE_MAX = 1000;
const cache = new Map(); // key → { body, expires }

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expires <= Date.now()) {
    cache.delete(key);
    return null;
  }
  return hit.body;
}
function cacheSet(key, body) {
  if (cache.size >= CACHE_MAX) {
    // Map은 삽입 순서를 유지하므로 가장 오래된 항목부터 제거
    for (const k of cache.keys()) {
      cache.delete(k);
      if (cache.size < CACHE_MAX) break;
    }
  }
  cache.set(key, { body, expires: Date.now() + CACHE_TTL });
}

/* ── IP별 rate limit (고정 윈도우, 분당 120회) ───────────────────── */
const RL_LIMIT = 120;
const RL_WINDOW = 60 * 1000;
const buckets = new Map();

function rateLimited(ip) {
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || b.resetAt <= now) {
    if (buckets.size >= 10000) {
      for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k);
    }
    buckets.set(ip, { count: 1, resetAt: now + RL_WINDOW });
    return false;
  }
  b.count += 1;
  return b.count > RL_LIMIT;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function sendJson(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    ...extraHeaders,
  });
  res.end(body);
}

/* ── OpenAlex 프록시 ─────────────────────────────────────────────── */
async function proxyOpenAlex(req, res, url) {
  const oaPath = url.pathname.slice("/api/oa/".length);
  if (!ALLOWED_OA.test(oaPath)) {
    return sendJson(res, 404, { error: "unknown_endpoint" });
  }
  if (rateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: "rate_limited", retryAfter: 60 }, { "Retry-After": "60" });
  }

  // 인증 파라미터는 캐시 키에서 제외 (같은 쿼리는 키와 무관하게 같은 응답)
  const params = new URLSearchParams(url.search);
  const clientKey = params.get("api_key") || "";
  params.delete("api_key");
  params.delete("mailto");
  params.sort();
  const cacheKey = oaPath + "?" + params.toString();

  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "X-Cache": "HIT",
    });
    return res.end(cached);
  }

  // 클라이언트가 자기 키를 보냈으면 그대로 사용, 아니면 서버 키 → mailto 순
  const upstream = new URL(UPSTREAM + "/" + oaPath + "?" + params.toString());
  if (clientKey) {
    upstream.searchParams.set("api_key", clientKey);
  } else if (process.env.OPENALEX_API_KEY) {
    upstream.searchParams.set("api_key", process.env.OPENALEX_API_KEY);
  } else {
    upstream.searchParams.set("mailto", process.env.OPENALEX_MAILTO || "openalex@example.org");
  }

  let r;
  try {
    r = await fetch(upstream, { signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return sendJson(res, 502, { error: "upstream_unreachable" });
  }

  const body = await r.text();
  if (r.status === 429) {
    const ra = r.headers.get("retry-after") || "60";
    res.writeHead(429, {
      "Content-Type": "application/json; charset=utf-8",
      "Retry-After": ra,
    });
    return res.end(body || JSON.stringify({ error: "budget", retryAfter: Number(ra) }));
  }
  if (r.ok) cacheSet(cacheKey, body);
  res.writeHead(r.status, {
    "Content-Type": "application/json; charset=utf-8",
    "X-Cache": "MISS",
  });
  res.end(body);
}

/* ── 정적 파일 ───────────────────────────────────────────────────── */
function serveStatic(res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === "/") rel = "/index.html";
  const file = path.normalize(path.join(ROOT, rel));
  const base = path.basename(file);
  if (!file.startsWith(ROOT + path.sep) || base.startsWith(".")) {
    return sendJson(res, 404, { error: "not_found" });
  }
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not_found" });
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] || "application/octet-stream",
    });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true });
  }
  if (url.pathname.startsWith("/api/oa/")) {
    if (req.method !== "GET") return sendJson(res, 405, { error: "method_not_allowed" });
    return proxyOpenAlex(req, res, url).catch(() => sendJson(res, 500, { error: "internal" }));
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendJson(res, 405, { error: "method_not_allowed" });
  }
  serveStatic(res, url.pathname);
});

server.listen(PORT, () => {
  console.log("Journal Finder server listening on :" + PORT);
});
