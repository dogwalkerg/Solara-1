// proxy.ts - 改进版，支持多个备用 API 源和缓存

const API_SOURCES = [
  "https://music-api.gdstudio.xyz/api.php",  // 主源
  "https://api.injahow.cn/meting/",         // 备用源1
  "https://music.163api.com/",              // 备用源2
  "https://music-api.onlymylove.top/api.php" // 备用源3
];

let currentApiIndex = 0;
let apiHealthStatus = Array(API_SOURCES.length).fill(true); // 跟踪 API 健康状态
const KUWO_HOST_PATTERN = /(^|\.)kuwo\.cn$/i;
const SAFE_RESPONSE_HEADERS = ["content-type", "cache-control", "accept-ranges", "content-length", "content-range", "etag", "last-modified", "expires"];

// 缓存配置
const CACHE_TTL = 300; // 5分钟缓存
const searchCache = new Map(); // 简单的内存缓存

function createCorsHeaders(init?: Headers): Headers {
  const headers = new Headers();
  if (init) {
    for (const [key, value] of init.entries()) {
      if (SAFE_RESPONSE_HEADERS.includes(key.toLowerCase())) {
        headers.set(key, value);
      }
    }
  }
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "no-store");
  }
  headers.set("Access-Control-Allow-Origin", "*");
  return headers;
}

function handleOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,HEAD,OPTIONS",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Max-Age": "86400",
    },
  });
}

function isAllowedKuwoHost(hostname: string): boolean {
  if (!hostname) return false;
  return KUWO_HOST_PATTERN.test(hostname);
}

function normalizeKuwoUrl(rawUrl: string): URL | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isAllowedKuwoHost(parsed.hostname)) {
      return null;
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    parsed.protocol = "http:";
    return parsed;
  } catch {
    return null;
  }
}

async function proxyKuwoAudio(targetUrl: string, request: Request): Promise<Response> {
  const normalized = normalizeKuwoUrl(targetUrl);
  if (!normalized) {
    return new Response("Invalid target", { status: 400 });
  }

  const init: RequestInit = {
    method: request.method,
    headers: {
      "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
      "Referer": "https://www.kuwo.cn/",
    },
  };

  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) {
    (init.headers as Record<string, string>)["Range"] = rangeHeader;
  }

  const upstream = await fetch(normalized.toString(), init);
  const headers = createCorsHeaders(upstream.headers);
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "public, max-age=3600");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

// 检查 API 健康状态
async function checkApiHealth(apiUrl: string, index: number): Promise<boolean> {
  try {
    const testUrl = new URL(apiUrl);
    testUrl.searchParams.set("types", "search");
    testUrl.searchParams.set("source", "netease");
    testUrl.searchParams.set("keywords", "test");
    testUrl.searchParams.set("limit", "1");
    
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    
    const response = await fetch(testUrl.toString(), {
      signal: controller.signal,
      headers: { "User-Agent": "Mozilla/5.0" }
    });
    
    clearTimeout(timeoutId);
    
    if (response.ok) {
      const data = await response.json();
      apiHealthStatus[index] = data.code === 200 || data.data !== undefined;
    } else {
      apiHealthStatus[index] = false;
    }
    
    return apiHealthStatus[index];
  } catch (error) {
    console.warn(`API ${apiUrl} 健康检查失败:`, error);
    apiHealthStatus[index] = false;
    return false;
  }
}

// 获取可用的 API 源
async function getAvailableApiSource(): Promise<string> {
  // 如果当前源健康，直接使用
  if (apiHealthStatus[currentApiIndex]) {
    return API_SOURCES[currentApiIndex];
  }
  
  // 查找第一个健康的源
  for (let i = 0; i < API_SOURCES.length; i++) {
    if (i !== currentApiIndex && apiHealthStatus[i]) {
      currentApiIndex = i;
      return API_SOURCES[i];
    }
  }
  
  // 都不可用，尝试检查所有源的健康状态
  for (let i = 0; i < API_SOURCES.length; i++) {
    const isHealthy = await checkApiHealth(API_SOURCES[i], i);
    if (isHealthy) {
      currentApiIndex = i;
      return API_SOURCES[i];
    }
  }
  
  // 都不可用，回退到第一个
  currentApiIndex = 0;
  return API_SOURCES[0];
}

// 生成缓存键
function generateCacheKey(apiUrl: string, params: URLSearchParams): string {
  const cacheKey = {
    api: apiUrl,
    params: Object.fromEntries(params.entries())
  };
  return JSON.stringify(cacheKey);
}

// 带重试的 API 请求
async function fetchWithRetry(apiUrl: string, request: Request, maxRetries: number = 3): Promise<Response> {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = new URL(apiUrl);
      const requestUrl = new URL(request.url);
      
      // 复制查询参数
      requestUrl.searchParams.forEach((value, key) => {
        if (key === "target" || key === "callback") {
          return;
        }
        url.searchParams.set(key, value);
      });
      
      if (!url.searchParams.has("types")) {
        return new Response("Missing types", { status: 400 });
      }
      
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
      
      const upstream = await fetch(url.toString(), {
        headers: {
          "User-Agent": request.headers.get("User-Agent") ?? "Mozilla/5.0",
          "Accept": "application/json",
        },
        signal: controller.signal,
      });
      
      clearTimeout(timeoutId);
      
      if (upstream.ok) {
        const headers = createCorsHeaders(upstream.headers);
        if (!headers.has("Content-Type")) {
          headers.set("Content-Type", "application/json; charset=utf-8");
        }
        
        // 检查 API 返回的数据是否有效
        const bodyText = await upstream.text();
        try {
          const data = JSON.parse(bodyText);
          // 如果数据有效，更新 API 健康状态
          if (data.code === 200 || data.data !== undefined) {
            apiHealthStatus[currentApiIndex] = true;
          } else {
            // API 返回了错误，但不一定是不可用
            console.warn(`API 返回错误: ${data.code || 'unknown'}`);
          }
        } catch (e) {
          console.warn("API 返回非 JSON 数据");
        }
        
        return new Response(bodyText, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers,
        });
      } else {
        // HTTP 错误，标记 API 为不健康
        apiHealthStatus[currentApiIndex] = false;
        lastError = new Error(`HTTP ${upstream.status}`);
      }
    } catch (error) {
      console.warn(`API 请求失败 (尝试 ${attempt}/${maxRetries}):`, error);
      lastError = error;
      apiHealthStatus[currentApiIndex] = false;
    }
    
    // 如果不是最后一次尝试，等待后重试
    if (attempt < maxRetries) {
      await new Promise(resolve => setTimeout(resolve, attempt * 1000)); // 指数退避
      
      // 尝试切换到其他 API 源
      const nextApi = await getAvailableApiSource();
      if (nextApi !== apiUrl) {
        apiUrl = nextApi;
        console.log(`切换到备用 API 源: ${apiUrl}`);
      }
    }
  }
  
  return new Response(JSON.stringify({
    code: 500,
    message: "所有 API 源均不可用",
    data: []
  }), {
    status: 500,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function proxyApiRequest(url: URL, request: Request): Promise<Response> {
  const searchType = url.searchParams.get("types");
  
  // 如果是搜索请求，检查缓存
  if (searchType === "search") {
    const apiUrl = await getAvailableApiSource();
    const cacheKey = generateCacheKey(apiUrl, url.searchParams);
    
    // 检查内存缓存
    const cached = searchCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL * 1000) {
      console.log(`使用缓存的搜索结果: ${cacheKey}`);
      const headers = new Headers({
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "X-Cache": "HIT",
        "Cache-Control": `public, max-age=${CACHE_TTL}`
      });
      
      return new Response(JSON.stringify(cached.data), { headers });
    }
    
    // 执行实际请求
    const response = await fetchWithRetry(apiUrl, request);
    
    // 如果请求成功，缓存结果
    if (response.ok) {
      try {
        const clonedResponse = response.clone();
        const data = await clonedResponse.json();
        
        if (data.code === 200 || data.data !== undefined) {
          searchCache.set(cacheKey, {
            data: data,
            timestamp: Date.now()
          });
          
          // 添加缓存头
          const headers = new Headers(response.headers);
          headers.set("X-Cache", "MISS");
          headers.set("Cache-Control", `public, max-age=${CACHE_TTL}`);
          
          return new Response(JSON.stringify(data), { headers });
        }
      } catch (e) {
        console.warn("无法缓存响应:", e);
      }
    }
    
    return response;
  }
  
  // 非搜索请求，使用主 API 源
  const apiUrl = API_SOURCES[0];
  return fetchWithRetry(apiUrl, request, 2);
}

// 定期清理过期的缓存
function cleanupCache() {
  const now = Date.now();
  for (const [key, value] of searchCache.entries()) {
    if (now - value.timestamp > CACHE_TTL * 1000 * 2) { // 两倍 TTL 后清理
      searchCache.delete(key);
    }
  }
}

// 定期检查 API 健康状态
async function periodicHealthCheck() {
  console.log("开始定期 API 健康检查...");
  for (let i = 0; i < API_SOURCES.length; i++) {
    await checkApiHealth(API_SOURCES[i], i);
  }
  console.log("API 健康状态:", apiHealthStatus);
}

// 每5分钟清理一次缓存，每10分钟检查一次 API 健康
if (typeof globalThis !== "undefined") {
  setInterval(cleanupCache, 5 * 60 * 1000);
  setInterval(periodicHealthCheck, 10 * 60 * 1000);
}

export async function onRequest({ request }: { request: Request }): Promise<Response> {
  if (request.method === "OPTIONS") {
    return handleOptions();
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405 });
  }

  const url = new URL(request.url);
  const target = url.searchParams.get("target");

  if (target) {
    return proxyKuwoAudio(target, request);
  }

  return proxyApiRequest(url, request);
}
