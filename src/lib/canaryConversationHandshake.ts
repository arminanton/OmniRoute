import {
  completeConversationStateHandoffChallenge,
  getConversationStateChallengeBinding,
} from "@omniroute/open-sse/services/conversationState/readiness";
const generationPattern = /^[a-f0-9]{32}$/;
const challengePattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Only called after management authentication; no peer URLs or supplied proof booleans. */
export async function acknowledgeCanaryConversationHandoff(request: Request): Promise<Response> {
  const generation = process.env.OMNIROUTE_APP_GENERATION || "";
  const headers = { "Cache-Control": "no-store", "X-Omni-App-Generation": generation };
  if (!generationPattern.test(generation))
    return Response.json({ error: "canary_generation_not_bootstrapped" }, { status: 503, headers });
  let payload: unknown;
  try {
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    if (reader)
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 4096) {
          await reader.cancel();
          return Response.json({ error: "handoff_body_limit" }, { status: 413, headers });
        }
        chunks.push(next.value);
      }
    const text = Buffer.concat(chunks).toString("utf8");
    if (Buffer.byteLength(text) > 4096)
      return Response.json({ error: "handoff_body_limit" }, { status: 413, headers });
    if ((text.match(/"(?:generation|peerChallengeId)"\s*:/g) || []).length !== 2)
      return Response.json(
        { error: "duplicate_or_unknown_handoff_fields" },
        { status: 400, headers }
      );
    payload = JSON.parse(text);
  } catch {
    return Response.json({ error: "invalid_handoff_json" }, { status: 400, headers });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload))
    return Response.json({ error: "invalid_handoff_request" }, { status: 400, headers });
  const value = payload as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "generation,peerChallengeId" ||
    value.generation !== generation ||
    typeof value.peerChallengeId !== "string" ||
    !challengePattern.test(value.peerChallengeId)
  )
    return Response.json(
      { error: "handoff_generation_or_shape_mismatch" },
      { status: 409, headers }
    );
  try {
    const binding = getConversationStateChallengeBinding(value.peerChallengeId);
    if (
      !binding ||
      binding.producerGeneration === generation ||
      binding.expiresAt <= Date.now() ||
      !completeConversationStateHandoffChallenge(value.peerChallengeId)
    )
      return Response.json({ error: "unproven_or_stale_peer_handoff" }, { status: 409, headers });
    return Response.json(
      {
        protocol: "omni-conversation-state/v1",
        generation,
        peerGeneration: binding.producerGeneration,
        peerChallengeId: value.peerChallengeId,
        completed: true,
      },
      { status: 200, headers }
    );
  } catch {
    return Response.json({ error: "handoff_state_unavailable" }, { status: 503, headers });
  }
}
