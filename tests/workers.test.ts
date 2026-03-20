import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as openagent from "../src/index.ts";

describe("public API", () => {
  it("exports plan function", () => {
    assert.equal(typeof openagent.plan, "function");
  });

  it("exports execute function", () => {
    assert.equal(typeof openagent.execute, "function");
  });

  it("exports check function", () => {
    assert.equal(typeof openagent.check, "function");
  });

  it("exports act function", () => {
    assert.equal(typeof openagent.act, "function");
  });

  it("exports createSession function", () => {
    assert.equal(typeof openagent.createSession, "function");
  });

  it("exports resume function", () => {
    assert.equal(typeof openagent.resume, "function");
  });

  it("exports ACP-facing runtime adapter", () => {
    assert.equal(typeof openagent.createOpenAgentRuntimeAdapter, "function");
  });

  it("exports types", () => {
    // Verify type re-exports are accessible (runtime check for ParkSession class)
    assert.equal(typeof openagent.ParkSession, "function");
  });
});
