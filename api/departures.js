import { getTripUpdates } from "../lib/trip-updates.js";

const STOP_ID = /^[\w:.-]{1,40}$/;

function json(body, status, cacheControl) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cacheControl },
  });
}

export async function GET(request) {
  const ids = [...new Set((new URL(request.url).searchParams.get("stops") || "").split(",").filter(Boolean))];
  if (!ids.length || ids.length > 10 || !ids.every(id => STOP_ID.test(id))) {
    return json({ error: "Geef 1 tot 10 geldige halte-id's op via ?stops=" }, 400, "no-store");
  }
  try {
    const feed = await getTripUpdates();
    const stops = Object.fromEntries(ids.map(id => [id, feed.byStop.get(id) || []]));
    return json(
      { available: true, stale: feed.stale, feedTimestamp: feed.feedTimestamp, fetchedAt: feed.fetchedAt, stops },
      200,
      "public, max-age=0, s-maxage=30, stale-while-revalidate=60",
    );
  } catch (err) {
    return json({ available: false, error: err.message, stops: {} }, 200, "public, max-age=0, s-maxage=15");
  }
}
