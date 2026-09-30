"use client";
import { useEffect, useRef, useState } from "react";
export default function BrowserLoginPanel({
  connectionId,
  onCaptured,
}: {
  connectionId: string;
  onCaptured: () => void;
}) {
  const [session, setSession] = useState<{ id: string; expires: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const current = useRef<string | null>(null);
  const base = `/api/providers/${encodeURIComponent(connectionId)}/browser-login`;
  useEffect(
    () => () => {
      if (current.current)
        void fetch(`${base}/${current.current}/cancel`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
          keepalive: true,
        });
    },
    [base]
  );
  async function action(operation: "start" | "capture" | "cancel") {
    setBusy(true);
    setMessage("");
    try {
      const path = operation === "start" ? "start" : `${session?.id}/${operation}`;
      const response = await fetch(`${base}/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!response.ok && operation !== "cancel")
        throw new Error("Browser login is unavailable. Retry or cancel.");
      if (operation === "start") {
        const next = await response.json();
        current.current = next.id;
        setSession(next);
      } else {
        current.current = null;
        setSession(null);
        if (operation === "capture") {
          setMessage("Session saved. No provider test was run.");
          onCaptured();
        }
      }
    } catch {
      setMessage("Browser login is unavailable. Retry or cancel.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-2 border rounded p-3">
      <h3>Secure browser login</h3>
      <p>
        Sign in inside the isolated browser. Capture saves this connection only. Sessions expire
        after 10 minutes.
      </p>
      {!session ? (
        <button type="button" disabled={busy} onClick={() => action("start")}>
          Open login browser
        </button>
      ) : (
        <>
          <iframe
            title="Provider login browser"
            src={`${base}/${session.id}/view`}
            referrerPolicy="same-origin"
            className="w-full h-[500px]"
          />
          <button type="button" disabled={busy} onClick={() => action("capture")}>
            Capture session
          </button>{" "}
          <button type="button" disabled={busy} onClick={() => action("cancel")}>
            Cancel
          </button>
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
