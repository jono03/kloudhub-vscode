import { strict as assert } from "assert";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync } from "fs";
import * as os from "os";
import * as path from "path";
import { test } from "node:test";
import { fingerprint, PUBKEY_RE } from "../keys";

test("지문은 ssh-keygen -lf 와 같은 SHA256:… 형식", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "khkey-"));
  const key = path.join(dir, "id_ed25519");
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "me@pc", "-f", key]);
  const line = readFileSync(key + ".pub", "utf8").trim();
  const expected = execFileSync("ssh-keygen", ["-lf", key + ".pub"], { encoding: "utf8" }).split(" ")[1];
  assert.ok(PUBKEY_RE.test(line));
  assert.equal(fingerprint(line), expected);
});

test("공개키 형식이 아니면 거절", () => {
  assert.ok(!PUBKEY_RE.test("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.ok(!PUBKEY_RE.test("ssh-dss AAAAB3NzaC1kc3M= old"));
  assert.equal(fingerprint("garbage"), undefined);
});
