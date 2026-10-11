import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileRecord } from "../../src/lib/db/files.ts";
import { getLeasedDurableVideoTaskContentResponse } from "../../src/app/api/v1/_shared/durableVideoTaskContent.ts";

async function withSharedCoordinator(run: () => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), "omni-video-content-lease-"));
  const previousShared = process.env.OMNI_SHARED_ADMISSION;
  const previousDb = process.env.OMNI_COORDINATION_DB;
  globalThis.__omniSharedCoordinator?.close();
  globalThis.__omniSharedCoordinator = undefined;
  process.env.OMNI_SHARED_ADMISSION = "true";
  process.env.OMNI_COORDINATION_DB = join(directory, "coordination.sqlite");
  try {
    await run();
  } finally {
    globalThis.__omniSharedCoordinator?.close();
    globalThis.__omniSharedCoordinator = undefined;
    if (previousShared === undefined) delete process.env.OMNI_SHARED_ADMISSION;
    else process.env.OMNI_SHARED_ADMISSION = previousShared;
    if (previousDb === undefined) delete process.env.OMNI_COORDINATION_DB;
    else process.env.OMNI_COORDINATION_DB = previousDb;
    rmSync(directory, { recursive: true, force: true });
  }
}

function file(): FileRecord {
  const content = Buffer.alloc(128 * 1024, 7);
  return {
    id: "video-result",
    bytes: content.length,
    createdAt: Date.now(),
    filename: "result.mp4",
    purpose: "video_task",
    content,
    mimeType: "video/mp4",
  };
}

test("private video result reads are capped at two until response drain or cancel", async () => {
  await withSharedCoordinator(async () => {
    let loaded = 0;
    const loadFile = () => {
      loaded += 1;
      return file();
    };
    const first = await getLeasedDurableVideoTaskContentResponse(
      new Request("http://localhost"),
      loadFile
    );
    const second = await getLeasedDurableVideoTaskContentResponse(
      new Request("http://localhost"),
      loadFile
    );
    assert.ok(first && second);

    let thirdResolved = false;
    const thirdPromise = getLeasedDurableVideoTaskContentResponse(
      new Request("http://localhost"),
      loadFile
    ).then((response) => {
      thirdResolved = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(
      loaded,
      2,
      "the third SQLite BLOB is not materialized while both permits are held"
    );
    assert.equal(thirdResolved, false, "the third result read waits for a permit");

    assert.equal((await first.arrayBuffer()).byteLength, 128 * 1024);
    const third = await thirdPromise;
    assert.ok(third);
    assert.equal(loaded, 3);

    await Promise.all([
      second.body!.cancel("client cancelled"),
      third.body!.cancel("client cancelled"),
    ]);
  });
});

test("private video result read releases its permit if BLOB loading fails", async () => {
  await withSharedCoordinator(async () => {
    await assert.rejects(
      getLeasedDurableVideoTaskContentResponse(new Request("http://localhost"), () => {
        throw new Error("sqlite read failed");
      }),
      /sqlite read failed/
    );

    const response = await getLeasedDurableVideoTaskContentResponse(
      new Request("http://localhost"),
      file
    );
    assert.ok(response);
    await response.body!.cancel("done");
  });
});
