import { AsyncLocalStorage } from "node:async_hooks";
import type { Dispatcher } from "undici";

export interface FetchDispatchObserver {
  queued(): void;
  started(): void;
  responseStartTimeoutMs?: number;
}
declare global {
  var __omniFetchDispatchObserver: AsyncLocalStorage<FetchDispatchObserver> | undefined;
}
const dispatchObserver = (globalThis.__omniFetchDispatchObserver ??=
  new AsyncLocalStorage<FetchDispatchObserver>());

export function getObservedResponseStartTimeoutMs(): number | null {
  const value = dispatchObserver.getStore()?.responseStartTimeoutMs;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** Keep provider deadlines independent of time spent in a transport queue. */
export function withFetchDispatchObserver<T>(observer: FetchDispatchObserver, run: () => T): T {
  return dispatchObserver.run(observer, run);
}

export function notifyFetchRequestStart(): void {
  dispatchObserver.getStore()?.started();
}

/** Preserve receiver/private-field semantics of Undici dispatchers and handlers. */
export function observeFetchDispatcher(dispatcher: Dispatcher): Dispatcher {
  const observer = dispatchObserver.getStore();
  if (!observer) return dispatcher;
  return new Proxy(dispatcher, {
    get(target, property) {
      if (property === "dispatch") {
        return (options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) => {
          observer.queued();
          const tracked = new Proxy(handler, {
            get(receiver, name) {
              const value = Reflect.get(receiver, name, receiver);
              if (name === "onRequestStart") {
                return (...args: unknown[]) => {
                  observer.started();
                  if (typeof value === "function") return Reflect.apply(value, receiver, args);
                };
              }
              return typeof value === "function" ? value.bind(receiver) : value;
            },
          });
          return target.dispatch(options, tracked);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
