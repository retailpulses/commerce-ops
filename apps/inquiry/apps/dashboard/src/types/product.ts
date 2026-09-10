export interface ProductSearchResult {
  id: string;
  itemCode: string;
  productName: string;
  storeName: string;
  qtyAvailable: number | null;
  ownedQty: number | null;
  mercariQty: number | null;
}

export interface ProductDetail {
  id: string;
  itemCode: string;
  productName: string;
  storeName: string;
  qtyAvailable: number | null;
  ownedQty: number | null;
  mercariQty: number | null;
  restockDate: string | null;
}
