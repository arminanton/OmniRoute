Preserve GitHub Copilot endpoint metadata so Responses-only models route to
`/responses`. Honor Responses-target models on custom-base connections. Treat a
successful empty model discovery as authoritative; static fallback applies only
to missing credentials or discovery errors.
