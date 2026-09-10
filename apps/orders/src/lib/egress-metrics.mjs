const MAX_BREAKDOWN_KEYS = 50;

export function createEgressMetricsCollector({ workloadId, releaseVersion } = {}) {
  const state = {
    workload_id: text(workloadId) || "unattributed",
    release_version: text(releaseVersion) || "unknown",
    requests: 0,
    successful_requests: 0,
    failed_requests: 0,
    response_content_length_bytes: 0,
    response_content_length_samples: 0,
    decoded_json_bytes: 0,
    decoded_json_samples: 0,
    rows_returned: 0,
    by_resource: {},
  };

  return {
    recordResponse({ url, status, contentLength }) {
      state.requests += 1;
      if (Number(status) >= 200 && Number(status) < 400) state.successful_requests += 1;
      else state.failed_requests += 1;
      const bytes = positiveInteger(contentLength);
      if (bytes !== null) {
        state.response_content_length_bytes += bytes;
        state.response_content_length_samples += 1;
      }
      const resource = resourceFromUrl(url);
      const bucket = resourceBucket(state, resource);
      bucket.requests += 1;
      if (bytes !== null) bucket.response_content_length_bytes += bytes;
    },
    recordRows({ resource, rows, decodedJsonBytes }) {
      const rowCount = Math.max(0, Number(rows) || 0);
      const bytes = Math.max(0, Number(decodedJsonBytes) || 0);
      state.rows_returned += rowCount;
      state.decoded_json_bytes += bytes;
      state.decoded_json_samples += 1;
      const bucket = resourceBucket(state, text(resource) || "unknown");
      bucket.rows_returned += rowCount;
      bucket.decoded_json_bytes += bytes;
    },
    snapshot() {
      return JSON.parse(JSON.stringify(state));
    },
  };
}

export function decodedJsonByteLength(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
}

function resourceBucket(state, resource) {
  if (!state.by_resource[resource] && Object.keys(state.by_resource).length < MAX_BREAKDOWN_KEYS) {
    state.by_resource[resource] = {
      requests: 0,
      response_content_length_bytes: 0,
      rows_returned: 0,
      decoded_json_bytes: 0,
    };
  }
  return state.by_resource[resource] || {
    requests: 0,
    response_content_length_bytes: 0,
    rows_returned: 0,
    decoded_json_bytes: 0,
  };
}

function resourceFromUrl(value) {
  try {
    const url = new URL(String(value));
    const marker = "/rest/v1/";
    const index = url.pathname.indexOf(marker);
    if (index >= 0) return url.pathname.slice(index + marker.length).split("/")[0] || "rest";
    return url.pathname || "unknown";
  } catch {
    return "unknown";
  }
}

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function text(value) {
  return String(value ?? "").trim();
}
