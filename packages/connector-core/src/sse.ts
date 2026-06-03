import { EventSource } from "eventsource";
import type { DeliveryAvailableEvent } from "@pebble/protocol";

export function connectDeliveryEvents(
  serverUrl: string,
  token: string,
  onDelivery: (event: DeliveryAvailableEvent) => void
): EventSource {
  const source = new EventSource(`${serverUrl}/api/agent/events`, {
    fetch: (input, init) => fetch(input, {
      ...init,
      headers: {
        ...init?.headers,
        Authorization: `Bearer ${token}`
      }
    })
  });

  source.addEventListener("delivery.available", (message) => {
    onDelivery(JSON.parse(message.data) as DeliveryAvailableEvent);
  });

  return source;
}
