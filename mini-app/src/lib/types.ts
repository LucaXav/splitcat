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
  // Used when the receipt was parsed with zero line items (e.g. card slip).
  // The API synthesises a single line item for the receipt total and assigns
  // it equally to these users.
  equal_split?: { user_ids: number[] };
};
