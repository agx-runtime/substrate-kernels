/**
 * `kernel_download` event producer for the substrate-kernel download proxy.
 *
 * Hand-rolled per the analytics queue contract at
 *   https://github.com/loopholelabs/analytics/blob/main/docs/spec/queue-protocol.md
 * (private repo; substrate-kernel does NOT take a package dependency on
 * the analytics monorepo — bun 1.3.x cannot authenticate private GitHub
 * git installs, and the analytics ADR 0015 explicitly endorses the
 * hand-roll path as first-class: "the spec is authoritative; a
 * hand-rolled producer that conforms to it is equivalent.").
 *
 * The shape this file emits MUST stay in sync with that spec. The
 * integration test asserts the spec-required fields on every event, so
 * a divergent change to the spec is caught here when the analytics
 * consumer rejects the row — not in production by silent data loss.
 *
 * Failure mode: a failed EVENTS_QUEUE.send is logged via console.error
 * and swallowed. Analytics MUST NOT break a kernel download (CLAUDE.md
 * §5 — safety first; a dropped event is acceptable, a failed download
 * is not).
 */

// Branded ID types — match analytics/packages/shared/src/event.ts so the
// shape is recognizable, even though we don't import from there.
type AnonymousId = string & { readonly __brand: 'AnonymousId' };
type UserId = string & { readonly __brand: 'UserId' };
type GroupId = string & { readonly __brand: 'GroupId' };
type MessageId = string & { readonly __brand: 'MessageId' };

// `source` is an open set per the analytics queue-protocol spec — any
// non-empty bounded label (≤ MAX_SOURCE_LENGTH = 64) is accepted. This
// Worker stamps `WEB:<HOSTNAME UPPERCASE>` (e.g. `WEB:KERNELS.AGX.SO`) so the
// server-side download event shares one `source` with the listing page's
// RudderStack SDK events on the same host (those get the same source via the
// per-host write key → KV mapping; docs/adr/0012). Dashboards GROUP BY
// `source` for per-domain totals; `event_name` distinguishes the actual byte
// transfer (`kernel_download`) from the page's click intent
// (`kernel_download_click`).
type EventSource = string;

/** The literal event_name this Worker stamps on every download event. */
const EVENT_NAME = 'kernel_download';

// Where a caller-supplied anonymous id can arrive. The CLI sets the header;
// the listing page sets the cookie (from the RudderStack SDK's anonymous id)
// so a same-origin download navigation carries it — that is what correlates
// the page's `kernel_download_click` with this server-side `kernel_download`
// (docs/adr/0012). Absent/invalid → a fresh random UUID (no continuity).
const ANON_ID_HEADER = 'X-Substrate-Anonymous-Id';
const ANON_ID_COOKIE = 'substrate_aid';
/** Bounds + charset for an accepted anonymous id (≤128 = analytics MAX_ID_LENGTH). */
const ANON_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/**
 * The row that lands on the analytics queue and (1:1) in the `events`
 * ClickHouse table. snake_case to match the CH columns. `properties` is a
 * real JSON object; the analytics consumer's native JSON column parses
 * it into typed subcolumns — do NOT stringify.
 */
export interface QueueEvent {
  message_id: MessageId;
  source: EventSource;
  event_name: string;

  anonymous_id: AnonymousId | null;
  user_id: UserId | null;
  group_id: GroupId | null;

  /** ISO 8601, event time. */
  timestamp: string;
  /** ISO 8601, ingest time. For a proxy download these coincide. */
  received_at: string;

  ip: string | null;
  ip_asn: number | null;
  ip_org: string | null;
  ip_country: string | null;
  ip_city: string | null;
  user_agent: string | null;

  properties: Record<string, unknown>;
}

/** What the Worker must have on `env` for `recordDownload` to work. */
export interface ProxyEnv {
  /** Producer binding for the analytics events queue. */
  EVENTS_QUEUE: Queue<QueueEvent>;
}

/** What the caller tells the producer about the download in flight. */
export interface DownloadFact {
  /** The artifact identifier — for kernel bundles, "linux-<variant>-<arch>". */
  package: string;
  /** The pinned kernel version, e.g. "6.12.91". */
  version: string;
  /** The Content-Length the proxy is about to send. */
  bytes: number;
}

function enrichFromRequest(req: Request): {
  ip: string | null;
  ip_asn: number | null;
  ip_org: string | null;
  ip_country: string | null;
  ip_city: string | null;
  user_agent: string | null;
} {
  // `request.cf` is populated by Cloudflare's edge in production. In local
  // `wrangler dev` it can be undefined for some configurations — fall back
  // to nulls so the producer never throws.
  const cf = req.cf as IncomingRequestCfProperties | undefined;
  return {
    ip: req.headers.get('CF-Connecting-IP'),
    ip_asn: cf?.asn ?? null,
    ip_org: cf?.asOrganization ?? null,
    ip_country: cf?.country ?? null,
    ip_city: cf?.city ?? null,
    user_agent: req.headers.get('User-Agent'),
  };
}

/** Read one cookie value out of a `Cookie` header (case-sensitive name). */
function parseCookie(header: string | null, name: string): string | null {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Resolve the event's anonymous id: the `X-Substrate-Anonymous-Id` header
 * (CLI) wins, then the `substrate_aid` cookie (browser, same-origin), then a
 * fresh random UUID. A supplied id must match ANON_ID_PATTERN — anything else
 * is ignored (so a malformed input never poisons the column) and falls
 * through to random.
 */
function resolveAnonymousId(req: Request): AnonymousId {
  const header = req.headers.get(ANON_ID_HEADER);
  if (header !== null && ANON_ID_PATTERN.test(header)) return header as AnonymousId;
  const cookie = parseCookie(req.headers.get('Cookie'), ANON_ID_COOKIE);
  if (cookie !== null && ANON_ID_PATTERN.test(cookie)) return cookie as AnonymousId;
  return crypto.randomUUID() as AnonymousId;
}

/** `source` = `WEB:<HOSTNAME UPPERCASE>` derived from the request's host. */
function webSource(req: Request): EventSource {
  return `WEB:${new URL(req.url).hostname.toUpperCase()}`;
}

/**
 * Send one `kernel_download` event. Call via `ctx.waitUntil(...)` after the
 * response is on the wire — `recordDownload` resolves regardless of queue
 * health.
 */
export async function recordDownload(
  req: Request,
  env: ProxyEnv,
  download: DownloadFact,
): Promise<void> {
  const now = new Date().toISOString();
  const event: QueueEvent = {
    message_id: crypto.randomUUID() as MessageId,
    source: webSource(req),
    event_name: EVENT_NAME,

    // Caller-supplied id (CLI header / browser cookie) or a fresh random
    // UUID — the proxy has no auth context of its own (resolveAnonymousId).
    anonymous_id: resolveAnonymousId(req),
    user_id: null,
    group_id: null,

    timestamp: now,
    received_at: now,

    ...enrichFromRequest(req),

    properties: {
      package: download.package,
      version: download.version,
      bytes: download.bytes,
    },
  };

  try {
    await env.EVENTS_QUEUE.send(event);
  } catch (e) {
    // Drop the event. NEVER surface an analytics failure to the caller —
    // a failed kernel download is much worse than a missed metric.
    console.error('download-proxy: analytics queue send failed', {
      message_id: event.message_id,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
