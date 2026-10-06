/** Browser-safe bridge. Only the server runtime installs ownership/context isolation. */
const RUNTIME = Symbol.for("omniroute.control-plane-runtime/v1");
type Dispatch = <T>(operation: () => T) => T;
const runtime = globalThis as typeof globalThis & {
  [RUNTIME]?: { version: 1; dispatch: Dispatch };
};

export function installControlPlaneRuntime(dispatch: Dispatch): void {
  runtime[RUNTIME] = Object.freeze({ version: 1, dispatch });
}

/** Missing bootstrap cannot run metadata under unknown generation ownership. */
export function dispatchControlPlane<T>(operation: () => T): T {
  const installed = runtime[RUNTIME];
  if (installed?.version !== 1 || typeof installed.dispatch !== "function")
    throw new Error("Control-plane runtime is not initialized");
  return installed.dispatch(operation);
}
