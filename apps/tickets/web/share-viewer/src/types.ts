export interface EvidenceDTO {
  attachmentId: string;
  fileName: string;
  mimeType: string;
  size: number;
}

export interface ProductDTO {
  sku: string;
  name: string;
  variant: string;
  role: string;
  seller: string;
  unitPrice: string;
}

export interface TicketShareDTO {
  ticketNumber: string;
  platform: string;
  shopName: string;
  externalOrderId: string;
  status: string;
  priority: string;
  issueTypes: string[];
  startedDate: string;
  products: ProductDTO[];
  sellerDescription: string;
  expiry: string;
  evidence: EvidenceDTO[];
}
