import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { PageHeader } from "../components/ui/PageHeader";
import { ListPane } from "../components/tickets/ListPane";
import { DetailPane } from "../components/tickets/detail/DetailPane";

export default function WorkspacePage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isAuthenticated, isLoading, logout } = useAuth();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full bg-bg">
        <div className="text-text-muted text-sm">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginGate />;
  }

  const handleLogout = () => {
    logout();
    navigate("/");
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader onLogout={handleLogout} />

      {/* Workspace: two-pane grid */}
      <div className="flex-1 grid grid-cols-[clamp(320px,32vw,440px)_minmax(0,1fr)] max-[899px]:grid-cols-1 min-h-0">
        {/* Left pane — hide on mobile when detail is open */}
        <aside className="flex flex-col bg-white border-r border-border min-h-0 overflow-hidden max-[899px]:hidden min-[900px]:flex">
          <ListPane
            selectedTicketId={id ?? null}
            onTicketSelect={(tid) => navigate(`/${tid}`)}
          />
        </aside>

        {/* Mobile: show list when no ticket selected */}
        {!id && (
          <aside className="hidden max-[899px]:flex flex-col bg-white min-h-0 overflow-hidden">
            <ListPane
              selectedTicketId={null}
              onTicketSelect={(tid) => navigate(`/${tid}`)}
            />
          </aside>
        )}

        {/* Right pane — ticket detail workspace */}
        <main className="flex flex-col min-h-0 overflow-hidden bg-white">
          <DetailPane ticketId={id ?? null} onBack={() => navigate("/")} />
        </main>
      </div>
    </div>
  );
}

/** Password gate — inline for simplicity */
export function LoginGate() {
  const { login } = useAuth();
  const [password, setPassword] = useState("");
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const handleLogin = async () => {
    if (!password) return;
    setSubmitting(true);
    setError(false);
    const ok = await login(password);
    if (!ok) {
      setError(true);
      setPassword("");
    }
    setSubmitting(false);
  };

  return (
    <div className="flex items-center justify-center h-full bg-gradient-to-br from-[#1a1a2e] via-[#16213e] to-accent">
      <div className="bg-white rounded-2xl p-12 w-[360px] text-center shadow-2xl">
        <h1 className="text-2xl mb-1">🏠 Homebliss</h1>
        <p className="text-text-muted text-sm mb-6">Ticket Workspace</p>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleLogin()}
          placeholder="Password"
          autoComplete="new-password"
          autoFocus
          className="w-full px-3 py-3 border border-border rounded-lg text-sm mb-3 outline-none focus:border-accent"
        />
        <button
          onClick={handleLogin}
          disabled={submitting}
          className="w-full py-3 bg-accent text-white rounded-lg text-sm font-semibold cursor-pointer hover:bg-accent-light disabled:opacity-50"
        >
          {submitting ? "..." : "Login"}
        </button>
        {error && (
          <p className="text-danger text-xs mt-3">Invalid password</p>
        )}
      </div>
    </div>
  );
}
