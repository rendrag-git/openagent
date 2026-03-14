/**
 * Converts a string to a URL-safe kebab-case slug.
 *
 * Steps:
 *  1. Lowercase the input
 *  2. Replace spaces with hyphens
 *  3. Strip all characters that are not alphanumeric or hyphens
 *  4. Collapse multiple consecutive hyphens into one
 *  5. Trim leading and trailing hyphens
 *
 * @param title - The string to slugify
 * @returns A URL-safe kebab-case slug
 *
 * @example
 * slugify("Hello World!")        // "hello-world"
 * slugify("  foo   bar  ")       // "foo-bar"
 * slugify("C++ is #1!")          // "c-is-1"
 * slugify("--already-slugged--") // "already-slugged"
 */
export function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}
