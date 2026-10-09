import test from "node:test";
import assert from "node:assert/strict";

/** Test-only model of a bounded, FIFO pre-clone admission queue. */
type RefusalReason =
  | "aborted"
  | "closed"
  | "deadline"
  | "pending_count"
  | "pending_source_bytes"
  | "reservation_too_large";

type Reservation = {
  readonly bytes: number;
  release(): void;
};

type AcquireResult =
  { status: "granted"; reservation: Reservation } | { status: "refused"; reason: RefusalReason };

type TimerScheduler = {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(timer: unknown): void;
};

type Waiter = {
  reservationBytes: number;
  sourceBytes: number;
  deadlineAt: number;
  signal?: AbortSignal;
  abortListener?: () => void;
  timer?: unknown;
  settled: boolean;
  resolve(result: AcquireResult): void;
};

class BoundedPreparationWaitPrototype {
  private reservedBytes = 0;
  private pendingSourceBytes = 0;
  private readonly waiters: Waiter[] = [];
  private isClosed = false;

  constructor(
    private readonly options: {
      maxReservedBytes: number;
      maxPendingCount: number;
      maxPendingSourceBytes: number;
      defaultDeadlineMs: number;
      scheduler: TimerScheduler;
    }
  ) {}

  snapshot() {
    return {
      reservedBytes: this.reservedBytes,
      pendingCount: this.waiters.length,
      pendingSourceBytes: this.pendingSourceBytes,
      closed: this.isClosed,
    };
  }

  acquire(input: {
    reservationBytes: number;
    sourceBytes: number;
    deadlineMs?: number;
    signal?: AbortSignal;
  }): Promise<AcquireResult> {
    const now = this.options.scheduler.now();
    const deadlineMs = input.deadlineMs ?? this.options.defaultDeadlineMs;
    if (this.isClosed) return Promise.resolve({ status: "refused", reason: "closed" });
    if (input.signal?.aborted) return Promise.resolve({ status: "refused", reason: "aborted" });
    if (deadlineMs <= 0) return Promise.resolve({ status: "refused", reason: "deadline" });
    if (
      !Number.isSafeInteger(input.reservationBytes) ||
      input.reservationBytes <= 0 ||
      input.reservationBytes > this.options.maxReservedBytes
    ) {
      return Promise.resolve({ status: "refused", reason: "reservation_too_large" });
    }
    if (!Number.isSafeInteger(input.sourceBytes) || input.sourceBytes < 0) {
      return Promise.resolve({ status: "refused", reason: "pending_source_bytes" });
    }

    // Do not let a newly arriving small item bypass an older waiter.
    if (
      this.waiters.length === 0 &&
      this.reservedBytes + input.reservationBytes <= this.options.maxReservedBytes
    ) {
      return Promise.resolve({
        status: "granted",
        reservation: this.makeReservation(input.reservationBytes),
      });
    }

    if (this.waiters.length >= this.options.maxPendingCount) {
      return Promise.resolve({ status: "refused", reason: "pending_count" });
    }
    if (input.sourceBytes > this.options.maxPendingSourceBytes - this.pendingSourceBytes) {
      return Promise.resolve({ status: "refused", reason: "pending_source_bytes" });
    }

    return new Promise((resolve) => {
      const waiter: Waiter = {
        reservationBytes: input.reservationBytes,
        sourceBytes: input.sourceBytes,
        deadlineAt: now + deadlineMs,
        ...(input.signal ? { signal: input.signal } : {}),
        settled: false,
        resolve,
      };
      this.waiters.push(waiter);
      this.pendingSourceBytes += waiter.sourceBytes;
      waiter.timer = this.options.scheduler.setTimeout(
        () => this.refuseWaiter(waiter, "deadline"),
        deadlineMs
      );
      if (waiter.signal) {
        waiter.abortListener = () => this.refuseWaiter(waiter, "aborted");
        waiter.signal.addEventListener("abort", waiter.abortListener, { once: true });
      }
    });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    for (const waiter of [...this.waiters]) this.refuseWaiter(waiter, "closed", false);
  }

  private makeReservation(bytes: number): Reservation {
    this.reservedBytes += bytes;
    let released = false;
    return {
      bytes,
      release: () => {
        if (released) return;
        released = true;
        this.reservedBytes -= bytes;
        this.pump();
      },
    };
  }

  private cleanup(waiter: Waiter): void {
    if (waiter.timer !== undefined) this.options.scheduler.clearTimeout(waiter.timer);
    if (waiter.signal && waiter.abortListener) {
      waiter.signal.removeEventListener("abort", waiter.abortListener);
    }
  }

  private refuseWaiter(waiter: Waiter, reason: RefusalReason, pump = true): void {
    if (waiter.settled) return;
    const index = this.waiters.indexOf(waiter);
    if (index < 0) return;
    this.waiters.splice(index, 1);
    this.pendingSourceBytes -= waiter.sourceBytes;
    waiter.settled = true;
    this.cleanup(waiter);
    waiter.resolve({ status: "refused", reason });
    if (pump) this.pump();
  }

  private grantWaiter(waiter: Waiter): void {
    if (waiter.settled) return;
    this.waiters.shift();
    this.pendingSourceBytes -= waiter.sourceBytes;
    waiter.settled = true;
    this.cleanup(waiter);
    waiter.resolve({
      status: "granted",
      reservation: this.makeReservation(waiter.reservationBytes),
    });
  }

  private pump(): void {
    if (this.isClosed) return;
    while (this.waiters.length > 0) {
      const waiter = this.waiters[0];
      if (waiter.signal?.aborted) {
        this.refuseWaiter(waiter, "aborted", false);
        continue;
      }
      if (this.options.scheduler.now() >= waiter.deadlineAt) {
        this.refuseWaiter(waiter, "deadline", false);
        continue;
      }
      if (this.reservedBytes + waiter.reservationBytes > this.options.maxReservedBytes) return;
      this.grantWaiter(waiter);
    }
  }
}

type FakeTimer = { id: number; dueAt: number; callback: () => void; cancelled: boolean };

class FakeScheduler implements TimerScheduler {
  private currentTime = 0;
  private nextTimerId = 1;
  private readonly timers = new Set<FakeTimer>();

  now(): number {
    return this.currentTime;
  }

  setTimeout(callback: () => void, delayMs: number): FakeTimer {
    const timer = {
      id: this.nextTimerId++,
      dueAt: this.currentTime + delayMs,
      callback,
      cancelled: false,
    };
    this.timers.add(timer);
    return timer;
  }

  clearTimeout(value: unknown): void {
    if (value && typeof value === "object" && "cancelled" in value) {
      (value as FakeTimer).cancelled = true;
      this.timers.delete(value as FakeTimer);
    }
  }

  advanceBy(deltaMs: number): void {
    const target = this.currentTime + deltaMs;
    while (true) {
      const next = [...this.timers]
        .filter((timer) => !timer.cancelled && timer.dueAt <= target)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
      if (!next) break;
      this.timers.delete(next);
      next.cancelled = true;
      this.currentTime = next.dueAt;
      next.callback();
    }
    this.currentTime = target;
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

test("preparation wait prototype grants strict FIFO and releases reservation bytes once", async () => {
  const gate = new BoundedPreparationWaitPrototype({
    maxReservedBytes: 10,
    maxPendingCount: 2,
    maxPendingSourceBytes: 8,
    defaultDeadlineMs: 100,
    scheduler: new FakeScheduler(),
  });
  const first = await gate.acquire({ reservationBytes: 10, sourceBytes: 2 });
  assert.equal(first.status, "granted");
  if (first.status !== "granted") return;

  const grants: string[] = [];
  const secondPromise = gate.acquire({ reservationBytes: 6, sourceBytes: 3 }).then((result) => {
    if (result.status === "granted") grants.push("second");
    return result;
  });
  const thirdPromise = gate.acquire({ reservationBytes: 4, sourceBytes: 4 }).then((result) => {
    if (result.status === "granted") grants.push("third");
    return result;
  });
  assert.deepEqual(gate.snapshot(), {
    reservedBytes: 10,
    pendingCount: 2,
    pendingSourceBytes: 7,
    closed: false,
  });

  first.reservation.release();
  const [second, third] = await Promise.all([secondPromise, thirdPromise]);
  assert.deepEqual(grants, ["second", "third"]);
  assert.equal(second.status, "granted");
  assert.equal(third.status, "granted");
  if (second.status !== "granted" || third.status !== "granted") return;
  assert.equal(gate.snapshot().reservedBytes, 10);

  second.reservation.release();
  second.reservation.release();
  assert.equal(gate.snapshot().reservedBytes, 4);
  third.reservation.release();
  assert.equal(gate.snapshot().reservedBytes, 0);
  assert.equal(gate.snapshot().pendingSourceBytes, 0);
});

test("preparation wait prototype refuses count, source-byte, deadline, and cancellation overflow", async () => {
  const scheduler = new FakeScheduler();
  const countGate = new BoundedPreparationWaitPrototype({
    maxReservedBytes: 10,
    maxPendingCount: 1,
    maxPendingSourceBytes: 10,
    defaultDeadlineMs: 50,
    scheduler,
  });
  const countBlocker = await countGate.acquire({ reservationBytes: 10, sourceBytes: 0 });
  assert.equal(countBlocker.status, "granted");
  const counted = countGate.acquire({ reservationBytes: 1, sourceBytes: 4 });
  assert.deepEqual(await countGate.acquire({ reservationBytes: 1, sourceBytes: 1 }), {
    status: "refused",
    reason: "pending_count",
  });
  assert.equal(countGate.snapshot().pendingSourceBytes, 4);
  countGate.close();
  assert.deepEqual(await counted, { status: "refused", reason: "closed" });
  if (countBlocker.status === "granted") countBlocker.reservation.release();

  const byteGate = new BoundedPreparationWaitPrototype({
    maxReservedBytes: 10,
    maxPendingCount: 2,
    maxPendingSourceBytes: 3,
    defaultDeadlineMs: 50,
    scheduler,
  });
  const byteBlocker = await byteGate.acquire({ reservationBytes: 10, sourceBytes: 0 });
  assert.equal(byteBlocker.status, "granted");
  assert.deepEqual(await byteGate.acquire({ reservationBytes: 11, sourceBytes: 0 }), {
    status: "refused",
    reason: "reservation_too_large",
  });
  const byteWaiter = byteGate.acquire({ reservationBytes: 1, sourceBytes: 3 });
  assert.deepEqual(await byteGate.acquire({ reservationBytes: 1, sourceBytes: 1 }), {
    status: "refused",
    reason: "pending_source_bytes",
  });
  assert.equal(byteGate.snapshot().pendingSourceBytes, 3);
  byteGate.close();
  assert.deepEqual(await byteWaiter, { status: "refused", reason: "closed" });
  if (byteBlocker.status === "granted") byteBlocker.reservation.release();

  const expiryGate = new BoundedPreparationWaitPrototype({
    maxReservedBytes: 10,
    maxPendingCount: 2,
    maxPendingSourceBytes: 4,
    defaultDeadlineMs: 50,
    scheduler,
  });
  const expiryBlocker = await expiryGate.acquire({ reservationBytes: 10, sourceBytes: 0 });
  assert.equal(expiryBlocker.status, "granted");
  const expiring = expiryGate.acquire({ reservationBytes: 1, sourceBytes: 2 });
  scheduler.advanceBy(50);
  assert.deepEqual(await expiring, { status: "refused", reason: "deadline" });
  assert.equal(expiryGate.snapshot().pendingSourceBytes, 0);

  const abort = new AbortController();
  const cancelled = expiryGate.acquire({
    reservationBytes: 1,
    sourceBytes: 1,
    signal: abort.signal,
  });
  abort.abort();
  assert.deepEqual(await cancelled, { status: "refused", reason: "aborted" });
  assert.equal(expiryGate.snapshot().pendingCount, 0);
  assert.equal(expiryGate.snapshot().pendingSourceBytes, 0);
  if (expiryBlocker.status === "granted") expiryBlocker.reservation.release();
});

test("closing the preparation wait prototype settles every waiter and active releases still drain", async () => {
  const gate = new BoundedPreparationWaitPrototype({
    maxReservedBytes: 10,
    maxPendingCount: 3,
    maxPendingSourceBytes: 9,
    defaultDeadlineMs: 100,
    scheduler: new FakeScheduler(),
  });
  const active = await gate.acquire({ reservationBytes: 10, sourceBytes: 0 });
  assert.equal(active.status, "granted");
  const waiters = [
    gate.acquire({ reservationBytes: 4, sourceBytes: 3 }),
    gate.acquire({ reservationBytes: 4, sourceBytes: 4 }),
  ];
  gate.close();
  assert.deepEqual(await Promise.all(waiters), [
    { status: "refused", reason: "closed" },
    { status: "refused", reason: "closed" },
  ]);
  assert.deepEqual(await gate.acquire({ reservationBytes: 1, sourceBytes: 1 }), {
    status: "refused",
    reason: "closed",
  });
  assert.equal(gate.snapshot().pendingCount, 0);
  assert.equal(gate.snapshot().pendingSourceBytes, 0);
  if (active.status === "granted") active.reservation.release();
  assert.equal(gate.snapshot().reservedBytes, 0);
});

test("FIFO prototype models response completion before worker artifact persistence", async () => {
  const scheduler = new FakeScheduler();
  const gate = new BoundedPreparationWaitPrototype({
    maxReservedBytes: 10,
    maxPendingCount: 2,
    maxPendingSourceBytes: 8,
    defaultDeadlineMs: 1_000,
    scheduler,
  });
  const workerDone = [deferred<void>(), deferred<void>()];
  const responseClosedAt: Array<{ id: string; at: number }> = [];
  const workerStartedAt: Array<{ id: string; at: number }> = [];
  const artifactCompletedAt: Array<{ id: string; at: number }> = [];
  const saves: Promise<void>[] = [];

  const streamCompletion = (id: string, index: number): void => {
    // This detached save models persistAttemptLogs -> saveCallLog: the stream
    // completion callback deliberately does not await artifact admission or I/O.
    const save = (async () => {
      const result = await gate.acquire({ reservationBytes: 10, sourceBytes: 4 });
      if (result.status !== "granted") throw new Error(`unexpected refusal: ${result.reason}`);
      workerStartedAt.push({ id, at: scheduler.now() });
      await workerDone[index].promise;
      result.reservation.release();
      artifactCompletedAt.push({ id, at: scheduler.now() });
    })();
    saves.push(save);
    responseClosedAt.push({ id, at: scheduler.now() });
  };

  streamCompletion("first", 0);
  streamCompletion("second", 1);
  await flushMicrotasks();
  assert.deepEqual(responseClosedAt, [
    { id: "first", at: 0 },
    { id: "second", at: 0 },
  ]);
  assert.deepEqual(workerStartedAt, [{ id: "first", at: 0 }]);
  assert.deepEqual(artifactCompletedAt, []);
  assert.deepEqual(gate.snapshot(), {
    reservedBytes: 10,
    pendingCount: 1,
    pendingSourceBytes: 4,
    closed: false,
  });

  scheduler.advanceBy(100);
  workerDone[0].resolve();
  await flushMicrotasks();
  assert.deepEqual(workerStartedAt, [
    { id: "first", at: 0 },
    { id: "second", at: 100 },
  ]);
  assert.deepEqual(artifactCompletedAt, [{ id: "first", at: 100 }]);
  assert.deepEqual(
    responseClosedAt.map((event) => event.at),
    [0, 0]
  );

  scheduler.advanceBy(100);
  workerDone[1].resolve();
  await Promise.all(saves);
  assert.deepEqual(artifactCompletedAt, [
    { id: "first", at: 100 },
    { id: "second", at: 200 },
  ]);
  assert.equal(gate.snapshot().reservedBytes, 0);
});
