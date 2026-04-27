export type Member = {
  user_id: number;
  display_name: string;
  username: string | null;
};

export type LineItem = {
  id: string;
  position: number;
  description: string;
  quantity: number;
  unit_price: number;
  line_total: number;
  assignments: Array<{ user_id: number; share: number }>;
};

export type Receipt = {
  id: string;
  group_id: number;
  uploaded_by: number;
  merchant: string | null;
  receipt_date: string | null;
  currency: string;
  subtotal: number;
  service_charge: number;
  tax: number;
  tip: number;
  total: number;
  fx_rate: number | null;
  home_currency: string;
  status: string;
  line_items: LineItem[];
  members: Member[];
};

export type AssignmentPayload = {
  payers: Array<{ user_id: number; amount_paid: number }>;
  assignments: Array<{
    line_item_id: string;
    user_ids: number[]; // equal split among these
  }>;
};
