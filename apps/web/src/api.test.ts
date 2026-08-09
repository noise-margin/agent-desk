import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api request headers", () => {
  it("does not declare an empty POST as JSON", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await api.interrupt("task-1");

    expect(fetch).toHaveBeenCalledWith("/api/tasks/task-1/interrupt", {
      method: "POST",
      headers: {},
    });
  });

  it("keeps the JSON content type when a body is present", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ mode: "steer" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetch);

    await api.followUp("task-1", "continue");

    expect(fetch).toHaveBeenCalledWith("/api/tasks/task-1/follow-ups", expect.objectContaining({
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "continue", persist: true }),
    }));
  });
});
