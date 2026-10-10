import { BaseExecutor } from "./base.ts";
import { sleep } from "../utils/sleep.ts";
import {
  isJsonObject,
  normalizeKieTaskState,
  type JsonObject,
  type KieTaskState,
} from "../utils/kieTask.ts";

export type { KieTaskState } from "../utils/kieTask.ts";

type KieTaskInput = {
  baseUrl: string;
  token: string;
  payload: unknown;
  endpoint?: string;
  signal?: AbortSignal;
};

type KiePollInput = {
  statusUrl: string;
  taskId: string;
  token: string;
  timeoutMs: number;
  pollIntervalMs: number;
  signal?: AbortSignal;
};

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export type KieTaskRecord = {
  data: JsonObject;
  state: KieTaskState;
};

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, "");
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export class KieExecutor extends BaseExecutor {
  constructor() {
    super("kie", { baseUrl: "https://api.kie.ai" });
  }

  getTaskCreateUrl(baseUrl: string, endpoint = "/api/v1/jobs/createTask"): string {
    return `${normalizeBaseUrl(baseUrl)}${endpoint}`;
  }

  getTaskStatusUrl(baseUrl: string): string {
    return `${normalizeBaseUrl(baseUrl)}/api/v1/jobs/recordInfo`;
  }

  async createTask({
    baseUrl,
    token,
    payload,
    endpoint,
    signal,
  }: KieTaskInput): Promise<JsonObject> {
    const res = await fetch(this.getTaskCreateUrl(baseUrl, endpoint), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal,
    });

    if (!res.ok) {
      const error = await res.text();
      throw Object.assign(new Error(error || `Kie createTask failed with status ${res.status}`), {
        status: res.status,
      });
    }

    const data = (await res.json()) as unknown;
    return isJsonObject(data) ? data : {};
  }

  async pollTask({
    statusUrl,
    taskId,
    token,
    timeoutMs,
    pollIntervalMs,
    signal,
  }: KiePollInput): Promise<KieTaskRecord> {
    const boundedTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.min(MAX_TIMER_DELAY_MS, Math.max(0, timeoutMs))
      : 0;
    const deadline = Date.now() + boundedTimeoutMs;
    const timeoutError = Object.assign(new Error("Kie task timed out"), { status: 504 });
    const requestController = new AbortController();
    const abortFromCaller = () =>
      requestController.abort(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener("abort", abortFromCaller, { once: true });
    const deadlineTimer = setTimeout(() => requestController.abort(timeoutError), boundedTimeoutMs);

    try {
      while (Date.now() < deadline) {
        if (signal?.aborted) signal.throwIfAborted();
        if (requestController.signal.aborted) throw requestController.signal.reason ?? timeoutError;
        const pollUrl = new URL(statusUrl);
        pollUrl.searchParams.set("taskId", String(taskId));

        const res = await fetch(pollUrl.toString(), {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
          signal: requestController.signal,
        });

        if (!res.ok) {
          const error = await res.text();
          throw Object.assign(new Error(error || `Kie poll failed with status ${res.status}`), {
            status: res.status,
          });
        }

        const data = (await res.json()) as unknown;
        const recordData = isJsonObject(data) ? data : {};
        const state = normalizeKieTaskState(recordData);
        if (state !== "pending") {
          return { data: recordData, state };
        }

        await sleepWithSignal(pollIntervalMs, requestController.signal);
      }

      throw timeoutError;
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export const kieExecutor = new KieExecutor();
