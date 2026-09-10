import { RELEASE_METADATA } from "../_generated/release";

const HEADERS = {
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

/** Read-only release identity used by canonical exact-SHA acceptance. */
export async function onRequestGet(): Promise<Response> {
  return new Response(JSON.stringify(RELEASE_METADATA), { headers: HEADERS });
}
