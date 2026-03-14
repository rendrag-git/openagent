import { test } from "node:test";
import assert from "node:assert/strict";
import { greet } from "../src/greet.ts";

test("greet returns Hello, {name}!", () => {
  assert.equal(greet("World"), "Hello, World!");
  assert.equal(greet("Alice"), "Hello, Alice!");
});
