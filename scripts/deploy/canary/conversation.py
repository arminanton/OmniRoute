"""Paired generation-bound functional conversation handoff; no caller URLs or fake readiness."""
import re
import time
from .controller import Refused, exact
PROTOCOL = "omni-conversation-state/v1"
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")


def exchange(old, candidate, collect, *, clock=time.time):
    if old["generation"] == candidate["generation"] or old["namespace"] == candidate["namespace"]:
        raise Refused("conversation handoff requires distinct immutable generations")
    pending = []
    for generation in (old, candidate):
        value = collect(generation, None)
        exact(value, {"protocol", "generation", "namespace", "challengeId", "expiresAt"})
        if (value["protocol"] != PROTOCOL or value["generation"] != generation["generation"]
                or value["namespace"] != generation["namespace"]
                or not isinstance(value["challengeId"], str) or not UUID.fullmatch(value["challengeId"])
                or type(value["expiresAt"]) not in (int, float)
                or not clock() < value["expiresAt"] / 1000 <= clock() + 61):
            raise Refused("conversation challenge lacks fresh generation binding")
        pending.append(value)
    for index, generation in enumerate((old, candidate)):
        peer = (candidate, old)[index]
        challenge = pending[1 - index]
        if challenge["expiresAt"] / 1000 <= clock():
            raise Refused("conversation challenge expired before exchange")
        result = collect(generation, challenge["challengeId"])
        exact(result, {"protocol", "generation", "peerGeneration", "peerChallengeId", "completed"})
        if (result["protocol"] != PROTOCOL or result["generation"] != generation["generation"]
                or result["peerGeneration"] != peer["generation"]
                or result["peerChallengeId"] != challenge["challengeId"] or result["completed"] is not True):
            raise Refused("conversation peer did not prove the approved generation pair")
