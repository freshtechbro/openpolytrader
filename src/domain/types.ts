export type Side = 'BUY' | 'SELL';
export type OrderType = 'FOK' | 'FAK' | 'GTC' | 'GTD';

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderPlacement {
  tokenId: string;
  side: Side;
  size: number;
  price: number;
  orderType: OrderType;
  clientOrderId?: string;
}

export interface OrderResponse {
  success?: boolean;
  status?: string;
  orderID?: string;
  errorMsg?: string;
}
