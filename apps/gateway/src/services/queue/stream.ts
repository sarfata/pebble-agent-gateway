import { EventEmitter } from "node:events";
import type { DeliveryAvailableEvent } from "@pebble/protocol";

export class DeliveryStreamHub {
  private readonly emitter = new EventEmitter();
  private draining = false;

  onAvailable(agentId: string, listener: (event: DeliveryAvailableEvent) => void): () => void {
    const name = `agent:${agentId}`;
    this.emitter.on(name, listener);
    return () => this.emitter.off(name, listener);
  }

  publish(agentId: string, event: DeliveryAvailableEvent): void {
    this.emitter.emit(`agent:${agentId}`, event);
  }

  markDraining(): void {
    this.draining = true;
    this.emitter.emit("draining");
  }

  onDraining(listener: () => void): () => void {
    this.emitter.on("draining", listener);
    return () => this.emitter.off("draining", listener);
  }

  isDraining(): boolean {
    return this.draining;
  }
}
