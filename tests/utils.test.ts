import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/utils.ts";

describe("slugify", () => {
  it("lowercases the input", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  it("replaces spaces with hyphens", () => {
    assert.equal(slugify("foo bar baz"), "foo-bar-baz");
  });

  it("strips non-alphanumeric characters except hyphens", () => {
    assert.equal(slugify("C++ is #1!"), "c-is-1");
  });

  it("collapses multiple consecutive hyphens", () => {
    assert.equal(slugify("foo---bar"), "foo-bar");
  });

  it("trims leading and trailing hyphens", () => {
    assert.equal(slugify("--already-slugged--"), "already-slugged");
  });

  it("collapses multiple spaces into a single hyphen", () => {
    assert.equal(slugify("foo   bar"), "foo-bar");
  });

  it("trims leading and trailing whitespace", () => {
    assert.equal(slugify("  foo bar  "), "foo-bar");
  });

  it("handles punctuation within words", () => {
    assert.equal(slugify("hello, world!"), "hello-world");
  });

  it("handles an empty string", () => {
    assert.equal(slugify(""), "");
  });

  it("handles a string with only special characters", () => {
    assert.equal(slugify("!@#$%^&*()"), "");
  });

  it("handles a string that is already a valid slug", () => {
    assert.equal(slugify("already-a-slug"), "already-a-slug");
  });

  it("handles numbers in the title", () => {
    assert.equal(slugify("Top 10 Reasons"), "top-10-reasons");
  });

  it("handles mixed special chars and spaces", () => {
    assert.equal(slugify("The Quick (Brown) Fox!"), "the-quick-brown-fox");
  });

  it("handles hyphens adjacent to spaces", () => {
    assert.equal(slugify("foo - bar"), "foo-bar");
  });
});
