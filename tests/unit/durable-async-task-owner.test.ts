import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { SqliteCoordinator } from "../../open-sse/services/coordination/sqliteCoordinator.ts";
import {
  SqliteAsyncTaskOwner,
  type CreateDurableAsyncTaskInput,
} from "../../open-sse/services/coordination/asyncTaskOwner.ts";

function createInput(
  overrides: Partial<CreateDurableAsyncTaskInput> = {}
): CreateDurableAsyncTaskInput {
  const idempotencyScope = overrides.idempotencyScope ?? "api-key-row-id";
  return {
    apiKeyId: overrides.apiKeyId ?? idempotencyScope,
    provider: "example-video",
    model: "video-model-v1",
    connectionId: "connection-opaque-id",
    strategy: "example-submit-poll",
    strategyVersion: "1",
    idempotencyScope,
    idempotencyKey: "client-request-stable-key",
    requestFingerprint: "a".repeat(64),
    deadlineAt: 100_000,
    capacity: [{ key: "quota:v1:example-account", maxConcurrency: 1 }],
    ...overrides,
  };
}

test("accepted task ownership survives restart, is idempotent, and releases capacity only after fenced completion", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-durable-video-task-"));
  const filename = join(directory, "coordination.sqlite");
  const now = 1_000;
  const firstCoordinator = new SqliteCoordinator(filename, "first-worker");
  let owner = new SqliteAsyncTaskOwner(filename);
  const request = createInput();
  let submitCount = 0;
  try {
    const created = owner.createSubmission(request, now);
    if (created.kind !== "created") throw new Error(`expected created task, got ${created.kind}`);
    submitCount += 1;
    assert.equal(created.task.state, "submitting");
    assert.equal(created.task.apiKeyId, request.apiKeyId);
    assert.equal(created.task.remoteTaskId, null);

    const competingWaiter = firstCoordinator.enqueue(
      [{ key: "quota:v1:example-account", limit: 1 }],
      90_000,
      10,
      now
    );
    assert.equal(firstCoordinator.tryAcquire(competingWaiter, 5_000, now), null);

    assert.throws(
      () =>
        owner.recordAccepted(
          created.task.id,
          created.submissionFence,
          " https://signed.example/video?token=secret",
          now + 5
        ),
      /invalid_remote_task_id/
    );
    assert.equal(owner.getTask(created.task.id)?.state, "submitting");

    assert.equal(
      owner.recordAccepted(created.task.id, created.submissionFence, "remote-job-123", now + 10),
      true
    );
    owner.close();
    owner = new SqliteAsyncTaskOwner(filename);

    const duplicate = owner.createSubmission(request, now + 20);
    if (duplicate.kind !== "existing")
      throw new Error(`expected existing task, got ${duplicate.kind}`);
    assert.equal(submitCount, 1, "a restart/retry must not cause another provider submit");
    assert.equal(duplicate.task.id, created.task.id);
    assert.equal(duplicate.task.remoteTaskId, "remote-job-123");
    assert.equal(
      owner.findSubmission({
        apiKeyId: request.apiKeyId,
        provider: request.provider,
        model: request.model,
        strategy: request.strategy,
        strategyVersion: request.strategyVersion,
        idempotencyScope: request.idempotencyScope,
        idempotencyKey: request.idempotencyKey,
        requestFingerprint: request.requestFingerprint,
      })?.id,
      created.task.id
    );
    assert.equal(owner.getTaskForScope(created.task.id, "other-api-key"), null);
    assert.equal(
      owner.getTaskForScope(created.task.id, request.idempotencyScope)?.id,
      created.task.id
    );
    assert.deepEqual(
      owner.listDueAcceptedTasks(now + 20, 5).map((task) => task.id),
      [created.task.id]
    );
    assert.throws(
      () => owner.createSubmission({ ...request, connectionId: "different-account" }, now + 20),
      /idempotency_key_conflict/
    );
    assert.throws(
      () =>
        owner.findSubmission({
          apiKeyId: request.apiKeyId,
          provider: request.provider,
          model: request.model,
          strategy: request.strategy,
          strategyVersion: request.strategyVersion,
          idempotencyScope: request.idempotencyScope,
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: "b".repeat(64),
        }),
      /idempotency_key_conflict/
    );
    for (const changed of [
      { ...request, strategy: "different-poll-strategy" },
      { ...request, strategyVersion: "2" },
      {
        ...request,
        capacity: [{ key: "quota:v1:example-account", maxConcurrency: 2 }],
      },
      {
        ...request,
        capacity: [{ key: "quota:v1:different-account", maxConcurrency: 1 }],
      },
    ]) {
      assert.throws(() => owner.createSubmission(changed, now + 20), /idempotency_key_conflict/);
    }

    const oldPollClaim = owner.claimPollOwner(
      created.task.id,
      "worker-before-restart",
      1_000,
      now + 20
    );
    assert.ok(oldPollClaim);
    assert.equal(owner.claimPollOwner(created.task.id, "concurrent-worker", 1_000, now + 21), null);

    owner.close();
    owner = new SqliteAsyncTaskOwner(filename);
    const reclaimed = owner.claimPollOwner(
      created.task.id,
      "worker-after-restart",
      1_000,
      now + 1_021
    );
    assert.ok(reclaimed);
    assert.ok(reclaimed.fence > oldPollClaim.fence);
    assert.throws(
      () => owner.finishPollTask(reclaimed, "rejected" as never, undefined, now + 1_022),
      /invalid_terminal_task_state/
    );
    assert.equal(
      owner.finishPollTaskWithArtifact(
        oldPollClaim,
        "file-test-artifact",
        now + 10_000,
        now + 1_022
      ),
      false
    );
    assert.equal(owner.markArtifactPending(reclaimed, now + 1_023), true);
    const slotDuringArtifactSave = firstCoordinator.tryAcquire(competingWaiter, 5_000, now + 1_024);
    assert.ok(
      slotDuringArtifactSave,
      "provider capacity is released when the remote task is terminal"
    );
    firstCoordinator.release(slotDuringArtifactSave);
    firstCoordinator.cancel(competingWaiter);
    assert.equal(
      owner.finishPollTaskWithArtifact(reclaimed, "file-test-artifact", now + 10_000, now + 1_025),
      true
    );
    assert.equal(owner.getTask(created.task.id)?.state, "succeeded");
    const terminalDuplicate = owner.createSubmission(request, now + 1_026);
    if (terminalDuplicate.kind !== "existing") {
      throw new Error(`expected terminal idempotency record, got ${terminalDuplicate.kind}`);
    }
    assert.equal(terminalDuplicate.task.state, "succeeded");
    assert.throws(
      () =>
        owner.createSubmission(
          { ...request, capacity: [{ key: "quota:v1:example-account", maxConcurrency: 2 }] },
          now + 1_027
        ),
      /idempotency_key_conflict/
    );
  } finally {
    owner.close();
    firstCoordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("unknown submit stays reserved and cannot be reclaimed for polling or resubmission", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-unknown-video-submit-"));
  const filename = join(directory, "coordination.sqlite");
  const now = 2_000;
  const coordinator = new SqliteCoordinator(filename, "unknown-test-worker");
  let owner = new SqliteAsyncTaskOwner(filename);
  const request = createInput({
    idempotencyScope: "owner-2",
    idempotencyKey: "ambiguous-submit-key",
    deadlineAt: 20_000,
  });
  try {
    const created = owner.createSubmission(request, now);
    if (created.kind !== "created") throw new Error(`expected created task, got ${created.kind}`);
    assert.equal(
      owner.markSubmissionUnknown(created.task.id, created.submissionFence, "socket_lost", now + 1),
      true
    );
    owner.close();
    owner = new SqliteAsyncTaskOwner(filename);

    assert.equal(owner.recoverExpiredSubmissions(now + 2), 0);
    assert.equal(owner.claimPollOwner(created.task.id, "recovery-worker", 1_000, now + 2), null);
    const duplicate = owner.createSubmission(request, now + 3);
    if (duplicate.kind !== "existing")
      throw new Error(`expected existing task, got ${duplicate.kind}`);
    assert.equal(duplicate.task.state, "submission_unknown");

    const blocked = owner.createSubmission(
      createInput({
        idempotencyScope: "owner-3",
        idempotencyKey: "different-task",
        deadlineAt: 30_000,
      }),
      now + 4
    );
    assert.equal(blocked.kind, "capacity_unavailable");
    if (blocked.kind === "capacity_unavailable") assert.equal(blocked.reason, "full");

    assert.equal(
      owner.rejectSubmission(
        created.task.id,
        created.submissionFence,
        "provider_rejected_429",
        now + 5
      ),
      true
    );
    assert.equal(owner.getTask(created.task.id)?.state, "rejected");
    const capacityReleased = owner.createSubmission(
      createInput({
        idempotencyScope: "owner-3",
        idempotencyKey: "different-task",
        deadlineAt: 30_000,
      }),
      now + 6
    );
    if (capacityReleased.kind !== "created") {
      throw new Error(`expected task after reconciliation, got ${capacityReleased.kind}`);
    }
    assert.equal(
      owner.rejectSubmission(
        capacityReleased.task.id,
        capacityReleased.submissionFence,
        "provider_confirmed_rejection",
        now + 7
      ),
      true
    );
    const taskAfterReject = owner.createSubmission(
      createInput({
        idempotencyScope: "owner-5",
        idempotencyKey: "after-rejection",
        deadlineAt: 30_000,
      }),
      now + 8
    );
    assert.equal(taskAfterReject.kind, "created");
  } finally {
    owner.close();
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation is persisted without releasing provider capacity until a fenced terminal observation", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-cancel-video-task-"));
  const filename = join(directory, "coordination.sqlite");
  const now = 4_000;
  const coordinator = new SqliteCoordinator(filename, "cancel-test-worker");
  const owner = new SqliteAsyncTaskOwner(filename);
  const request = createInput({ idempotencyScope: "cancel-owner", idempotencyKey: "cancel-key" });
  try {
    const created = owner.createSubmission(request, now);
    if (created.kind !== "created") throw new Error(`expected created task, got ${created.kind}`);
    assert.equal(
      owner.recordAccepted(created.task.id, created.submissionFence, "remote-cancel-job", now + 1),
      true
    );
    const cancelled = owner.requestCancellation(
      created.task.id,
      request.idempotencyScope,
      "caller_cancelled",
      now + 2
    );
    assert.equal(cancelled?.state, "cancel_requested");
    const waiter = coordinator.enqueue(
      [{ key: request.capacity[0].key, limit: 1 }],
      90_000,
      10,
      now + 3
    );
    assert.equal(coordinator.tryAcquire(waiter, 5_000, now + 3), null);

    const claim = owner.claimPollOwner(created.task.id, "cancel-poller", 1_000, now + 4);
    assert.ok(claim);
    assert.equal(owner.finishPollTask(claim, "cancelled", "caller_cancelled", now + 5), true);
    const lease = coordinator.tryAcquire(waiter, 5_000, now + 6);
    assert.ok(lease, "capacity is released only after remote task is observed terminal");
    coordinator.release(lease);
    coordinator.cancel(waiter);
  } finally {
    owner.close();
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("bounded retention prunes only terminal idempotency rows and keeps unknown work reserved", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-terminal-video-retention-"));
  const filename = join(directory, "coordination.sqlite");
  const now = 5_000;
  const coordinator = new SqliteCoordinator(filename, "retention-test-worker");
  const owner = new SqliteAsyncTaskOwner(filename);
  const terminalInput = createInput({
    idempotencyScope: "retention-owner",
    idempotencyKey: "terminal-key",
    capacity: [{ key: "quota:v1:terminal-account", maxConcurrency: 1 }],
  });
  const unknownInput = createInput({
    idempotencyScope: "retention-owner",
    idempotencyKey: "unknown-key",
    capacity: [{ key: "quota:v1:unknown-account", maxConcurrency: 1 }],
  });
  try {
    const terminal = owner.createSubmission(terminalInput, now);
    if (terminal.kind !== "created") throw new Error(`expected created task, got ${terminal.kind}`);
    assert.equal(
      owner.recordAccepted(terminal.task.id, terminal.submissionFence, "terminal-job", now + 1),
      true
    );
    const claim = owner.claimPollOwner(terminal.task.id, "retention-poller", 1_000, now + 1);
    assert.ok(claim);
    assert.equal(owner.markArtifactPending(claim, now + 2), true);
    assert.equal(
      owner.finishPollTaskWithArtifact(claim, "file-retention-test", now + 100_000, now + 3),
      true
    );

    const unknown = owner.createSubmission(unknownInput, now + 3);
    if (unknown.kind !== "created") throw new Error(`expected created task, got ${unknown.kind}`);
    owner.markSubmissionUnknown(unknown.task.id, unknown.submissionFence, "lost_submit", now + 4);

    const pruneNow = now + 3 + 7 * 24 * 60 * 60 * 1000;
    assert.equal(owner.pruneExpiredTerminalTasks(pruneNow, 10), 1);
    assert.equal(owner.getTask(terminal.task.id), null);
    assert.equal(owner.getTask(unknown.task.id)?.state, "submission_unknown");

    const waiter = coordinator.enqueue(
      [{ key: "quota:v1:unknown-account", limit: 1 }],
      pruneNow + 10_000,
      10,
      pruneNow
    );
    assert.equal(
      coordinator.tryAcquire(waiter, 5_000, pruneNow),
      null,
      "cleanup must never release a quarantined ambiguous submission"
    );
    coordinator.cancel(waiter);
  } finally {
    owner.close();
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("expired submitting intents recover as unknown and schema contains no payload or credential fields", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-expired-video-submit-"));
  const filename = join(directory, "coordination.sqlite");
  const coordinator = new SqliteCoordinator(filename, "expired-test-worker");
  const owner = new SqliteAsyncTaskOwner(filename);
  const now = 4_000;
  try {
    const created = owner.createSubmission(
      createInput({
        idempotencyScope: "owner-4",
        idempotencyKey: "expired-intent",
        deadlineAt: 5_000,
      }),
      now
    );
    if (created.kind !== "created") throw new Error(`expected created task, got ${created.kind}`);
    assert.equal(owner.recoverExpiredSubmissions(5_000), 1);
    assert.equal(owner.getTask(created.task.id)?.state, "submission_unknown");
    assert.equal(
      owner.recordAccepted(created.task.id, created.submissionFence + 1, "wrong-fence-id", 5_001),
      false
    );
    assert.equal(owner.getTask(created.task.id)?.state, "submission_unknown");
    assert.equal(
      owner.recordAccepted(created.task.id, created.submissionFence, "late-remote-id", 5_001),
      true
    );
    assert.equal(owner.getTask(created.task.id)?.state, "accepted");
    assert.equal(
      owner.rejectSubmission(created.task.id, created.submissionFence, "late_rejection", 5_002),
      false,
      "a late rejection/reconciliation must not overwrite a known acceptance"
    );
    const held = owner.createSubmission(
      createInput({
        idempotencyScope: "owner-4-other",
        idempotencyKey: "capacity-remains-held",
        deadlineAt: 10_000,
      }),
      5_003
    );
    assert.equal(held.kind, "capacity_unavailable");

    const inspect = new DatabaseSync(filename, { readOnly: true });
    try {
      const columns = (
        inspect.prepare("PRAGMA table_info(coordination_async_tasks)").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      assert.ok(columns.includes("provider"));
      assert.ok(columns.includes("connection_id"));
      assert.ok(columns.includes("remote_task_id"));
      assert.ok(
        !columns.some((name) => /^(prompt|credentials?|access_token|api_key)$/i.test(name)),
        "the task table may store the non-secret API-key row ID, never key material"
      );
      const stored = JSON.stringify(
        inspect.prepare("SELECT * FROM coordination_async_tasks").all()
      );
      assert.ok(!stored.includes("expired-intent"));
      assert.ok(!stored.includes("client-request-stable-key"));
    } finally {
      inspect.close();
    }
  } finally {
    owner.close();
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("durable admission does not bypass an older overlapping shared-coordination waiter", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-task-queue-fairness-"));
  const filename = join(directory, "coordination.sqlite");
  const coordinator = new SqliteCoordinator(filename, "queue-test-worker");
  const owner = new SqliteAsyncTaskOwner(filename);
  const now = 8_000;
  try {
    const currentRequest = coordinator.enqueue(
      [{ key: "account:queue-test", limit: 2 }],
      now + 10_000,
      10,
      now
    );
    const currentLease = coordinator.tryAcquire(currentRequest, 5_000, now);
    assert.ok(currentLease);
    const queuedRequest = coordinator.enqueue(
      [{ key: "account:queue-test", limit: 2 }],
      now + 10_000,
      10,
      now + 1
    );

    const queued = owner.createSubmission(
      createInput({
        idempotencyScope: "queue-owner",
        idempotencyKey: "queued-task",
        deadlineAt: now + 20_000,
        capacity: [{ key: "account:queue-test", maxConcurrency: 2 }],
      }),
      now + 2
    );
    assert.equal(queued.kind, "capacity_unavailable");
    if (queued.kind === "capacity_unavailable") assert.equal(queued.reason, "queued");

    coordinator.cancel(queuedRequest);
    const admitted = owner.createSubmission(
      createInput({
        idempotencyScope: "queue-owner",
        idempotencyKey: "queued-task",
        deadlineAt: now + 20_000,
        capacity: [{ key: "account:queue-test", maxConcurrency: 2 }],
      }),
      now + 3
    );
    assert.equal(admitted.kind, "created");
    coordinator.release(currentLease);
    coordinator.cancel(currentRequest);
  } finally {
    owner.close();
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a definitive submit rejection after recovery releases the unknown task only under its fence", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-unknown-submit-reject-"));
  const filename = join(directory, "coordination.sqlite");
  const coordinator = new SqliteCoordinator(filename, "rejection-test-worker");
  const owner = new SqliteAsyncTaskOwner(filename);
  const now = 60_000;
  try {
    const created = owner.createSubmission(
      createInput({
        idempotencyScope: "rejection-owner",
        idempotencyKey: "known-429",
        deadlineAt: now + 1_000,
      }),
      now
    );
    if (created.kind !== "created") throw new Error(`expected created task, got ${created.kind}`);
    assert.equal(owner.recoverExpiredSubmissions(now + 1_000), 1);
    assert.equal(
      owner.rejectSubmission(
        created.task.id,
        created.submissionFence + 1,
        "provider_rejected_429",
        now + 1_001
      ),
      false
    );
    assert.equal(owner.getTask(created.task.id)?.state, "submission_unknown");
    assert.equal(
      owner.rejectSubmission(
        created.task.id,
        created.submissionFence,
        "provider_rejected_429",
        now + 1_002
      ),
      true
    );
    assert.equal(owner.getTask(created.task.id)?.state, "rejected");
    const available = owner.createSubmission(
      createInput({
        idempotencyScope: "rejection-owner",
        idempotencyKey: "capacity-freed",
        deadlineAt: now + 2_000,
      }),
      now + 1_003
    );
    assert.equal(available.kind, "created");
  } finally {
    owner.close();
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("async task schema requires the supported shared-coordination protocol first", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-task-protocol-"));
  const filename = join(directory, "uninitialized.sqlite");
  const mismatchedFilename = join(directory, "mismatched.sqlite");
  try {
    assert.throws(
      () => new SqliteAsyncTaskOwner(filename),
      /Shared coordination must be initialized before async tasks/
    );
    const inspect = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        inspect
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='coordination_async_tasks'"
          )
          .get(),
        undefined,
        "rejected incompatible databases must not receive task tables"
      );
    } finally {
      inspect.close();
    }

    const mismatched = new DatabaseSync(mismatchedFilename);
    mismatched.exec(
      "CREATE TABLE coordination_protocol(version TEXT PRIMARY KEY); INSERT INTO coordination_protocol VALUES ('omni-coordination/v99');"
    );
    mismatched.close();
    assert.throws(
      () => new SqliteAsyncTaskOwner(mismatchedFilename),
      /Incompatible shared coordination protocol for async tasks/
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an old async-task protocol fails before current task DDL", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-async-task-schema-version-"));
  const filename = join(directory, "old-protocol.sqlite");
  const coordinator = new SqliteCoordinator(filename, "old-task-schema-worker");
  try {
    const oldSchema = new DatabaseSync(filename);
    oldSchema.exec(
      "CREATE TABLE coordination_async_task_protocol(version TEXT PRIMARY KEY); INSERT INTO coordination_async_task_protocol VALUES ('omni-async-task-owner/v1'); CREATE TABLE coordination_async_tasks(id TEXT PRIMARY KEY);"
    );
    oldSchema.close();

    assert.throws(
      () => new SqliteAsyncTaskOwner(filename),
      /Incompatible durable async task owner protocol/
    );
    const inspect = new DatabaseSync(filename, { readOnly: true });
    try {
      assert.equal(
        inspect
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='coordination_async_task_capacity'"
          )
          .get(),
        undefined,
        "a mismatched task protocol must fail before adding current capacity schema"
      );
    } finally {
      inspect.close();
    }
  } finally {
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a partial current-version task schema is rejected before additive DDL", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-partial-async-task-schema-"));
  const filename = join(directory, "partial-v4.sqlite");
  const coordinator = new SqliteCoordinator(filename, "partial-schema-worker");
  try {
    const partial = new DatabaseSync(filename);
    partial.exec(
      `CREATE TABLE coordination_async_task_protocol(version TEXT PRIMARY KEY);
       INSERT INTO coordination_async_task_protocol VALUES ('omni-async-task-owner/v4');
       CREATE TABLE coordination_async_tasks(id TEXT PRIMARY KEY);
       CREATE TABLE coordination_async_task_capacity(task_id TEXT,resource TEXT,cap INTEGER);`
    );
    partial.close();

    assert.throws(() => new SqliteAsyncTaskOwner(filename), /Partial durable async task schema/);
    const inspect = new DatabaseSync(filename, { readOnly: true });
    try {
      const columns = inspect.prepare("PRAGMA table_info(coordination_async_tasks)").all();
      assert.equal(columns.length, 1, "the rejected v4 database must remain untouched");
      assert.equal(
        inspect
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='coordination_async_tasks_pollable'"
          )
          .get(),
        undefined
      );
    } finally {
      inspect.close();
    }
  } finally {
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("poll-owner row decoding rejects an invalid poll_lease_until value", () => {
  const directory = mkdtempSync(join(tmpdir(), "omni-async-task-row-guard-"));
  const filename = join(directory, "coordination.sqlite");
  const coordinator = new SqliteCoordinator(filename, "row-guard-worker");
  const owner = new SqliteAsyncTaskOwner(filename);
  try {
    const created = owner.createSubmission(
      createInput({ idempotencyScope: "row-guard", idempotencyKey: "invalid-poll-lease" }),
      70_000
    );
    if (created.kind !== "created") throw new Error(`expected created task, got ${created.kind}`);
    assert.equal(
      owner.recordAccepted(created.task.id, created.submissionFence, "remote-job", 70_001),
      true
    );

    const mutate = new DatabaseSync(filename);
    try {
      mutate
        .prepare("UPDATE coordination_async_tasks SET poll_lease_until=? WHERE id=?")
        .run("not-an-integer", created.task.id);
    } finally {
      mutate.close();
    }

    assert.throws(
      () => owner.claimPollOwner(created.task.id, "row-guard-recovery", 1_000, 70_002),
      /invalid_async_task_poll_lease_until_in_sqlite/
    );
  } finally {
    owner.close();
    coordinator.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
