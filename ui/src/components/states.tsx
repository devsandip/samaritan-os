/**
 * The loading / empty / error vocabulary from UI-SPEC §9.
 *
 * Two error tiers, kept as two components so the distinction is structural
 * rather than a convention: `ErrorBanner` is view-level (pinned to the top of
 * main content, last-known-good content stays under it, dimmed) and
 * `ErrorStrip` is component-level (lives inside the one block that failed).
 */
import type { ReactNode } from "react";
import type { ApiError } from "../api/client";
import { Button } from "./primitives";

export function Skeleton({ variant = "line", count = 1 }: { variant?: string; count?: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={`skel ${variant}`} aria-hidden="true" />
      ))}
    </>
  );
}

export function SkeletonRows({ count = 4 }: { count?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      <Skeleton variant="row" count={count} />
    </div>
  );
}

export function SkeletonDetail() {
  return (
    <div aria-busy="true" aria-label="Loading item">
      <Skeleton variant="short" />
      <Skeleton variant="title" />
      <Skeleton variant="line" count={3} />
      <div style={{ height: 14 }} />
      <Skeleton variant="row" count={2} />
    </div>
  );
}

/** Plain language plus a retry. An unreachable daemon says so; it never spins. */
export function ErrorBanner({ error, onRetry }: { error: ApiError; onRetry?: () => void }) {
  const headline = error.unreachable
    ? "Can't reach the Samaritan daemon."
    : "Something went wrong loading this view.";
  return (
    <div className="banner" role="alert">
      <div className="msg">
        <div>{headline}</div>
        <div className="detail-text">
          {error.message.replace(/\.?$/, ".")}
          {error.unreachable ? " Start it with pnpm serve, then retry." : null}
        </div>
      </div>
      {onRetry ? (
        <Button small onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function ErrorStrip({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="strip" role="alert">
      <div className="msg">{message}</div>
      {onRetry ? (
        <Button small onClick={onRetry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  glyph = "✓",
  children,
  left = false,
}: {
  glyph?: string;
  children: ReactNode;
  left?: boolean;
}) {
  return (
    <div className={left ? "empty left" : "empty"}>
      {left ? null : (
        <span className="glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
    </div>
  );
}

export function Toast({ message, variant }: { message: string; variant: "ok" | "err" }) {
  return (
    <div className={variant === "err" ? "toast err" : "toast"} role="status" aria-live="polite">
      {message}
    </div>
  );
}
