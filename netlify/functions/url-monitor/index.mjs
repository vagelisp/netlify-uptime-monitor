import { Resend } from "resend";

/**
 * URL Uptime Monitor
 *
 * A serverless function that monitors multiple URLs for availability and sends
 * email alerts when services are down. Designed to run on Netlify Functions
 * or similar serverless platforms.
 *
 * Features:
 * - Concurrent URL checking with configurable limits
 * - Flexible status code expectations
 * - Automatic retry logic with exponential backoff
 * - Email notifications via Resend
 * - Authentication via Bearer tokens
 * - Detailed response reporting
 *
 * @author Vagelis Papaioannou
 * @autorurl https://github.com/vagelisp
 * @version 1.0.0
 */

/**
 * Monitor Configuration
 *
 * Each monitor object supports the following properties:
 *
 * @typedef {Object} Monitor
 * @property {string} url - The URL to monitor (required)
 * @property {"HEAD"|"GET"} [method="HEAD"] - HTTP method (HEAD is faster, but some servers don't support it)
 * @property {number} [timeoutMs] - Request timeout in milliseconds (overrides DEFAULT_TIMEOUT_MS)
 * @property {number} [retries] - Number of retry attempts (overrides DEFAULT_RETRIES)
 * @property {string|Object} [expect="2xx3xx"] - Expected response criteria:
 *   - "2xx3xx": Accept any 2xx or 3xx status (default)
 *   - { anyOf: [200, 204, 301] }: Accept specific status codes
 *   - { between: [200, 399] }: Accept status codes within range
 *   - { oneOfRanges: [[200, 299], [301, 302]] }: Accept multiple ranges
 *   - { not: { anyOf: [503] } }: Negate any expectation rule
 */
const MONITORS = [
  {
    url: "https://github.com/vagelisp/netlify-uptime-monitor",
    method: "HEAD",
    expect: "2xx3xx",
  },
//   {
//     url: "https://status.example.com/health",
//     method: "GET",
//     expect: { anyOf: [200] },
//   },
//   {
//     url: "https://error.example.com/",
//     method: "HEAD",
//     expect: {
//       oneOfRanges: [
//         [200, 299],
//         [301, 302],
//       ],
//     },
//   },
];

// Default configuration constants
const DEFAULT_TIMEOUT_MS = 8000; // 8 seconds
const DEFAULT_RETRIES = 2; // Retry failed requests twice
const CONCURRENCY = 10; // Check up to 10 URLs simultaneously

/**
 * Main handler function for the URL monitor
 *
 * Processes incoming requests, checks all configured URLs, and sends
 * email alerts if any URLs are down.
 *
 * @param {Request} req - The incoming HTTP request
 * @returns {Response} JSON response with monitoring results
 *
 * Environment variables required:
 * - MONITOR_TOKEN (optional): Bearer token for authentication
 * - RESEND_API_KEY: API key for Resend email service
 * - ALERT_EMAIL_TO: Email address to send alerts to
 * - ALERT_EMAIL_FROM: Email address to send alerts from
 */
export default async (req) => {
  // --- Auth guard ---
  const token = process.env.MONITOR_TOKEN;
  if (token) {
    const auth = req.headers.get("authorization") || "";
    if (auth !== `Bearer ${token}`) {
      return json({ error: "Unauthorized" }, 401);
    }
  }

  const startedAt = Date.now();

  const results = await mapLimit(MONITORS, CONCURRENCY, async (m) => {
    const timeoutMs = m.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retries = m.retries ?? DEFAULT_RETRIES;
    return await checkWithRetries(m, { timeoutMs, retries });
  });

  const down = results.filter((r) => !r.ok);

  // --- Email if any down ---
  let emailSent = false;
  let emailId = null;

  if (down.length > 0) {
    const resendKey = process.env.RESEND_API_KEY;
    const to = process.env.ALERT_EMAIL_TO;
    const from = process.env.ALERT_EMAIL_FROM;

    if (!resendKey || !to || !from) {
      return json(
        {
          ok: false,
          error:
            "Some URLs are down, but RESEND_API_KEY / ALERT_EMAIL_TO / ALERT_EMAIL_FROM env vars are missing.",
          totals: {
            checked: results.length,
            down: down.length,
            up: results.length - down.length,
          },
          down,
          results,
          durationMs: Date.now() - startedAt,
        },
        500
      );
    }

    const resend = new Resend(resendKey);

    const subject =
      down.length === 1
        ? `🚨 URL DOWN: ${down[0].url}`
        : `🚨 ${down.length} URLs DOWN`;

    const text = formatPlainTextAlert(down, results);

    try {
      const resp = await resend.emails.send({ from, to, subject, text });
      emailSent = true;
      emailId = resp?.data?.id ?? null;
    } catch (err) {
      return json(
        {
          ok: false,
          error: "Failed to send alert email via Resend.",
          details: String(err?.message || err),
          totals: {
            checked: results.length,
            down: down.length,
            up: results.length - down.length,
          },
          down,
          results,
          durationMs: Date.now() - startedAt,
        },
        502
      );
    }
  }

  return json({
    ok: down.length === 0,
    emailSent,
    emailId,
    totals: {
      checked: results.length,
      down: down.length,
      up: results.length - down.length,
    },
    down,
    results,
    durationMs: Date.now() - startedAt,
    timestamp: new Date().toISOString(),
  });
};

// ----------------------------
// Core monitoring logic
// ----------------------------

/**
 * Check a single monitor with retry logic
 *
 * Attempts to check a URL multiple times with exponential backoff
 * between failed attempts. Returns early on first success.
 *
 * @param {Monitor} monitor - The monitor configuration
 * @param {Object} options - Options object
 * @param {number} options.timeoutMs - Request timeout in milliseconds
 * @param {number} options.retries - Number of retry attempts
 * @returns {Promise<Object>} Summary of all attempts with final result
 */
async function checkWithRetries(monitor, { timeoutMs, retries }) {
  const attempts = [];
  const totalAttempts = Math.max(1, retries + 1);

  for (let i = 1; i <= totalAttempts; i++) {
    const attempt = await checkOnce(monitor, { timeoutMs });
    attempts.push(attempt);

    // success => stop early
    if (attempt.ok) {
      return summarizeAttempts(monitor, attempts);
    }

    // If this is not the last attempt, do a small backoff
    if (i < totalAttempts) {
      await sleep(backoffMs(i));
    }
  }

  return summarizeAttempts(monitor, attempts);
}

/**
 * Perform a single URL check
 *
 * Makes an HTTP request to the monitor URL and evaluates the response
 * against the expected criteria. Includes automatic fallback from HEAD
 * to GET if the server doesn't support HEAD requests.
 *
 * @param {Monitor} monitor - The monitor configuration
 * @param {Object} options - Options object
 * @param {number} options.timeoutMs - Request timeout in milliseconds
 * @returns {Promise<Object>} Single attempt result with status and timing
 */
async function checkOnce(monitor, { timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  const method = monitor.method || "HEAD";

  try {
    // HEAD first if configured, else GET
    let res = await fetch(monitor.url, {
      method,
      redirect: "follow",
      signal: controller.signal,
    });

    // If server rejects HEAD, optionally fall back to GET automatically
    if ((res.status === 405 || res.status === 501) && method === "HEAD") {
      res = await fetch(monitor.url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
      });
    }

    const ok = matchesExpectation(res.status, monitor.expect);

    return {
      ok,
      status: res.status,
      statusText: res.statusText,
      error: null,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      ok: false,
      status: null,
      statusText: null,
      error:
        err?.name === "AbortError" ? "timeout" : String(err?.message || err),
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Summarize multiple check attempts into a final result
 *
 * Combines all attempts for a monitor into a single result object
 * that indicates overall success/failure and includes details about
 * each individual attempt.
 *
 * @param {Monitor} monitor - The monitor configuration
 * @param {Array<Object>} attempts - Array of individual attempt results
 * @returns {Object} Summary object with overall status and attempt details
 */
function summarizeAttempts(monitor, attempts) {
  const last = attempts[attempts.length - 1];

  return {
    url: monitor.url,
    ok: attempts.some((a) => a.ok),
    expect: monitor.expect ?? "2xx3xx",
    method: monitor.method ?? "HEAD",
    attempts: attempts.length,
    lastStatus: last.status,
    lastError: last.error,
    attemptDetails: attempts,
  };
}

// ----------------------------
// Status code expectation matching
// ----------------------------

/**
 * Check if a status code matches the expected criteria
 *
 * Supports various expectation formats including simple strings,
 * specific code lists, ranges, and negation rules.
 *
 * @param {number|null} status - HTTP status code (null for network errors)
 * @param {string|Object} expect - Expectation criteria
 * @returns {boolean} True if status matches expectation
 */
function matchesExpectation(status, expect) {
  // Network error => status null
  if (status == null) return false;

  // Default: 2xx/3xx only
  if (!expect || expect === "2xx3xx") return status >= 200 && status < 400;

  // Normalized object form
  if (typeof expect === "object") {
    // Support: { not: <rule> }
    if (expect.not) return !matchesExpectation(status, expect.not);

    if (expect.anyOf && Array.isArray(expect.anyOf)) {
      return expect.anyOf.includes(status);
    }

    if (
      expect.between &&
      Array.isArray(expect.between) &&
      expect.between.length === 2
    ) {
      const [min, max] = expect.between;
      return status >= min && status <= max;
    }

    if (expect.oneOfRanges && Array.isArray(expect.oneOfRanges)) {
      return expect.oneOfRanges.some((r) => {
        if (!Array.isArray(r) || r.length !== 2) return false;
        const [min, max] = r;
        return status >= min && status <= max;
      });
    }
  }

  // Unknown expect format => be safe
  return false;
}

// ----------------------------
// Helper utilities
// ----------------------------

/**
 * Process an array with limited concurrency
 *
 * Similar to Promise.all but limits the number of concurrent operations
 * to prevent overwhelming servers or hitting rate limits.
 *
 * @param {Array} items - Items to process
 * @param {number} limit - Maximum concurrent operations
 * @param {Function} fn - Async function to apply to each item
 * @returns {Promise<Array>} Results in original order
 */
async function mapLimit(items, limit, fn) {
  const ret = [];
  let i = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (i < items.length) {
        const idx = i++;
        ret[idx] = await fn(items[idx]);
      }
    }
  );
  await Promise.all(workers);
  return ret;
}

/**
 * Calculate exponential backoff delay
 *
 * @param {number} attemptIndex - Attempt number (starts at 1)
 * @returns {number} Delay in milliseconds (250ms, 500ms, 1000ms, ...)
 */
function backoffMs(attemptIndex) {
  // attemptIndex starts at 1 for first failure backoff
  // 250ms, 500ms, 1000ms...
  return Math.min(2000, 250 * Math.pow(2, attemptIndex - 1));
}

/**
 * Sleep for specified milliseconds
 *
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>} Promise that resolves after delay
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Format monitoring results into plain text email content
 *
 * @param {Array<Object>} down - Array of failed monitor results
 * @param {Array<Object>} all - Array of all monitor results
 * @returns {string} Formatted plain text alert message
 */
function formatPlainTextAlert(down, all) {
  const lines = [];
  lines.push(`URL Monitor Alert`);
  lines.push(``);
  lines.push(`Down (${down.length}):`);
  for (const d of down) {
    const last = d.attemptDetails?.[d.attemptDetails.length - 1];
    lines.push(
      `- ${d.url} | attempts=${d.attempts} | expect=${formatExpect(
        d.expect
      )} | ` + (last?.error ? `error=${last.error}` : `status=${last?.status}`)
    );
  }
  lines.push(``);
  lines.push(`All results:`);
  for (const r of all) {
    const last = r.attemptDetails?.[r.attemptDetails.length - 1];
    lines.push(
      `- ${r.ok ? "UP  " : "DOWN"} ${r.url} | attempts=${r.attempts} | ` +
        (last?.error ? `error=${last.error}` : `status=${last?.status}`)
    );
  }
  return lines.join("\n");
}

/**
 * Format expectation object for display
 *
 * @param {string|Object} expect - Expectation criteria
 * @returns {string} Human-readable expectation string
 */
function formatExpect(expect) {
  if (!expect) return "2xx3xx";
  if (typeof expect === "string") return expect;
  try {
    return JSON.stringify(expect);
  } catch {
    return String(expect);
  }
}

/**
 * Create a JSON response
 *
 * @param {Object} obj - Object to serialize as JSON
 * @param {number} [status=200] - HTTP status code
 * @returns {Response} HTTP response with JSON content
 */
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
