// node --test scripts/manifest-schema.test.mjs
//
// `bynk.toml`'s JSON Schema is generated and published by the compiler's repo
// (served at the URL below); this extension only associates it with the file.
// The compiler's own `the_schema_id_is_its_published_url` holds the other end.
import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const SCHEMA_URL = "https://bynk-lang.org/schemas/bynk.toml.json";

test("the extension associates the schema with bynk.toml", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const rules = pkg.contributes?.tomlValidation;
  assert.ok(Array.isArray(rules), "package.json contributes `tomlValidation`");
  assert.ok(
    rules.some((r) => r.fileMatch === "bynk.toml" && r.url === SCHEMA_URL),
    `a \`tomlValidation\` rule maps \`bynk.toml\` to ${SCHEMA_URL}`,
  );
});
