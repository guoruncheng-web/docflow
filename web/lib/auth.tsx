"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError, AuthResponse, AuthUser, api, tokenStore } from "./api";

type AuthState = {
  user: AuthUser | null;
  status: "loading" | "authenticated" | "anonymous";
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { name: string; organizationName: string; email: string; password: string }) => Promise<void>;
  startDemo: () => Promise<void>;
  signOut: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [status, setStatus] = useState<AuthState["status"]>("loading");

  // A stored token can be expired or signed with a rotated secret, so it is
  // verified against the API before the dashboard is allowed to render.
  useEffect(() => {
    if (!tokenStore.read()) {
      setStatus("anonymous");
      return;
    }

    let cancelled = false;

    const verify = async () => {
      try {
        const me = await api<AuthUser>("/auth/me");
        if (!cancelled) {
          setUser(me);
          setStatus("authenticated");
        }
        return;
      } catch (error) {
        if (cancelled) return;

        // Only a 401 means the session is actually gone. A cold start, a
        // dropped connection or a 500 says nothing about the token, and
        // discarding it there costs a demo visitor the workspace they were
        // working in — for a blip that a second request usually survives.
        if (isUnauthorized(error)) {
          tokenStore.clear();
          setStatus("anonymous");
          return;
        }
      }

      try {
        const me = await api<AuthUser>("/auth/me");
        if (!cancelled) {
          setUser(me);
          setStatus("authenticated");
        }
      } catch (error) {
        if (cancelled) return;
        // Still unverifiable: the token stays, so a reload can try again.
        if (isUnauthorized(error)) tokenStore.clear();
        setStatus("anonymous");
      }
    };

    void verify();

    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Everything cached belongs to the workspace that was signed in, and the query
   * keys — `["documents"]`, `["record", id]` — do not say which one that was. Left
   * in place, the next session mounts against the previous session's data and
   * renders it until the refetch lands: a fresh demo workspace showing the last
   * visitor's documents, which is precisely the opposite of what a
   * per-visitor sandbox is meant to demonstrate.
   *
   * So the cache is emptied whenever the identity changes, in both directions.
   */
  const forgetCachedWorkspace = useCallback(() => queryClient.clear(), [queryClient]);

  const accept = useCallback(
    (response: AuthResponse) => {
      forgetCachedWorkspace();
      tokenStore.write(response.accessToken);
      setUser(response.user);
      setStatus("authenticated");
    },
    [forgetCachedWorkspace],
  );

  const signIn = useCallback<AuthState["signIn"]>(
    async (email, password) => {
      accept(await api<AuthResponse>("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }));
    },
    [accept],
  );

  const signUp = useCallback<AuthState["signUp"]>(
    async (input) => {
      accept(await api<AuthResponse>("/auth/register", { method: "POST", body: JSON.stringify(input) }));
    },
    [accept],
  );

  /** Mints a throwaway workspace on the server and signs into it. */
  const startDemo = useCallback<AuthState["startDemo"]>(async () => {
    accept(await api<AuthResponse>("/demo/session", { method: "POST" }));
  }, [accept]);

  const signOut = useCallback(() => {
    forgetCachedWorkspace();
    tokenStore.clear();
    setUser(null);
    setStatus("anonymous");
    router.replace("/login");
  }, [forgetCachedWorkspace, router]);

  const value = useMemo<AuthState>(
    () => ({ user, status, signIn, signUp, startDemo, signOut }),
    [user, status, signIn, signUp, startDemo, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }

  return context;
}

/** True when a rejected request means the session is gone rather than the input being bad. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}
