export function LoginScreen({ onLogin }: { onLogin: (token: string) => Promise<boolean> }) {
  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const input = form.elements.namedItem("token") as HTMLInputElement;
    const token = input.value.trim();
    if (!token) return;

    const formEl = form;
    const btn = formEl.querySelector("button")!;
    const errorEl = formEl.querySelector<HTMLParagraphElement>("[data-error]")!;

    btn.disabled = true;
    btn.textContent = "Logging in...";
    errorEl.classList.add("hidden");

    const ok = await onLogin(token);
    if (!ok) {
      errorEl.textContent = "Invalid token — please try again";
      errorEl.classList.remove("hidden");
      btn.disabled = false;
      btn.textContent = "Login";
    }
  };

  return (
    <div className="flex items-center justify-center min-h-screen bg-gray-100">
      <div className="bg-white rounded-lg shadow-lg p-10 w-full max-w-md text-center">
        <h1 className="text-2xl font-bold mb-2">📦 Order Mgmt Portal</h1>
        <p className="text-gray-500 mb-5">Enter your access token to continue</p>
        <form onSubmit={handleSubmit}>
          <input
            name="token"
            type="password"
            placeholder="Access Token"
            autoComplete="off"
            className="w-full px-4 py-3 border border-gray-300 rounded-md text-base mb-3 focus:outline-none focus:border-[#1565c0] focus:ring-2 focus:ring-[#1565c0]/20"
          />
          <button
            type="submit"
            className="w-full py-3 bg-[#1565c0] text-white border-none rounded-md text-base cursor-pointer hover:bg-[#0d47a1]"
          >
            Login
          </button>
          <p data-error className="text-[#d32f2f] text-sm mt-2 hidden" />
        </form>
      </div>
    </div>
  );
}
