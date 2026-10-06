/** Business quota, authentication and generic timeouts never reduce a concurrency ceiling. */
export function classifyAdmissionFeedback(
  status: number,
  detail: string
): "success" | "concurrency_overload" | "ignored" {
  if (status >= 200 && status < 300) return "success";
  if (
    (status === 429 || status === 503) &&
    /too many concurrent|concurrency limit|concurrent requests? limit|too_many_concurrent_requests/i.test(
      detail
    )
  )
    return "concurrency_overload";
  return "ignored";
}
