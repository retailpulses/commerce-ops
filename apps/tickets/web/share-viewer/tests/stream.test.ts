import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isPrivateOrLinkLocal,
  validateUpstreamUrl,
  UpstreamError,
} from "../src/utils/stream.js";

describe("isPrivateOrLinkLocal", () => {
  it("detects 10.x.x.x as private", () => {
    assert.strictEqual(isPrivateOrLinkLocal("10.0.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("10.255.255.255"), true);
  });

  it("detects 172.16-31.x.x as private", () => {
    assert.strictEqual(isPrivateOrLinkLocal("172.16.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("172.31.255.255"), true);
  });

  it("detects 192.168.x.x as private", () => {
    assert.strictEqual(isPrivateOrLinkLocal("192.168.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("192.168.255.255"), true);
  });

  it("detects 127.x.x.x as loopback", () => {
    assert.strictEqual(isPrivateOrLinkLocal("127.0.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("127.255.255.255"), true);
  });

  it("detects 169.254.x.x as link-local", () => {
    assert.strictEqual(isPrivateOrLinkLocal("169.254.0.1"), true);
  });

  it("detects carrier NAT, multicast, and IPv4-mapped loopback", () => {
    assert.strictEqual(isPrivateOrLinkLocal("100.64.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("224.0.0.1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("::ffff:127.0.0.1"), true);
  });

  it("detects 0.x.x.x as private", () => {
    assert.strictEqual(isPrivateOrLinkLocal("0.0.0.0"), true);
  });

  it("detects ::1 as loopback", () => {
    assert.strictEqual(isPrivateOrLinkLocal("::1"), true);
  });

  it("detects fc00::/7 as private IPv6", () => {
    assert.strictEqual(isPrivateOrLinkLocal("fc00::1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("fd00::1"), true);
  });

  it("detects fe80::/10 as link-local IPv6", () => {
    assert.strictEqual(isPrivateOrLinkLocal("fe80::1"), true);
    assert.strictEqual(isPrivateOrLinkLocal("feb0::1"), true);
  });

  it("accepts public IPv4", () => {
    assert.strictEqual(isPrivateOrLinkLocal("8.8.8.8"), false);
    assert.strictEqual(isPrivateOrLinkLocal("1.1.1.1"), false);
  });

  it("accepts public IPv6", () => {
    assert.strictEqual(
      isPrivateOrLinkLocal("2001:4860:4860::8888"),
      false,
    );
  });
});

describe("validateUpstreamUrl", () => {
  const hosts = ["storage.example.com", "cdn.example.com"];

  it("accepts HTTPS URL with allowed host", () => {
    const result = validateUpstreamUrl(
      "https://storage.example.com/path/file.jpg",
      hosts,
    );
    assert.strictEqual(result.hostname, "storage.example.com");
  });

  it("rejects HTTP URL", () => {
    assert.throws(
      () =>
        validateUpstreamUrl(
          "http://storage.example.com/path/file.jpg",
          hosts,
        ),
      UpstreamError,
    );
  });

  it("rejects host not in allowlist", () => {
    assert.throws(
      () =>
        validateUpstreamUrl(
          "https://evil.example.com/path",
          hosts,
        ),
      UpstreamError,
    );
  });

  it("rejects invalid URL", () => {
    assert.throws(
      () => validateUpstreamUrl("not-a-url", hosts),
      UpstreamError,
    );
  });

  it("rejects hostname subdomain mismatch", () => {
    assert.throws(
      () =>
        validateUpstreamUrl(
          "https://evil.storage.example.com/path",
          hosts,
        ),
      UpstreamError,
    );
  });

  it("rejects credentials and non-standard ports", () => {
    assert.throws(
      () => validateUpstreamUrl("https://user:pass@storage.example.com/file", hosts),
      UpstreamError,
    );
    assert.throws(
      () => validateUpstreamUrl("https://storage.example.com:8443/file", hosts),
      UpstreamError,
    );
  });
});
