export interface StatusInfo {
  id: string;
  label: string;
}

export interface InquiryTypeInfo {
  id: string;
  label: string;
}

/** Summary shape for list view */
export interface InquirySummary {
  id: number;
  status: StatusInfo;
  account: StatusInfo | null;
  customerNickname: string;
  productName: string;
  inquiryType: InquiryTypeInfo | null;
  inquiryDate: string | null;
  url: string;
  hasDraft: boolean;
  hasCopywrite: boolean;
  hasProduct: boolean;
  units: number | null;
  effectivePriceExclShipping: number | null;
  effectivePriceInclShipping: number | null;
  effectiveTCOGS: number | null;
  expectedValue: number | null;
}

/** Full inquiry detail */
export interface ProductLink {
  id: string | null;
  linkRowId: number | null;
  itemCode: string;
  productName: string;
  isPrimary: boolean;
  linkSource: string | null;
  confidence: number | null;
  storeName: string;
  qtyAvailable: number | null;
  ownedQty: number | null;
  mercariQty: number | null;
  restockDate: string | null;
}

export interface InquiryDetail {
  id: number;
  shopKey: string | null;
  status: StatusInfo;
  seller: string;
  inquiryType: InquiryTypeInfo | null;
  customerNickname: string;
  productName: string;
  inquiryBody: string;
  lastCustomMessage: string;
  inquiryDate: string | null;
  lastInboundTime: string | null;
  url: string;
  orderId: string;
  messageLog: string;
  draftReply: string;
  inquirySkillReply: string;
  aiReplyCopywrited: string;
  replyStrategy: string;
  linkedProducts: ProductLink[];
  units: number | null;
  effectivePriceExclShipping: number | null;
  effectivePriceInclShipping: number | null;
  effectiveTCOGS: number | null;
  expectedValue: number | null;
  followUpState: string | null;
  followUpDueDate: string | null;
  followUpDateSource: string | null;
}

/** Pagination */
export interface Pagination {
  hasMore: boolean;
  nextCursor?: number | null;
}

/** Prompt version info */
export interface PromptVersion {
  version: number;
  /** Full prompt text (only included in active/selected version, truncated in history) */
  text: string;
  active: boolean;
  createdAt: string | null;
}

/** Message template for reply composition */
export interface MessageTemplate {
  id: string; // UUID from KV, matches OrderMgmt
  title: string;
  body: string;
  created_at: string;
  updated_at: string;
}

/** Prompt state from the API */
export interface CopywritePromptState {
  active: {
    version: number;
    text: string;
    isDefault?: boolean;
  };
  versions: PromptVersion[];
}

/** Filter state */
export interface InquiryFilters {
  status: string;
  search: string;
}

export interface ListingOptimizationState {
  status: "ready" | "waiting_for_customer_confirmation" | "mapping_error" | "mapping_conflict";
  message?: string;
  listing?: {
    id: string; platform: string; shopCode: string; externalListingId: string;
    title: string; description: string; contentRevision: number;
    scoreTotal: number | null; scoreModules: Record<string, unknown> | null;
    scoredAt: string | null; scoreIsStale: boolean;
  };
}

export interface MainImageEvidence {
  id: string;
  status: "verified" | "context_only";
  kind: string;
  label: string;
  value: unknown;
  sourcePath: string;
  variantId?: string;
}

export interface MainImageContextState {
  status: "ready" | "waiting_for_customer_confirmation" | "mapping_error" | "mapping_conflict";
  message?: string;
  listing?: {
    id: string; platform: string; shopCode: string; externalListingId: string; contentRevision: number;
  };
  context?: {
    listing: {
      title: string | null; contentRevision: number; imageUrls: string[];
      selectedVariantId: string | null;
    };
    spu: { id: string; spuCode: string | null } | null;
    variants: Array<{
      id: string; itemCode: string | null; name: string | null; color: string | null;
      size: string | null; quantity: number | null; isActive: boolean;
    }>;
    assets: Array<{
      id: string; url: string | null; kind: string | null; isUsable: boolean;
      variantId: string | null;
    }>;
    fact_pack: {
      evidence: MainImageEvidence[]; warnings: string[]; assetIds: string[];
    };
    fact_pack_hash: string;
  };
}

export interface MainImageSchemaResult {
  schema: Record<string, unknown>;
  validation: { valid: boolean; errors: string[]; warnings: string[] };
  fact_pack_hash: string;
  model: string;
  prompt_version: string;
}

export interface MainImageCandidateResult {
  candidate_base64: string;
  candidate_token: string;
  provider: string;
  model: string;
  content_type: string;
  width: number;
  height: number;
  fact_pack_hash: string;
}

export interface MainImageSavedAsset {
  asset_id: string;
  object_key: string;
  asset_url: string;
  checksum_sha256: string;
  width: number;
  height: number;
  outcome: "saved";
}

/** Normalized inquiry message timeline item. */
export interface InquiryMessage {
  id: number;
  externalMessageId: string;
  from: string | null;
  direction: string | null;
  body: string;
  sentAt: string | null;
  status: string | null;
  sourcePayloadHash: string | null;
  outboundOperationId: number | null;
}

export type FollowUpBucket = "due" | "overdue" | "upcoming" | "history";

/** Follow-up queue projection row. */
export interface FollowUpQueueItem {
  id: number;
  shopKey: string | null;
  externalInquiryId: string | null;
  customerNickname: string;
  productName: string;
  targetType: string | null;
  followUpState: string | null;
  followUpDueDate: string | null;
  followUpDateSource: string | null;
  followUpCycleId: string | null;
  lastConfirmedOutboundMessageId: string | null;
  lastConfirmedOutboundAt: string | null;
  status: string | null;
  daysOverdue: number | null;
  daysUntilDue: number | null;
  bucket: FollowUpBucket | null;
  latestMessageFrom: string | null;
}
