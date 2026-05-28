/**
 * `proxy_download` event producer for the substrate-kernel download proxy.
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
// non-empty bounded label is accepted. We use `kernel_download_proxy` so
// dashboards can slice this Worker's events out from other proxies.
type EventSource = string;

/** The literal source label this Worker stamps on every event. */
const SOURCE: EventSource = 'kernel_download_proxy';

/** The literal event_name this Worker stamps on every event. */
const EVENT_NAME = 'kernel_download';

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

/**
 * Send one `proxy_download` event. Call via `ctx.waitUntil(...)` after
 * the response is on the wire — `recordDownload` resolves regardless of
 * queue health.
 */
export async function recordDownload(
  req: Request,
  env: ProxyEnv,
  download: DownloadFact,
): Promise<void> {
  const now = new Date().toISOString();
  const event: QueueEvent = {
    message_id: crypto.randomUUID() as MessageId,
    source: SOURCE,
    event_name: EVENT_NAME,

    // Fresh random per download — the proxy has no auth context, so
    // anonymous_id has no continuity between requests. The analytics
    // identity-model doc records this is the proxy convention.
    anonymous_id: crypto.randomUUID() as AnonymousId,
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
