import type { FormEvent } from 'react';
import { NavLink } from 'react-router-dom';

export interface SessionState {
  checking: boolean;
  authenticated: boolean;
  authRequired: boolean;
  error: string | null;
}

interface OpsAuthViewProps {
  session: SessionState;
  loginToken: string;
  loginSubmitting: boolean;
  loginError: string | null;
  onLoginTokenChange: (value: string) => void;
  onLoginSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onRetry: () => void;
}

export function OpsAuthView(props: OpsAuthViewProps) {
  if (props.session.checking) {
    return (
      <div className="app app--ops">
        <main className="ops-auth">
          <section className="ops-auth__card">
            <p className="hero__eyebrow">Ops Session</p>
            <h1>Checking operator session…</h1>
            <p className="hero__lead">Verifying runtime auth state before loading live feeds.</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="app app--ops">
      <main className="ops-auth">
        <section className="ops-auth__card">
          <p className="hero__eyebrow">Authenticated Surface</p>
          <h1>Operator sign in</h1>
          <p className="hero__lead">
            Enter your ops token to start a runtime session. The token is never embedded in the
            dashboard bundle.
          </p>
          {props.session.error ? <p className="ops-auth__error">{props.session.error}</p> : null}
          {props.session.authRequired ? (
            <form className="ops-auth__form" onSubmit={props.onLoginSubmit}>
              <label htmlFor="ops-token">Ops token</label>
              <input
                id="ops-token"
                name="ops-token"
                type="password"
                autoComplete="off"
                value={props.loginToken}
                onChange={(event) => props.onLoginTokenChange(event.target.value)}
                required
              />
              <button
                type="submit"
                disabled={props.loginSubmitting || props.loginToken.trim().length === 0}
              >
                {props.loginSubmitting ? 'Signing in…' : 'Next'}
              </button>
              {props.loginError ? <p className="ops-auth__error">{props.loginError}</p> : null}
            </form>
          ) : (
            <button type="button" onClick={props.onRetry}>
              Retry
            </button>
          )}
          <p className="ops-auth__links">
            <NavLink to="/">Back to landing</NavLink>
          </p>
        </section>
      </main>
    </div>
  );
}
