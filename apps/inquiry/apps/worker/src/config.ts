import type { Env } from "./env";
import type { SupabaseConfig } from "./adapters/supabase";

function parseStringMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) out[k] = v.trim();
      }
      return out;
    }
    return {};
  } catch {
    return {}; // fail closed: unparseable secrets => no shop is trusted
  }
}

export function getConfig(env: Env) {
  return {
    supabase: {
      url: env.SUPABASE_URL,
      restUrl: env.SUPABASE_REST_URL,
      serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
    } satisfies SupabaseConfig,

    openai: {
      apiKey: env.OPENAI_API_KEY,
    },
    deepseek: {
      apiKey: env.DEEPSEEK_API_KEY,
    },
    cache: {
      shopCacheTtl: parseInt(env.SHOP_CACHE_TTL_SECONDS, 10),
    },
    cursor: {
      defaultCursor: env.MASTER_HANDLER_DEFAULT_CURSOR,
    },
    wecom: {
      webhookUrl: env.WECOM_WEBHOOK_URL,
    },
    runtime: {
      dryRun: env.DRY_RUN !== "false",
      forceRegenerate: env.FORCE_REGENERATE === "true",
      adminToken: env.ADMIN_TOKEN,
      maxRowsPerRun: parseInt(env.MAX_ROWS_PER_RUN ?? "20", 10),
      llmMaxCallsPerRun: parseInt(env.LLM_MAX_CALLS_PER_RUN ?? "10", 10),
      /** Fail closed when unset or misspelled. */
      writesEnabled: env.INQUIRY_AUTOMATION_WRITES_ENABLED === "true",
      externalNotificationsEnabled:
        env.INQUIRY_EXTERNAL_NOTIFICATIONS_ENABLED === "true",
    },
    mercari: {
      relayUrl: env.MERCARI_RELAY_URL,
      shopTokens: {
        shop1: env.SHOP1_API_TOKEN,
        shop2: env.SHOP2_API_TOKEN,
        shop3: env.SHOP3_API_TOKEN,
        shop4: env.SHOP4_API_TOKEN,
      },
      webhookSecrets: parseStringMap(env.MERCARI_WEBHOOK_SECRETS),
      webhookSharedSecret: env.MERCARI_WEBHOOK_SHARED_SECRET,
      shopIdMap: parseStringMap(env.MERCARI_SHOP_ID_MAP),
      shopKeyHeader: env.MERCARI_WEBHOOK_SHOP_KEY_HEADER ?? "X-Mercari-Shop-Key",
      signatureHeader:
        env.MERCARI_WEBHOOK_SIGNATURE_HEADER ?? "X-Mercari-Signature",
      replayWindowSeconds: parseInt(
        env.MERCARI_WEBHOOK_REPLAY_WINDOW_SECONDS ?? "300",
        10,
      ),
      /** Canonical ingest write kill switch. */
      ingestWritesEnabled: env.INQUIRY_MERCARI_INGEST_WRITES_ENABLED === "true",
      /** Daily-audit repair write kill switch. */
      auditWritesEnabled:
        env.INQUIRY_COMPLETENESS_AUDIT_WRITES_ENABLED === "true",
      /** Outbound send kill switch (worker side; operator Send is dashboard-side). */
      outboundSendEnabled: env.INQUIRY_OUTBOUND_SEND_ENABLED === "true",
    },
  };
}

export type Config = ReturnType<typeof getConfig>;

// =========================================================================
// Inquiry type maps
// =========================================================================

/**
 * Maps inquiry type display names to Supabase `inquiry_types.key` values
 * (TEXT, snake_case). Used throughout for classification and template
 * selection in the Supabase-backed pipeline.
 */
export const INQUIRY_TYPE_KEYS: Record<string, string> = {
  "Okinawa inquiry": "okinawa_inquiry",
  "Bulk purchase": "bulk_purchase",
  "Price negotiation": "price_negotiation",
  "Scheduled delivery": "scheduled_delivery",
  "Product availability": "product_availability",
  "Shipping related": "shipping_related",
  "Assembly": "assembly",
  "Product Spec": "product_spec",
  "Find a product": "find_a_product",
  "Others": "others",
};

/**
 * Reverse mapping: Supabase `inquiry_types.key` → display label.
 * Used by templates.ts to branch on type name.
 */
export const INQUIRY_TYPE_BY_KEY: Record<string, string> = Object.fromEntries(
  Object.entries(INQUIRY_TYPE_KEYS).map(([k, v]) => [v, k]),
);

// =========================================================================
// Canonical inquiry workflow status keys
// =========================================================================

export const STATUS_RECEIVED = "received";
export const STATUS_FOLLOWED_UP = "followed_up";
export const STATUS_ANSWERED = "answered";
export const STATUS_CLOSED_WON = "closed_won";
export const STATUS_CLOSED_LOSE = "closed_lose";

/** Maps Supabase shop_key to Mercari Shop slug for indexing. */
export const SHOP_SLUG_MAP: Record<string, string> = {
  shop1: "WMyisFmhbGWyVAPEwsfirn",
  shop2: "ZaMyGWzp6hUdgDh5E9ADob",
  shop3: "2JGrmZqojnBMfdWrtP2xk3",
  shop4: "2JMLHBxjiFHDr55jMwA7fs",
};

// =========================================================================
// Classification keyword rules (unchanged)
// =========================================================================

export const CLASSIFICATION_KEYWORDS: Record<string, RegExp[]> = {
  "Okinawa inquiry": [/沖縄/, /離島/, /名護/, /石垣/],
  "Bulk purchase": [
    /[0-9０-９]+[個脚台点枚箱つ]/,
    /まとめ/,
    /クーポン/,
    /割引/,
    /セット/,
    /即決/,
    /お値下/,
    /一括/,
    /ロット/,
    /卸/,
    /大量/,
    /複数/,
    /まとめ買い/,
  ],
  "Price negotiation": [/値下げ/, /値引き/, /安く/, /専用/],
  "Scheduled delivery": [/日時指定/, /届けて/, /時間帯/],
  "Product availability": [/在庫/, /入荷/, /売り切れ/],
  "Shipping related": [/送料/, /発送/, /配送/],
  "Assembly": [/組み立て/, /工具/, /完成品/, /アンカー/, /固定/, /設置/, /ボルト/, /説明书/, /部品/],
  "Product Spec": [/サイズ/, /幅/, /高さ/, /奥行/, /素材/, /重さ/, /重量/, /kg/, /グラム/, /耐荷重/],
  "Find a product": [
    /色違い/,
    /カラーのみ/,
    /〜はありますか/,
    /ないでしょうか/,
    /のみでしょうか/,
    /他色/,
    /色展開/,
    /バリエーション/,
    /白はありません/,
    /黒はありません/,
    /白はない/,
    /黒はない/,
    /色/,
    /カラー/,
  ],
};

export const MARKETING_WORDS = [
  "大人気商品", "新品", "全新品", "大人気", "再入荷予定",
  "再入荷", "おしゃれ", "新作", "数量限定セール", "大人気！",
  "数量限定", "SALE", "セール", "限定", "囲い付きで便利",
  "ハイタイプ", "カバーなし", "新生活", "送料無料", "即購入OK",
];

export const STOPWORDS = new Set([
  "ナチュラル", "北欧", "モダン", "ホワイト", "ブラック", "グレー", "ブラウン",
  "の", "付き", "用", "型", "式", "and", "with", "全", "a", "an", "the",
  "新入荷", "即納", "一年保証",
]);

export const COMMON_OBJECTS = new Set([
  "ダイニングチェア", "椅子", "チェア", "イス", "テーブル", "ソファー", "ベッド",
  "センターテーブル", "ローテーブル", "ダイニングテーブル",
]);

export const COLOR_KEYWORDS = [
  "ブラック", "ホワイト", "ナチュラル", "オーク", "ウォールナット",
  "ブラウン", "ダークブラウン", "ライトブラウン", "グレー", "ベージュ",
  "ネイビー", "グリーン", "レッド", "イエロー", "ピンク",
];

// =========================================================================
// Reply templates (unchanged)
// =========================================================================

export const TEMPLATES: Record<string, { name: string; body: string }> = {
  Stock_Out_A: {
    name: "Stock Out (Date Available)",
    body: "お問い合わせありがとうございます。\n\nご確認の商品ですが、誠に申し訳ございませんが、現在 sold out となっており、すぐにご用意することができません。\n\n次回入荷予定は **{restock_date}** を予定しております。\n\n入荷次第改めてご連絡させていただきます。ご希望の際は、別のサイズやカラーで在庫がある商品をご案内することも可能です。\n\nホムブリスカスタマーサポート",
  },
  Stock_Out_B: {
    name: "Stock Out (Date Unconfirmed)",
    body: "お問い合わせありがとうございます。\n\nご確認の商品ですが、誠に申し訳ございませんが、現在 sold out となっており、次回入荷時期は未定となっております。\n\n長らくお待ちいただくことになるため、もしお急ぎの場合は大変恐縮ですが、他の商品をご検討いただけますと幸いです。\n\nホムブリスカスタマーサポート",
  },
  Bulk_Purchase: {
    name: "Bulk Purchase (Coupon)",
    body: "お問い合わせありがとうございます。まとめ買いご購入をご検討いただき、誠にありがとうございます。\n\nおまとめ買い特典として、**{discount_rate}% OFF** のクーポンをお客様専用にご用意させていただきました。\n\n有効期限は **{today}** より **{tomorrow}** までの間、ご利用いただけます。\n\nなお、メルカリシステムの仕様上、お手数ですが数量分 **個別（1点ずつ）** ご購入をお願いいたします。\n配送料は運送会社へのお支払いとなりますため、ご購入点数分の送料が加算されることをあらかじめご了承ください。\n\n各ご注文にてクーポンをご利用いただけます。\n\nご利用方法やその他ご不明な点がございましたら、お気軽にお知らせください。\n\nホムブリスカスタマーサポート",
  },
  Shipping_Standard: {
    name: "Shipping (Standard)",
    body: "お問い合わせいただき、誠にありがとうございます。\n\n配送料につきましてご案内申し上げます。\nお客様のお住まいの地域への配送につきましては、**追加送料は発生いたしません**ので、**どうぞご安心ください**。\n\n配送料はご購入時のお支払いに含まれております。お届け時の着払いや、別途追加でのご請求などは一切ございませんので、そのままの金額でご注文いただけます。\n\nぜひ、**何卒ご安心の上**、ご検討いただけますと幸いです。\n\nホムブリスカスタマーサポート",
  },
  Shipping_Additional: {
    name: "Shipping (Additional Fee)",
    body: "お問い合わせありがとうございます。\n\n配送先の地域につきまして、本商品は大型商品のため、別途 **{additional_fee}** 円の追加送料を頂戴しております。\n\n配送料はご購入時に支払いが完了しておりますので、着払いや追加のお支払いの心配はございません。\n\nご購入をご希望の場合は、価格を調整した専用ページを作成いたしますので、お手数ですが再度ご連絡いただけますでしょうか。\n\nホムブリスカスタマーサポート",
  },
  Product_Spec: {
    name: "Product Spec",
    body: "お問い合わせありがとうございます。\n\n該当商品につきまして、サイズ画像をご用意しております。詳細につきましては、商品ページ内のサイズ画像をご確認いただけますでしょうか。\n\n設置スペースの参考にしてくだされば幸いです。その他ご不明な点がございましたら、お気軽にお問い合わせください。\n\nホムブリスカスタマーサポート",
  },
  Scheduled_Delivery: {
    name: "Scheduled Delivery",
    body: "お問い合わせありがとうございます。\n\nご注文いただいてから、通常 1-2 営業日以内 の発送となっております。\n\nお急ぎの場合はお気軽にご相談ください。できる限り調整させていただきます。\n\nホムブリスカスタマーサポート",
  },
  No_Product_Info: {
    name: "No Product Info (Re-ask from Product Page)",
    body: "お問い合わせありがとうございます。\n\nお問い合わせ内容を確認いたしました。大変申し訳ございませんが、お客様の商品ページ外からメッセージが送信されておりますため、どの商品についてのご相談か判断できない状態となっております。\n\nより正確にご対応させていただくため、お手数ですがご希望の商品ページより再度お問い合わせくださいませ。\n\nホムブリスカスタマーサポート",
  },
  Acknowledgement: {
    name: "Acknowledgement (Checking — will follow up)",
    body: "お問い合わせありがとうございます。\n\nお問い合わせ内容を確認いたしました。現在、担当者にて確認を行っておりますので、確認が取れ次第、追ってご連絡させていただきます。\n\n今しばらくお待ちいただけますと幸いです。何卒よろしくお願いいたします。\n\nホムブリスカスタマーサポート",
  },
  Assembly_Status_Confirmed: {
    name: "Assembly Status (Confirmed)",
    body: "この度はホムブリスをご利用いただき、誠にありがとうございます。\n\nお問い合わせいただき、ありがとうございます。\n\nこちらの商品につきまして、確認できている組み立て情報は「{assembly_status}」です。\n\nご不明な点がございましたら、お気軽にお問い合わせください。\n\nホムブリスカスタマーサポートより",
  },
  Assembly_Fallback: {
    name: "Assembly (Needs Product Verification)",
    body: "この度はホムブリスをご利用いただき、誠にありがとうございます。\n\nお問い合わせいただき、ありがとうございます。\n\nこちらの商品につきましては、商品サイズ・配送形態・安全な梱包の都合により、組み立てが必要となる場合がございます。組み立て式とすることで、送料や商品価格をできる限り抑えながら、安全にお届けできるよう調整しております。\n\n商品には、組み立て説明書および必要な付属部品・工具が同梱されている場合がございます。なお、電動工具をお持ちの場合は、より効率的に組み立ていただけることがあります。\n\nまた、組み立てに関してサポートが必要な場合は、ジモティーやくらしのマーケットなどのスキルシェアリングサービスをご利用いただく方法もございます。\n\n念のため、今回お問い合わせいただいた商品について、組み立ての有無・付属品・説明書の内容を改めて確認し、確認でき次第、再度ご案内いたします。\n\n何卒よろしくお願い申し上げます。\n\nホムブリスカスタマーサポートより",
  },
};
