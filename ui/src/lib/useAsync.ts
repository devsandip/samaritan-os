/**
 * The one data-fetching primitive in the app.
 *
 * Deliberately not a cache: a review queue is small, single-user and local, and
 * every mutation changes the list it came from, so refetching on demand is both
 * correct and cheap. What it does own is the loading / error / data triple that
 * UI-SPEC §9 requires every view to render distinctly, and a `stale` flag so a
 * refetch can keep last-known-good content on screen instead of blanking it.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "../api/client";

export interface AsyncState<T> {
  data: T | undefined;
  error: ApiError | undefined;
  loading: boolean;
  /** True while refetching over content that is already on screen. */
  stale: boolean;
  reload: () => void;
  set: (value: T) => void;
}

export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiError | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const hasData = useRef(false);

  // Kept in a ref so an inline arrow passed as `fetcher` does not re-trigger the
  // effect on every render; `deps` is the declared trigger.
  const latest = useRef(fetcher);
  latest.current = fetcher;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    latest
      .current()
      .then((value) => {
        if (cancelled) return;
        hasData.current = true;
        setData(value);
        setError(undefined);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(
          err instanceof ApiError ? err : new ApiError(String(err), 0, "unknown"),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const set = useCallback((value: T) => {
    hasData.current = true;
    setData(value);
  }, []);

  return {
    data,
    error,
    loading,
    stale: loading && hasData.current,
    reload,
    set,
  };
}
