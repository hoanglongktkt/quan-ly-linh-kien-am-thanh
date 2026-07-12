/** Debug session logging — remove after verification. */
export function debugLog(
  location: string,
  message: string,
  data: Record<string, unknown>,
  hypothesisId: string,
  runId = 'pre-fix',
) {
  // #region agent log
  fetch('http://127.0.0.1:7554/ingest/bc993c61-1b63-4f42-8c97-c42133e3ec03', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '809c09' },
    body: JSON.stringify({
      sessionId: '809c09',
      runId,
      hypothesisId,
      location,
      message,
      data,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}
