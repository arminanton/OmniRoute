import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { load } from "js-yaml";

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const compose = load(fs.readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8")) as {
  services: Record<
    string,
    {
      image?: string;
      build?: { context?: string; target?: string; args?: Record<string, string> };
      profiles?: string[];
      volumes?: string[];
      environment?: string[];
      "<<"?: { volumes?: string[]; environment?: string[] }; // js-yaml leaves merge keys explicit.
      ports?: string[];
      entrypoint?: string[];
      command?: string[];
    }
  >;
};
const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");

const TOKEN_MOUNT_READ_ONLY = "codex-appserver-token:/run/codex-appserver:ro";
const TOKEN_MOUNT_WRITABLE = "codex-appserver-token:/run/codex-appserver";
const HOME_MOUNT = "codex-appserver-home:/home/node/.codex";

test("Codex app-server builds the same CLI-bearing image as the cli profile", () => {
  const sidecar = compose.services["codex-app-server"];
  const cli = compose.services["omniroute-cli"];
  assert.deepEqual(sidecar.profiles, ["codex-app-server"]);
  assert.equal(sidecar.image, cli.image);
  assert.equal(sidecar.image, "omniroute:cli");
  assert.deepEqual(sidecar.build, cli.build, "both services must build the same target and args");
  assert.equal(sidecar.build?.target, "runner-cli");

  const cliStage = dockerfile.split(/^FROM runner-base AS runner-cli\s*$/m)[1]?.split(/^FROM /m)[0];
  assert.ok(cliStage, "runner-cli must derive from runner-base");
  const cliInstructions = cliStage
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.match(cliInstructions, /npm install -g[^;]*@openai\/codex@\d+/s);
  assert.deepEqual(sidecar.entrypoint, ["/bin/sh", "-c"]);
  const command = sidecar.command?.join("\n") ?? "";
  assert.match(command, /exec codex app-server/);
  assert.match(command, /--ws-auth capability-token/);
  assert.match(command, /--ws-token-file/);
  assert.match(command, /umask 077/, "generated tokens must never be world-readable");
  assert.match(
    dockerfile,
    /RUN mkdir -p \/app\/data \/run\/codex-appserver \/home\/node\/\.codex/,
    "a fresh Docker named volume must inherit node-owned mount directory metadata"
  );
  assert.match(dockerfile, /chown -R node:node \/app \/run\/codex-appserver \/home\/node\/\.codex/);
  assert.equal(sidecar.ports, undefined, "the authenticated sidecar must remain internal-only");
});

test("all main app profiles share the capability token and Codex home with the sidecar", () => {
  for (const name of ["omniroute-base", "omniroute-web", "omniroute-cli", "omniroute-host"]) {
    const service = compose.services[name];
    const volumes = service?.volumes ?? service?.["<<"]?.volumes ?? [];
    assert.ok(volumes.includes(TOKEN_MOUNT_READ_ONLY), `${name} must read but not write the token`);
    assert.ok(volumes.includes(HOME_MOUNT), `${name} must mount the shared Codex auth home`);
  }
  const sidecarVolumes = compose.services["codex-app-server"].volumes ?? [];
  assert.ok(sidecarVolumes.includes(TOKEN_MOUNT_WRITABLE), "the sidecar must create its token");
  assert.ok(sidecarVolumes.includes(HOME_MOUNT), "the sidecar must read the shared auth home");
  // Unlike cli/base, host overrides the common environment list too.
  for (const name of ["omniroute-base", "omniroute-web", "omniroute-cli", "omniroute-host"]) {
    const service = compose.services[name];
    const environment = service.environment ?? service["<<"]?.environment ?? [];
    assert.ok(
      environment.includes(
        "OMNIROUTE_CODEX_APPSERVER_WS=${OMNIROUTE_CODEX_APPSERVER_WS:-ws://codex-app-server:1456}"
      ),
      `${name} must point at the internal sidecar`
    );
    assert.ok(
      environment.includes(
        "OMNIROUTE_CODEX_APPSERVER_WS_TOKEN_FILE=${OMNIROUTE_CODEX_APPSERVER_WS_TOKEN_FILE:-/run/codex-appserver/token}"
      ),
      `${name} must read the mounted token file`
    );
  }
  assert.ok(
    compose.services["omniroute-host"].volumes?.includes("~/.codex:/host-home/.codex:rw"),
    "host-mounted CLI auth must remain available separately"
  );
  assert.ok(
    compose.services["omniroute-cli"].volumes?.includes(
      "/var/run/docker.sock:/var/run/docker.sock"
    ),
    "the existing cli profile socket wiring must not be changed by this fix"
  );
  assert.equal(compose.services["omniroute-base"].build?.target, "runner-base");
  assert.equal(compose.services["omniroute-web"].build?.target, "runner-web");
  assert.equal(compose.services["omniroute-base"].image, "omniroute:base");
  assert.equal(compose.services["omniroute-web"].image, "omniroute:web");
});
