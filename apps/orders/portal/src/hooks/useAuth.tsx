import { createContext, useContext, useState, useCallback, type ReactNode } from "react";
import { getToken, setToken, clearToken, isCloudflareAccessMode } from "@/lib/auth";
import type { Summary } from "@/types/orders";

interface AuthState {
  token: string;
  isLoggedIn: boolean;
  login: (t: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthState>({
  token: "",
  isLoggedIn: false,
  login: async () => false,
  logout: () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setTokenState] = useState<string>(getToken);

  const login = useCallback(async (t: string): Promise<boolean> => {
    try {
      await apiGet<Summary>("/summary", {}, t);
      setToken(t);
      setTokenState(t);
      return true;
    } catch {
      return false;
    }
  }, []);

  const logout = useCallback(() => {
    if (isCloudflareAccessMode()) {
      window.location.assign("/cdn-cgi/access/logout");
      return;
    }
    clearToken();
    setTokenState("");
  }, []);

  return (
    <AuthContext.Provider value={{ token, isLoggedIn: !!token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}

// Helper: one-shot apiGet that takes an explicit token (used during login)
async function apiGet<T>(path: string, params?: Record<string, string | number | undefined>, explicitToken?: string): Promise<T> {
  const tok = explicitToken || getToken();
  const url = new URL(`/order/api/portal${path}`, window.location.origin);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${tok}` },
  });
  if (!res.ok) throw new Error("unauthorized");
  return res.json();
}
