/**
 * Sign-in (PROPOSAL D5).
 *
 * Shown once the daemon has a `web:token` and this browser has no session, which
 * is the phone's first visit over Tailscale and the laptop's after a token is
 * set. The token is posted once; what comes back is an HttpOnly session cookie,
 * so the token itself is never stored in the page.
 */
import { useState, type FormEvent } from "react";
import { api, type ApiError } from "../api/client";
import { Button } from "../components/primitives";

export function LoginView({ onSignedIn }: { onSignedIn: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!token.trim() || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api.login(token.trim());
      setToken("");
      onSignedIn();
    } catch (err) {
      setError((err as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={(e) => void submit(e)}>
        <div className="brand">
          <div className="lg" aria-hidden="true" />
          <b>Samaritan</b>
        </div>
        <p className="h-sub">Sign in with the token stored in this Mac's Keychain as web:token.</p>
        <input
          className="fi"
          type="password"
          autoComplete="current-password"
          placeholder="Token"
          value={token}
          disabled={busy}
          onChange={(e) => setToken(e.target.value)}
          autoFocus
        />
        {error ? <div className="login-error">{error}</div> : null}
        <Button type="submit" variant="good" pending={busy} disabled={busy || !token.trim()}>
          Sign in
        </Button>
      </form>
    </div>
  );
}
