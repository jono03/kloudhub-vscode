import { strict as assert } from "assert";
import { after, before, test } from "node:test";
import { AuthError, KloudHubClient, KloudHubError, normalizeEndpoint, webBase } from "../kloudhub/client";
import { MockServer, startMockKloudHub, TOKEN } from "./mockKloudHub";

let mock: MockServer;
before(async () => {
  mock = await startMockKloudHub("SHA256:mine");
});
after(() => mock.close());

test("웹 주소를 API 주소로 맞춘다", () => {
  assert.equal(normalizeEndpoint("https://kh.example.ac.kr"), "https://kh.example.ac.kr/api/v1");
  assert.equal(normalizeEndpoint(" https://kh.example.ac.kr/p/lab/environments "), "https://kh.example.ac.kr/api/v1");
  assert.equal(normalizeEndpoint("http://localhost:8000/api/v1/"), "http://localhost:8000/api/v1");
  assert.equal(normalizeEndpoint("https://host/sub/api/v1/me"), "https://host/sub/api/v1");
  assert.equal(webBase("https://kh.example.ac.kr/api/v1"), "https://kh.example.ac.kr");
  assert.throws(() => normalizeEndpoint("kh.example.ac.kr"), KloudHubError);
});

test("Bearer 토큰을 보내고, 내 환경만(mine=true) 요청한다", async () => {
  const c = new KloudHubClient({ endpoint: normalizeEndpoint(mock.endpoint), token: TOKEN });
  const me = await c.me();
  assert.equal(me.username, "me");
  const envs = await c.myEnvironments("lab");
  assert.ok(envs.every((e) => e.owner === "me"));
  const last = mock.requests[mock.requests.length - 1];
  assert.equal(last.path, "/api/v1/projects/lab/environments?mine=true");
  assert.equal(last.auth, `Bearer ${TOKEN}`);
});

test("틀린 토큰은 AuthError, 다른 오류는 detail 문구를 싣는다", async () => {
  const bad = new KloudHubClient({ endpoint: normalizeEndpoint(mock.endpoint), token: "kh_wrong_token" });
  await assert.rejects(bad.me(), (e: any) => e instanceof AuthError && /만료/.test(e.message));
  const c = new KloudHubClient({ endpoint: normalizeEndpoint(mock.endpoint), token: TOKEN });
  await assert.rejects(c.instances("nope"), (e: any) => !(e instanceof AuthError) && /권한이 없습니다 \(HTTP 403\)/.test(e.message));
});

test("작업을 끝까지 기다리고, 실패하면 작업의 실패 원인을 올린다", async () => {
  const c = new KloudHubClient({ endpoint: normalizeEndpoint(mock.endpoint), token: TOKEN });
  const job = await c.environmentAction("lab", "dev", "start");
  const seen: string[] = [];
  await c.waitForJob(job, { intervalMs: 5, onState: (j) => seen.push(j.state) });
  assert.deepEqual(seen, ["running", "succeeded"]);
  assert.equal(mock.envs.find((e) => e.name === "dev")!.state, "running");

  mock.failNextJob = "쿼터를 넘었습니다";
  const job2 = await c.environmentAction("lab", "dev", "stop");
  await assert.rejects(c.waitForJob(job2, { intervalMs: 5 }), /쿼터를 넘었습니다/);
  // 다음 테스트 파일과 섞이지 않게 되돌린다
  mock.envs.find((e) => e.name === "dev")!.state = "stopped";
});
