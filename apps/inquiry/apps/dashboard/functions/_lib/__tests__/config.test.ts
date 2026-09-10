import { describe, it, expect } from "vitest";
import { getConfig, STATUS_LABELS, VALID_STATUS_KEYS, SHOP_LABELS, SHOP_KEYS } from "../config";

describe("config", () => {
  describe("getConfig", () => {
    it("returns Supabase config from env vars", () => {
      const env = {
        SUPABASE_URL: "https://test.supabase.co",
        SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
        OPENAI_API_KEY: "sk-test123",
        LLM_MODEL: "gpt-4o",
        CF_ACCESS_TEAM_DOMAIN: "test.cloudflareaccess.com",
        CF_ACCESS_AUD: "test-audience",
      };

      const config = getConfig(env);

      expect(config.supabase.url).toBe("https://test.supabase.co");
      expect(config.supabase.serviceRoleKey).toBe("test-service-key");
      expect(config.openai.apiKey).toBe("sk-test123");
      expect(config.openai.model).toBe("gpt-4o");
      expect(config.auth.teamDomain).toBe("test.cloudflareaccess.com");
      expect(config.auth.audience).toBe("test-audience");
    });

    it("uses defaults when env vars are omitted", () => {
      const config = getConfig({});

      expect(config.supabase.url).toBe("");
      expect(config.supabase.serviceRoleKey).toBe("");
      expect(config.openai.model).toBe("gpt-4o");
      expect(config.productCatalog.table).toBe("product_variants");
      expect(config.productCatalog.schema).toBe("public");
    });

    it("fail-closed: mutations disabled when binding is absent", () => {
      const config = getConfig({});
      expect(config.mutationsEnabled).toBe(false);
    });

    it("mutationsEnabled is true when explicitly set to 'true'", () => {
      const config = getConfig({ INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "true" });
      expect(config.mutationsEnabled).toBe(true);
    });

    it("fail-closed: mutations disabled when binding is 'false'", () => {
      const config = getConfig({ INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "false" });
      expect(config.mutationsEnabled).toBe(false);
    });

    it("fail-closed: mutations disabled with any non-'true' value", () => {
      const config = getConfig({ INQUIRY_DASHBOARD_MUTATIONS_ENABLED: "1" });
      expect(config.mutationsEnabled).toBe(false);
    });
  });

  describe("STATUS_LABELS", () => {
    it("includes all expected statuses", () => {
      expect(STATUS_LABELS).toHaveProperty("received");
      expect(STATUS_LABELS).toHaveProperty("followed_up");
      expect(STATUS_LABELS).toHaveProperty("answered");
      expect(STATUS_LABELS).toHaveProperty("closed_won");
      expect(STATUS_LABELS).toHaveProperty("closed_lose");
    });

    it("VALID_STATUS_KEYS matches STATUS_LABELS keys", () => {
      expect(VALID_STATUS_KEYS.sort()).toEqual(
        Object.keys(STATUS_LABELS).sort(),
      );
    });
  });

  describe("SHOP_LABELS", () => {
    it("includes shop1 through shop4", () => {
      expect(SHOP_LABELS).toHaveProperty("shop1");
      expect(SHOP_LABELS).toHaveProperty("shop2");
      expect(SHOP_LABELS).toHaveProperty("shop3");
      expect(SHOP_LABELS).toHaveProperty("shop4");
    });

    it("SHOP_KEYS matches SHOP_LABELS keys", () => {
      expect(SHOP_KEYS.sort()).toEqual(Object.keys(SHOP_LABELS).sort());
    });
  });
});
