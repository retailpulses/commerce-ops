import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  type ReactNode,
} from "react";

const SESSION_KEY = "hb_ticketing_token";
const OPS_ACCESS_TOKEN = "cloudflare-access";

function isOpsAccessMode(): boolean {
  return window.location.hostname === "ops.homesbliss.net" &&
    (window.location.pathname === "/tickets" || window.location.pathname.startsWith("/tickets/"));
}

interface AuthState {
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (password: string) => Promise<boolean>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const opsAccessMode = isOpsAccessMode();
  const [token, setToken] = useState<string | null>(() =>
    opsAccessMode ? OPS_ACCESS_TOKEN : sessionStorage.getItem(SESSION_KEY),
  );
  const [isLoading, setIsLoading] = useState(true);

  // Validate token on mount
  useEffect(() => {
    if (opsAccessMode) {
      setToken(OPS_ACCESS_TOKEN);
      setIsLoading(false);
      return;
    }
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      // Note: /tickets/api/health is public and doesn't validate the token,
      // but the first authenticated API call that fails with 401 will
      // dispatch auth:logout and clear the session.
      fetch("/tickets/api/health", { headers: { Authorization: `Bearer ${stored}` } })
        .then((r) => {
          if (!r.ok) throw new Error("invalid");
          setToken(stored);
        })
        .catch(() => {
          sessionStorage.removeItem(SESSION_KEY);
          setToken(null);
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, [opsAccessMode]);

  // Listen for auth:logout events dispatched by the API client on 401
  useEffect(() => {
    const handleLogout = () => {
      if (opsAccessMode) {
        window.location.assign("/cdn-cgi/access/logout");
        return;
      }
      sessionStorage.removeItem(SESSION_KEY);
      setToken(null);
    };
    window.addEventListener("auth:logout", handleLogout);
    return () => window.removeEventListener("auth:logout", handleLogout);
  }, [opsAccessMode]);

  const login = useCallback(async (password: string): Promise<boolean> => {
    const r = await fetch("/tickets/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });
    if (!r.ok) return false;
    const d = await r.json();
    if (!d.token) return false;
    sessionStorage.setItem(SESSION_KEY, d.token);
    setToken(d.token);
    return true;
  }, []);

  const logout = useCallback(() => {
    if (opsAccessMode) {
      window.location.assign("/cdn-cgi/access/logout");
      return;
    }
    sessionStorage.removeItem(SESSION_KEY);
    setToken(null);
  }, [opsAccessMode]);

  return (
    <AuthContext.Provider
      value={{
        token,
        isAuthenticated: !!token,
        isLoading,
        login,
        logout,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
