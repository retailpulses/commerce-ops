import test from "node:test";
import assert from "node:assert/strict";
import { createRakutenInquiryClient } from "../src/lib/rakuten-inquiry-relay.mjs";

function mockFetch(payload, status = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls };
}

test("lists inquiries with bounded paging and ESA auth", async () => {
  const mock = mockFetch({ totalCount: 0, list: [] });
  const client = createRakutenInquiryClient({ serviceSecret: "s", licenseKey: "k", fetchImpl: mock.fetchImpl });
  await client.listInquiries({ fromDate: "2026-08-01T00:00:00", toDate: "2026-08-02T00:00:00", limit: 999, page: 2 });
  assert.match(mock.calls[0].url, /limit=100/);
  assert.match(mock.calls[0].url, /page=2/);
  assert.equal(mock.calls[0].options.headers.Authorization, `ESA ${Buffer.from("s:k").toString("base64")}`);
});

test("gets an encoded inquiry and posts a reply contract", async () => {
  const mock = mockFetch({ result: { inquiryNumber: "abc" } });
  const client = createRakutenInquiryClient({ serviceSecret: "s", licenseKey: "k", fetchImpl: mock.fetchImpl });
  await client.getInquiry("a/b");
  assert.match(mock.calls[0].url, /a%2Fb$/);
  await client.reply({ inquiryNumber: "abc", shopId: 440058, message: "確認しました。" });
  assert.equal(mock.calls[1].options.method, "POST");
  assert.deepEqual(JSON.parse(mock.calls[1].options.body), {
    inquiryNumber: "abc", shopId: 440058, message: "確認しました。",
  });
});

test("includes attachments only when explicitly supplied", async () => {
  const mock = mockFetch({ result: { inquiryNumber: "abc" } });
  const client = createRakutenInquiryClient({ serviceSecret: "s", licenseKey: "k", fetchImpl: mock.fetchImpl });
  await client.reply({
    inquiryNumber: "abc",
    shopId: "440058",
    message: "確認しました。",
    attachments: [{ label: "document", path: "/attachment/1" }],
  });
  assert.deepEqual(JSON.parse(mock.calls[0].options.body), {
    inquiryNumber: "abc",
    shopId: 440058,
    message: "確認しました。",
    attachments: [{ label: "document", path: "/attachment/1" }],
  });
});

test("downloads an attachment with required label and path", async () => {
  const calls = [];
  const client = createRakutenInquiryClient({
    serviceSecret: "s", licenseKey: "k",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        headers: { "content-type": "image/jpeg;charset=UTF-8" },
      });
    },
  });
  const result = await client.downloadAttachment({
    label: "damage photo.jpeg", path: "2026/08/27/440058/object",
  });
  assert.match(calls[0].url, /attachment\?label=damage\+photo\.jpeg&path=2026%2F08%2F27%2F440058%2Fobject$/);
  assert.equal(calls[0].options.headers.Accept, "*/*");
  assert.equal(result.contentType, "image/jpeg");
  assert.deepEqual([...result.bytes], [0xff, 0xd8, 0xff, 0xe0]);
});

test("rejects incomplete attachment identity before the API call", async () => {
  const mock = mockFetch({});
  const client = createRakutenInquiryClient({ serviceSecret: "s", licenseKey: "k", fetchImpl: mock.fetchImpl });
  await assert.rejects(() => client.downloadAttachment({ label: "", path: "object" }), /attachment_label_required/);
  await assert.rejects(() => client.downloadAttachment({ label: "photo.jpeg", path: "" }), /attachment_path_required/);
  assert.equal(mock.calls.length, 0);
});

test("rejects empty reply before any platform write", async () => {
  const mock = mockFetch({});
  const client = createRakutenInquiryClient({ serviceSecret: "s", licenseKey: "k", fetchImpl: mock.fetchImpl });
  await assert.rejects(() => client.reply({ inquiryNumber: "abc", shopId: 440058, message: " " }), /reply_message_required/);
  assert.equal(mock.calls.length, 0);
});

test("rejects an invalid shop ID before any platform write", async () => {
  const mock = mockFetch({});
  const client = createRakutenInquiryClient({ serviceSecret: "s", licenseKey: "k", fetchImpl: mock.fetchImpl });
  await assert.rejects(() => client.reply({ inquiryNumber: "abc", shopId: "", message: "確認しました。" }), /shop_id_required/);
  assert.equal(mock.calls.length, 0);
});
