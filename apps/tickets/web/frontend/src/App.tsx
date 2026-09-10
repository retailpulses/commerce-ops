import { ToastProvider } from "./components/ui/Toast";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "./hooks/useAuth";
import WorkspacePage from "./pages/WorkspacePage";
import CreateTicketPage from "./pages/CreateTicketPage";
import MessageQueuePage from "./pages/MessageQueuePage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export default function App() {
  // Issue #60: the portal is natively owned at /tickets, so the router strips
  // that prefix and every route below is relative to it.
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter basename="/tickets">
            <Routes>
              <Route path="/" element={<WorkspacePage />} />
              <Route path="/new" element={<CreateTicketPage />} />
              <Route path="/queue" element={<MessageQueuePage />} />
              <Route path="/:id" element={<WorkspacePage />} />
            </Routes>
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
