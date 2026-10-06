# Configurable unpriced usage budget policy

Add `UNPRICED_USAGE_BUDGET_POLICY` (`fail_closed` by default; `count_as_zero` allows only genuinely missing prices) and `GET /api/pricing/unpriced-usage` for management-authenticated pricing coverage reports. Pricing lookup failures fail closed under both policies. Unpriced/lookup-failure budget rejections return 400 without `Retry-After`; priced quota overages retain 429 behavior (Anthropic messages remain 400).
