/** Reply templates — direct port from logic/templates.py. */

import { TICKETFORM_MESSAGE_VALIDITY_NOTICE } from "./ticketform-validity";

export const FORM_RECEIVED_ACK =
  "お問い合わせフォームよりご連絡いただき、ありがとうございます。\n" +
  "お客様よりお送りいただきました詳細内容を確かに受領いたしました。\n\n" +
  "内容を確認のうえ、最適な解決策をご検討しております。\n" +
  "カスタマーサポートの営業時間は【平日10:00～18:00】となっております。\n" +
  "確認結果につきましては、1〜2営業日以内にご連絡いたしますので、今しばらくお待ちくださいませ。\n\n" +
  "ホムブリスカスタマーサポート";

export const HOLDING_ACK =
  "ご連絡ありがとうございます。内容を確認のうえ対応しております。\n" +
  "カスタマーサポートの営業時間は【平日10:00～18:00】となっております。\n" +
  "順次ご返信いたしますので、今しばらくお待ちください。";

export const FUGUAI_LITE_TEMPLATE =
  "お世話になっております。ホムブリスカスタマーサポートでございます。\n\n" +
  "この度はご連絡いただきありがとうございます。状況を正確に確認のうえ、最適な対応をご案内するため、" +
  "恐れ入りますが下記フォームよりお写真等のご提供をお願いいたします。\n\n" +
  "▼お問い合わせフォーム\n" +
  "{{AFTERSALES_FORM_URL}}\n\n" +
  TICKETFORM_MESSAGE_VALIDITY_NOTICE + "\n\n" +
  "【お願いしたい内容】\n" +
  "・不具合/破損/不足などが分かるお写真（1枚以上）\n" +
  "・商品ラベルや外箱ラベルなど、SKUが確認できるお写真（1枚以上）\n\n" +
  "ご不便をおかけし誠に申し訳ございません。確認でき次第、速やかにご案内いたします。\n\n" +
  "ホムブリスカスタマーサポート";

export const FOLLOWUP_FORM_HELPER =
  "お世話になっております。ホムブリスカスタマーサポートでございます。\n\n" +
  "ご返信いただきありがとうございます。現在、お客様よりの詳細情報（お写真等）のご提出をお待ちしている状況でございます。\n\n" +
  "まだご提出いただいていない場合は、恐れ入りますが下記フォームよりご提供をお願いいたします。\n\n" +
  "▼お問い合わせフォーム\n" +
  "{{AFTERSALES_FORM_URL}}\n\n" +
  TICKETFORM_MESSAGE_VALIDITY_NOTICE + "\n\n" +
  "【お願いしたい内容】\n" +
  "・不具合/破損/不足などが分かるお写真（1枚以上）\n" +
  "・商品ラベルや外箱ラベルなど、SKUが確認できるお写真（1枚以上）\n\n" +
  "ご不明な点がございましたら、改めてご連絡ください。\n\n" +
  "ホムブリスカスタマーサポート";

export const GREETING_CLOSE_ACK = "ご連絡ありがとうございます。こちらこそ、引き続きよろしくお願いいたします。";

export const INFO_CLOSE_ACK = "ご連絡ありがとうございます。内容承知いたしました。引き続きよろしくお願いいたします。";

export const FUGUAI_TEMPLATE = `お客様へ
ご連絡ありがとうございます。お届けした商品に不備があるとのこと、承知いたしました。
ご不便をおかけしており、誠に恐縮でございます。

弊社では製品サポートを確実に提供し、状況に応じた最適な解決策を判断するため、社内規定に基づき、まず詳細の確認をさせていただいております。
恐れ入りますが、下記の「お問い合わせフォーム」より、状況が確認できるお写真等のご提供をお願いいたします。

▼お問い合わせフォーム
{{AFTERSALES_FORM_URL}}

${TICKETFORM_MESSAGE_VALIDITY_NOTICE}

あわせて、以下の情報を含むお写真または動画のご提供をお願いしております：
・不備がある箇所が明確に分かる画像（1枚以上）
・商品ラベルまたは外箱など、SKU情報が確認できる画像（1枚以上）

お手数をおかけし大変恐縮ではございますが、情報をいただき次第、社内にて精査のうえ、改めて対応策（部品の再発送や交換等）をご案内させていただきます。
何卒ご理解とご協力のほどお願い申し上げます。

ホムブリスカスタマーサポート`;

export function waitingCancelFeeTemplate(shop: string, feeLink: string): string {
  return `お客様へ

ご連絡ありがとうございます。
ご注文のキャンセルをご希望とのこと、承知いたしました。

本商品のキャンセルにつきましてご案内申し上げます。
現在、お客様のご注文は既に「発送待ち」の状態となっており、発送に向けたシステム上の処理および物流拠点での手配が完了しております。

そのため、恐れ入りますが規定に基づき、事務手数料および物流キャンセル料として【600円】を申し受けております。

つきましては、下記の手数料支払い用リンクより、**数量を「2」**にして（合計600円分）ご購入いただけますでしょうか。

▼手数料支払いリンク (${shop})
${feeLink}

お支払いを確認でき次第、直ちにご注文のキャンセル手続きおよび全額返金（元の注文分）の処理を進めさせていただきます。

お手数をおかけいたしますが、何卒ご理解とご協力のほどよろしくお願い申し上げます。

ホムブリスカスタマーサポート`;
}

export const SHOP_FEE_LINKS: Record<string, string> = {
  Shop1: "https://mercari-shops.com/products/ecC9rkWAG2zqF24uppCmfU",
  Shop2: "https://mercari-shops.com/products/2JG6HwbeZGugHsmZYeQHza",
  Shop3: "https://mercari-shops.com/products/2JHx3C2ggyBpDzss2CGtp7",
  Shop4: "https://mercari-shops.com/products/2JMeQugspZmE4TPirgxzZd",
};

export const AFTERSALES_FORM_PLACEHOLDER = "{{AFTERSALES_FORM_URL}}";
export const AFTERSALES_FORM_PATH = "/forms/after-sales/";

export function containsAfterSalesFormLink(message: string): boolean {
  return message.includes(AFTERSALES_FORM_PATH);
}

/** Check if the FUGUAI form URL has already been sent in the thread.
 *  Scans ALL messages (any role, any variant) — immune to ordering
 *  issues, status races, and manual sends via Mercari dashboard. */
export function fuguaiAlreadySent(messages: Array<{ message?: string }>): boolean {
  return messages.some((m) => containsAfterSalesFormLink(m.message || ""));
}

export const TEMPLATES = {
  HOLDING_ACK,
  GREETING_CLOSE_ACK,
  INFO_CLOSE_ACK,
  FUGUAI_TEMPLATE,
  FUGUAI_LITE_TEMPLATE,
  FOLLOWUP_FORM_HELPER,
} as const;
