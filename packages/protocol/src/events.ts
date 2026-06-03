export type DeliveryAvailableEvent = {
  delivery_id: number;
  event_id: string;
  expires_at: string;
};

export type GatewayDrainingEvent = {
  reason: "shutdown";
};
