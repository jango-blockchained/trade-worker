import type { R2Bucket } from "@cloudflare/workers-types";
import type { WebhookPayload } from "@jango-blockchained/hoox-shared/types";

// --- Type Definitions ---

/**
 * Minimal environment interface for report operations.
 * Only includes the bindings needed by saveReportToR2 and handleGetReportRequest.
 */
export interface ReportsEnv {
  REPORTS_BUCKET?: R2Bucket;
}

// --- Report Functions ---

/**
 * Saves a trade report object to the R2 bucket.
 * Task 3.5 & 3.6
 */
export async function saveReportToR2(
  reportData: any, // The trade result or formatted report data
  payload: WebhookPayload,
  dbLogId: string | null, // Changed to string
  env: ReportsEnv
): Promise<void> {
  if (!env.REPORTS_BUCKET) {
    console.error(
      `[${dbLogId}] REPORTS_BUCKET binding is not configured. Skipping report save.`
    );
    return;
  }

  try {
    // Format a simple report (can be expanded later)
    const reportContent = JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        tradePayload: payload,
        tradeResult: reportData,
        dbLogId: dbLogId,
      },
      null,
      2
    );

    // Generate a unique filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-"); // Filesystem-friendly timestamp
    const filename = `trade-reports/${payload.exchange}/${payload.symbol}/${timestamp}-${dbLogId || "no-id"}.json`;

    console.log(`[${dbLogId}] Attempting to save report to R2: ${filename}`);

    // Put the object into the R2 bucket
    const r2Object = await env.REPORTS_BUCKET.put(filename, reportContent, {
      httpMetadata: { contentType: "application/json" },
      // Optionally add custom metadata
      // customMetadata: {
      //   exchange: payload.exchange,
      //   symbol: payload.symbol,
      //   action: payload.action,
      // },
    });

    console.log(
      `[${dbLogId}] Successfully saved report to R2. ETag: ${r2Object?.etag}`
    );
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : String(error || "Unknown R2 error");
    console.error(
      `[${dbLogId}] Failed to save report to R2: ${errorMsg}`,
      error
    );
    // Decide if this error should trigger an alert or other action
  }
}

/**
 * Handles GET requests to retrieve a specific report from R2.
 * Expects a 'key' query parameter specifying the R2 object key.
 * Task 3.5
 */
export async function handleGetReportRequest(
  request: Request,
  env: ReportsEnv
): Promise<Response> {
  const url = new URL(request.url);
  const key = url.searchParams.get("key");

  if (!key) {
    return new Response("Missing 'key' query parameter", { status: 400 });
  }

  if (!env.REPORTS_BUCKET) {
    console.error("REPORTS_BUCKET binding is not configured.");
    return new Response("R2 service not configured.", { status: 500 });
  }

  try {
    console.log(`Attempting to retrieve R2 object with key: ${key}`);
    const object = await env.REPORTS_BUCKET.get(key);

    if (object === null) {
      console.log(`R2 object not found for key: ${key}`);
      return new Response("Report not found", { status: 404 });
    }

    console.log(
      `Successfully retrieved R2 object: ${key}, Size: ${object.size}`
    );

    // Prepare headers for the response
    const headers = new Headers() as any;
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);

    // Stream the body back
    return new Response(object.body as any, {
      headers,
    });
  } catch (error: unknown) {
    const errorMsg =
      error instanceof Error
        ? error.message
        : String(error || "Unknown R2 get error");
    console.error(`Failed to retrieve R2 object ${key}: ${errorMsg}`, error);
    return new Response(`Failed to retrieve report: ${errorMsg}`, {
      status: 500,
    });
  }
}
