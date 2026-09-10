import assert from "node:assert/strict";
import test from "node:test";
import { mergeMessages } from "../../frontend/src/components/tickets/detail/messageTimeline";
import { mergeThreadMessages } from "../src/services/threadService";

test("sorts transaction messages with the most recent first", () => {
  const messages = mergeMessages(
    [
      {
        id: "older",
        role: "BUYER",
        body: "Older",
        sentAt: "2026-07-28T10:00:00.000Z",
        source: "platform",
      },
      {
        id: "newer",
        role: "SELLER",
        body: "Newer",
        sentAt: "2026-07-29T10:00:00.000Z",
        source: "platform",
      },
    ],
    [],
  );

  assert.deepEqual(
    messages.map((message) => message.id),
    ["newer", "older"],
  );
  assert.equal(messages[0].isOperator, true);
});

test("does not show a seller message twice when IDs differ across sources", () => {
  const messages = mergeMessages(
    [
      {
        id: "mercari-message-id",
        role: "SELLER",
        body: "Your order has shipped.",
        sentAt: "2026-07-29T10:00:00.000Z",
        source: "platform",
      },
    ],
    [
      {
        id: "ticket-message-row-id",
        ticket_id: "ticket-id",
        sender_type: "seller",
        sender_display_name: null,
        body: "Your order has shipped.",
        external_message_id: "mercari-message-id",
        sent_at: "2026-07-29T10:00:00.000Z",
      },
    ],
  );

  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, "mercari-message-id");
  assert.equal(messages[0].role, "seller");
});

test("tags matched operator and automated sends without duplicating them", () => {
  const thread = [
    {
      id: "manual-platform-id",
      role: "SELLER",
      body: "Manual reply",
      sentAt: "2026-07-29T11:00:00.000Z",
      source: "platform" as const,
    },
    {
      id: "system-platform-id",
      role: "SELLER",
      body: "Automated reply",
      sentAt: "2026-07-29T10:00:00.000Z",
      source: "platform" as const,
    },
    {
      id: "external-seller-id",
      role: "SELLER",
      body: "Sent outside the portal",
      sentAt: "2026-07-29T09:00:00.000Z",
      source: "platform" as const,
    },
  ];
  const stored = [
    {
      id: "manual-row-id",
      ticket_id: "ticket-id",
      sender_type: "operator",
      sender_display_name: "Jim",
      body: "Manual reply",
      external_message_id: "manual-platform-id",
      sent_at: "2026-07-29T11:00:00.000Z",
    },
    {
      id: "system-row-id",
      ticket_id: "ticket-id",
      sender_type: "automation",
      sender_display_name: null,
      body: "Automated reply",
      external_message_id: "system-platform-id",
      sent_at: "2026-07-29T10:00:00.000Z",
    },
  ];

  const messages = mergeMessages(thread, stored);

  assert.equal(messages.length, 3);
  assert.deepEqual(
    messages.map(({ id, role, sendMethod, isOperator }) => ({
      id,
      role,
      sendMethod,
      isOperator,
    })),
    [
      {
        id: "manual-platform-id",
        role: "operator",
        sendMethod: "manual",
        isOperator: true,
      },
      {
        id: "system-platform-id",
        role: "automation",
        sendMethod: "system",
        isOperator: true,
      },
      {
        id: "external-seller-id",
        role: "SELLER",
        sendMethod: undefined,
        isOperator: true,
      },
    ],
  );
  assert.equal(messages[0].displayName, "Jim");
});

test("the Worker thread preserves stored sender metadata on Mercari copies", () => {
  const messages = mergeThreadMessages(
    [
      {
        id: "manual-platform-id",
        role: "SELLER",
        body: "Manual reply",
        sentAt: "2026-07-29T11:00:00.000Z",
      },
      {
        id: "system-platform-id",
        role: "SELLER",
        body: "Automated reply",
        sentAt: "2026-07-29T10:00:00.000Z",
      },
    ],
    [
      {
        id: "manual-row-id",
        ticket_id: "ticket-id",
        platform: "mercari",
        external_message_id: "manual-platform-id",
        sender_type: "operator",
        sender_display_name: "Jim",
        body: "Manual reply",
        sent_at: "2026-07-29T11:00:00.000Z",
        raw_payload: {},
        created_at: "2026-07-29T11:00:00.000Z",
      },
      {
        id: "system-row-id",
        ticket_id: "ticket-id",
        platform: "mercari",
        external_message_id: "system-platform-id",
        sender_type: "system",
        sender_display_name: null,
        body: "Automated reply",
        sent_at: "2026-07-29T10:00:00.000Z",
        raw_payload: {},
        created_at: "2026-07-29T10:00:00.000Z",
      },
    ],
  );

  assert.deepEqual(
    messages.map(({ id, role, displayName }) => ({ id, role, displayName })),
    [
      { id: "manual-platform-id", role: "operator", displayName: "Jim" },
      {
        id: "system-platform-id",
        role: "system",
        displayName: undefined,
      },
    ],
  );
});
