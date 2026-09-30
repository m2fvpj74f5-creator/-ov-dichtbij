import GtfsRealtimeBindings from "gtfs-realtime-bindings";

const { transit_realtime } = GtfsRealtimeBindings;
const FEED_URL = "https://gtfs.ovapi.nl/nl/tripUpdates.pb";
const FRESH_MS = 30_000;
const RETRY_AFTER_FAILURE_MS = 30_000;
const MAX_STALE_MS = 10 * 60_000;
const WINDOW_PAST_S = 5 * 60;
const WINDOW_FUTURE_S = 2 * 60 * 60;

const TRIP_CANCELED = transit_realtime.TripDescriptor.ScheduleRelationship.CANCELED;
const STOP_SKIPPED = transit_realtime.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED;

let cache = null;
let inflight = null;
let lastFailureAt = 0;

const toNumber = v => (v == null ? null : typeof v === "number" ? v : v.toNumber ? v.toNumber() : Number(v));

function buildIndex(feed) {
  const nowS = Date.now() / 1000;
  const byStop = new Map();
  for (const entity of feed.entity) {
    const tu = entity.tripUpdate;
    if (!tu?.trip) continue;
    const tripCancelled = tu.trip.scheduleRelationship === TRIP_CANCELED;
    for (const stu of tu.stopTimeUpdate) {
      if (!stu.stopId) continue;
      const event = stu.departure?.time != null ? stu.departure : stu.arrival;
      const time = toNumber(event?.time);
      if (time == null || time < nowS - WINDOW_PAST_S || time > nowS + WINDOW_FUTURE_S) continue;
      const delay = toNumber(event?.delay) ?? 0;
      const entry = {
        tripId: tu.trip.tripId || null,
        routeId: tu.trip.routeId || null,
        expected: time,
        planned: time - delay,
        delay,
        cancelled: tripCancelled || stu.scheduleRelationship === STOP_SKIPPED,
      };
      const list = byStop.get(stu.stopId);
      if (list) list.push(entry);
      else byStop.set(stu.stopId, [entry]);
    }
  }
  return byStop;
}

async function fetchFeed() {
  const res = await fetch(FEED_URL, {
    headers: { "User-Agent": "OV-Dichtbij/1.0 (+https://vercel.app)" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`TripUpdates feed gaf HTTP ${res.status}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const feed = transit_realtime.FeedMessage.decode(buf);
  return {
    byStop: buildIndex(feed),
    feedTimestamp: toNumber(feed.header?.timestamp) ?? Math.floor(Date.now() / 1000),
    fetchedAt: Date.now(),
  };
}

/** Returns the cached feed index, refreshing at most every 30s and serving stale data when upstream fails. */
export async function getTripUpdates() {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < FRESH_MS) return { ...cache, stale: false };
  if (now - lastFailureAt < RETRY_AFTER_FAILURE_MS) {
    if (cache && now - cache.fetchedAt < MAX_STALE_MS) return { ...cache, stale: true };
    throw new Error("Realtime feed tijdelijk niet beschikbaar");
  }
  inflight ??= fetchFeed()
    .then(result => {
      cache = result;
      return result;
    })
    .finally(() => {
      inflight = null;
    });
  try {
    return { ...(await inflight), stale: false };
  } catch (err) {
    lastFailureAt = Date.now();
    if (cache && Date.now() - cache.fetchedAt < MAX_STALE_MS) return { ...cache, stale: true };
    throw err;
  }
}
