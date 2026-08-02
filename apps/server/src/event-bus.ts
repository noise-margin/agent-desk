import { EventEmitter } from "node:events";
import type { AgentEvent, AgentEventType } from "@agentdesk/protocol";
import { Store } from "./store.js";

export class EventBus {
  private readonly emitter = new EventEmitter();

  constructor(private readonly store: Store) {
    this.emitter.setMaxListeners(100);
  }

  publish(
    taskId: string,
    sessionId: string,
    type: AgentEventType,
    payload: Record<string, unknown> = {},
  ) {
    const event = this.store.addEvent(taskId, sessionId, type, payload);
    this.emitter.emit(taskId, event);
    this.emitter.emit("*", event);
    return event;
  }

  subscribe(taskId: string, listener: (event: AgentEvent) => void) {
    this.emitter.on(taskId, listener);
    return () => this.emitter.off(taskId, listener);
  }

  subscribeAll(listener: (event: AgentEvent) => void) {
    this.emitter.on("*", listener);
    return () => this.emitter.off("*", listener);
  }
}
