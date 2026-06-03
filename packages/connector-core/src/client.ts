import type { EncryptedPayloadEnvelope } from "@pebble/protocol";

export class PebbleGatewayClient {
  constructor(
    private readonly serverUrl: string,
    private readonly token: string
  ) {}

  async claim(deliveryId: number): Promise<EncryptedPayloadEnvelope> {
    const response = await fetch(`${this.serverUrl}/api/agent/deliveries/${deliveryId}/claim`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.token}` }
    });
    if (!response.ok) throw new Error(`claim failed: ${response.status}`);
    const body = await response.json() as { encrypted_payload: EncryptedPayloadEnvelope };
    return body.encrypted_payload;
  }

  async ack(deliveryId: number, status = "processed"): Promise<void> {
    const response = await fetch(`${this.serverUrl}/api/agent/deliveries/${deliveryId}/ack`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ status })
    });
    if (!response.ok) throw new Error(`ack failed: ${response.status}`);
  }

  async reply(eventId: string, deliveryId: number, text: string, status = "completed"): Promise<void> {
    const response = await fetch(`${this.serverUrl}/api/agent/replies`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ event_id: eventId, delivery_id: deliveryId, text, status })
    });
    if (!response.ok) throw new Error(`reply failed: ${response.status}`);
  }
}
