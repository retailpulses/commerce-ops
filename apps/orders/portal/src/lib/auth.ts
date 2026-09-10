const TOKEN_KEY = "portal_token";
const CLOUDFLARE_ACCESS_TOKEN = "cloudflare-access";

export function isCloudflareAccessUrl(location: Pick<Location, "hostname" | "pathname">): boolean {
  return (
    location.hostname === "ops.homesbliss.net" &&
    (location.pathname === "/order" || location.pathname.startsWith("/order/"))
  );
}

export function isCloudflareAccessMode(): boolean {
  return typeof window !== "undefined" && isCloudflareAccessUrl(window.location);
}

export function getToken(): string {
  if (isCloudflareAccessMode()) return CLOUDFLARE_ACCESS_TOKEN;
  if (typeof sessionStorage !== "undefined") {
    return sessionStorage.getItem(TOKEN_KEY) || "";
  }
  return "";
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  if (isCloudflareAccessMode()) return;
  sessionStorage.removeItem(TOKEN_KEY);
}

export function isAuthenticated(): boolean {
  return !!getToken();
}
