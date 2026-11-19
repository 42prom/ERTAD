import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { loadEnvFile } from "node:process";
import pg from "pg";
import request from "supertest";
import pino from "pino";

loadEnvFile(".env");
const database = `ertad_work_evidence_test_${randomBytes(8).toString("hex")}`,
  port = Number(process.env.ERTAD_POSTGRES_PORT ?? 15432);
const config = {
  host: "127.0.0.1",
  port,
  user: "ertad_owner",
  password: process.env.POSTGRES_PASSWORD,
};
const control = new pg.Client({ ...config, database: "ertad" }),
  owner = new pg.Client({
    ...config,
    database,
    options: "-c search_path=ertad,public",
  });
process.env.NODE_ENV = "test";
process.env.ERTAD_WEB_DEMO = "true";
process.env.API_KEY_ENCRYPTION_SECRET = randomBytes(32).toString("base64url");
process.env.DATABASE_URL = `postgresql://ertad_app:${encodeURIComponent(process.env.APP_DB_PASSWORD!)}@127.0.0.1:${port}/${database}`;
let created = false,
  connected = false,
  close: (() => Promise<void>) | undefined,
  checks = 0;
const origin = "http://localhost:15173",
  base = "/api/v1/admin";
async function check(name: string, fn: () => Promise<void>) {
  await fn();
  checks++;
  console.log(`PASS ${name}`);
}
await control.connect();
try {
  await control.query(`CREATE DATABASE ${database}`);
  created = true;
  execFileSync(
    process.execPath,
    ["--import", "tsx", "backend/src/migrate.ts"],
    {
      stdio: "pipe",
      env: {
        ...process.env,
        MIGRATION_DATABASE_URL: `postgresql://ertad_owner:${encodeURIComponent(process.env.POSTGRES_PASSWORD!)}@127.0.0.1:${port}/${database}`,
      },
    },
  );
  await owner.connect();
  connected = true;
  const db = await import("../backend/src/db/client");
  close = db.close;
  const { seedWebDemo } = await import("./web-demo-fixture"),
    { enableDemoCollective } = await import("./web-demo-collective"),
    { enableDemoContribution } = await import("./web-demo-contribution");
  await owner.query("BEGIN");
  const access = await seedWebDemo(owner);
  await owner.query("COMMIT");
  const { createApp } = await import("../backend/src/app"),
    { createLocalAdminRouter } = await import("../backend/src/localAdmin");

  const app = createApp(
    {
      postgres: async () => {},
      redis: async () => {},
      storage: async () => {},
    },
    pino({ level: "silent" }),
    origin,
    createLocalAdminRouter(origin, () => access),
  );
  const sessions: {
    agent: ReturnType<typeof request.agent>;
    csrf: string;
    sessionId: string;
    sessionTokenHash: string;
  }[] = [];
  for (const a of access.accounts) {
    const agent = request.agent(app),
      login = await agent
        .post(base + "/demo/login")
        .set("Origin", origin)
        .send({ accountId: a.id })
        .expect(200);
    const row = (
      await owner.query(
        'SELECT id AS "sessionId",token_hash AS "sessionTokenHash" FROM admin_sessions WHERE admin_user_id=$1',
        [a.id],
      )
    ).rows[0];
    sessions.push({ agent, csrf: login.body.csrfToken, ...row });
    await agent
      .post(base + "/demo/step-up")
      .set("Origin", origin)
      .set("X-Admin-Csrf", login.body.csrfToken)
      .send({})
      .expect(200);
  }
  const org = access.organizationId,
    unit = access.accounts[2].unitId;
  const { enableDemoWork } = await import("./web-demo-work");
  await owner.query("BEGIN");
  await enableDemoWork(owner, access);
  await owner.query("COMMIT");
  const limitedBundle = randomUUID(),
    limitedPosition = randomUUID();
  await owner.query(
    "INSERT INTO permission_bundles(organization_id,id,version) VALUES($1,$2,1)",
    [org, limitedBundle],
  );
  for (const permission of [
    "unit.read",
    "workitem.read",
    "workitem.participate",
  ])
    await owner.query(
      "INSERT INTO permission_grants VALUES($1,$2,1,$3,'subtree')",
      [org, limitedBundle, permission],
    );
  await owner.query(
    "UPDATE permission_bundles SET status='approved' WHERE organization_id=$1 AND id=$2",
    [org, limitedBundle],
  );
  await owner.query(
    "INSERT INTO positions(organization_id,id,unit_id,name,bundle_id,bundle_version) VALUES($1,$2,$3,'Evidence participant',$4,1)",
    [org, limitedPosition, unit, limitedBundle],
  );
  await owner.query(
    "UPDATE memberships SET status='suspended' WHERE organization_id=$1 AND user_id=$2",
    [org, access.accounts[3].memberId],
  );
  for (const i of [1, 3])
    await owner.query(
      "INSERT INTO memberships(organization_id,user_id,unit_id,position_id,bundle_version,valid_from,valid_until) VALUES($1,$2,$3,$4,1,now(),now()+interval '30 days')",
      [org, access.accounts[i].memberId, unit, limitedPosition],
    );
  const { workCommand } = await import("../backend/src/modules/work/tasks");
  const {
    evidenceUpload,
    evidenceDownload,
    evidenceList,
    validateEvidence,
    createEvidenceStore,
    evidenceObjectKey,
  } = await import("../backend/src/modules/work/evidence");
  const { SecurityService } = await import("../backend/src/services/security");
  const { purgeWorkEvidence } = await import("./purge-work-evidence");
  const memory = new Map<string, Buffer>();
  const store = {
    put: async (key: string, body: Buffer) => {
      memory.set(key, Buffer.from(body));
    },
    get: async (key: string) => {
      const bytes = memory.get(key);
      if (!bytes) throw new Error("Missing object");
      return bytes;
    },
    delete: async (key: string) => {
      memory.delete(key);
    },
  };
  const real = createEvidenceStore();
  const realKeys: string[] = [];
  const work = (
    i: number,
    op: Parameters<typeof workCommand>[1],
    input: object = {},
  ) => workCommand(sessions[i], op, { organizationId: org, ...input });
  const denied = (p: Promise<unknown>, status = 403) =>
    assert.rejects(p, (e: any) => e.statusCode === status);
  const task = (
    await work(2, "create", {
      key: randomUUID(),
      unitId: unit,
      capacity: 2,
      title: "Synthetic evidence task",
      description: "Private text reports",
      roleLabel: "Volunteer",
      priority: "normal",
      deadline: new Date(Date.now() + 86400000).toISOString(),
    })
  ).id;
  const action = async (
    i: number,
    op: Parameters<typeof workCommand>[1],
    input: object = {},
  ) =>
    work(i, op, {
      id: task,
      key: randomUUID(),
      version: (await work(i, "detail", { id: task })).version,
      ...input,
    });
  const scope = { organizationId: org, workId: task },
    bytes = Buffer.from(
      "Synthetic work report\nშესრულების სინთეზური ანგარიში\n",
    );
  let first = "";
  try {
    if (process.argv.includes("--files")) {
      const { testWorkFiles } = await import("./work-file-tests");
      await testWorkFiles({
        check,
        sessions,
        scope,
        store,
        memory,
        owner,
        realKeys,
        access,
      });
      console.log(`Work material files: ${checks} scenarios passed`);
    } else {
      await check(
        "reports require current contributor or reviewer access, not generic task reading",
        async () => {
          await denied(evidenceList(sessions[3], scope));
          await action(3, "apply");
          await denied(
            evidenceUpload(
              sessions[3],
              { ...scope, key: randomUUID() },
              bytes,
              store,
            ),
          );
          await action(2, "assign", { memberId: access.accounts[3].memberId });
          assert.equal(
            (await evidenceList(sessions[3], scope)).canUpload,
            true,
          );
          await denied(evidenceList(sessions[4], scope));
        },
      );
      await check(
        "bounded UTF-8 validation rejects binary, controls, malformed text and empty reports",
        async () => {
          for (const invalid of [
            Buffer.alloc(0),
            Buffer.alloc(65537, 65),
            Buffer.from([0xc3, 0x28]),
            Buffer.from("text\0payload"),
            Buffer.from("  \n"),
          ])
            assert.throws(() => validateEvidence(invalid));
          assert.deepEqual(validateEvidence(bytes), bytes);
        },
      );
      await check(
        "concurrent identical retries publish one report and changed content conflicts",
        async () => {
          const args = { ...scope, key: randomUUID() };
          const results = await Promise.all([
            evidenceUpload(sessions[3], args, bytes, store),
            evidenceUpload(sessions[3], args, bytes, store),
          ]);
          first = results[0].id;
          assert.equal(results[1].id, first);
          await denied(
            evidenceUpload(sessions[3], args, Buffer.from("different"), store),
            409,
          );
          const listed = await evidenceList(sessions[2], scope);
          assert.equal(listed.items.length, 1);
          assert.equal(listed.items[0].mine, false);
          assert.equal("digest" in listed.items[0], false);
          assert.equal("uploaderId" in listed.items[0], false);
          assert.deepEqual(
            await evidenceDownload(sessions[3], { ...scope, id: first }, store),
            bytes,
          );
        },
      );
      await check(
        "peer contributors cannot list or download another participant report",
        async () => {
          await action(1, "apply");
          await action(2, "assign", { memberId: access.accounts[1].memberId });
          // Give only the participant bundle during this check; council rank confers nothing.
          const changed = (
            await owner.query(
              "UPDATE memberships SET status='suspended' WHERE user_id=$1 AND position_id<>$2 AND status='active' RETURNING id",
              [access.accounts[1].memberId, limitedPosition],
            )
          ).rows;
          try {
            await denied(
              evidenceDownload(sessions[4], { ...scope, id: first }, store),
            );
            assert.equal(
              (await evidenceList(sessions[1], scope)).items.length,
              0,
            );
            await denied(
              evidenceDownload(sessions[1], { ...scope, id: first }, store),
            );
          } finally {
            await owner.query(
              "UPDATE memberships SET status='active' WHERE id=ANY($1::uuid[])",
              [changed.map((r) => r.id)],
            );
          }
        },
      );
      await check(
        "storage failure leaves a non-downloadable reservation and identical retry recovers",
        async () => {
          const args = { ...scope, key: randomUUID() };
          await assert.rejects(
            evidenceUpload(sessions[3], args, bytes, {
              ...store,
              put: async () => {
                throw new Error("Storage unavailable");
              },
            }),
          );
          assert.equal(
            (await evidenceList(sessions[3], scope)).items.length,
            1,
          );
          const recovered = await evidenceUpload(
            sessions[3],
            args,
            bytes,
            store,
          );
          assert.deepEqual(
            await evidenceDownload(
              sessions[2],
              { ...scope, id: recovered.id },
              store,
            ),
            bytes,
          );
        },
      );
      await check(
        "audit rollback does not publish an uploaded object and integrity mismatch never downloads",
        async () => {
          const args = { ...scope, key: randomUUID() },
            original = SecurityService.logAuditEventInTransaction;
          let calls = 0;
          SecurityService.logAuditEventInTransaction = async (
            client,
            ...rest
          ) => {
            if (++calls === 3)
              throw new Error("Synthetic publication audit failure");
            return original.call(SecurityService, client, ...rest);
          };
          try {
            await assert.rejects(
              evidenceUpload(sessions[3], args, bytes, store),
            );
          } finally {
            SecurityService.logAuditEventInTransaction = original;
          }
          const row = (
            await owner.query(
              "SELECT id,state FROM work_evidence WHERE request_key=$1",
              [args.key],
            )
          ).rows[0];
          assert.equal(row.state, "pending");
          await denied(
            evidenceDownload(sessions[3], { ...scope, id: row.id }, store),
          );
          await evidenceUpload(sessions[3], args, bytes, store);
          await assert.rejects(
            evidenceDownload(
              sessions[3],
              { ...scope, id: first },
              { ...store, get: async () => Buffer.from("corrupt") },
            ),
          );
        },
      );
      await check(
        "permission expiry during storage read or audit prevents release of bytes",
        async () => {
          const grants = (
            await owner.query(
              "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
              [org, access.accounts[3].memberId],
            )
          ).rows;
          const original = SecurityService.logAuditEventInTransaction;
          SecurityService.logAuditEventInTransaction = async (
            client,
            ...rest
          ) => {
            await original.call(SecurityService, client, ...rest);
            await client.query("SELECT pg_sleep(3)");
          };
          try {
            await owner.query(
              "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=ANY($1::uuid[])",
              [grants.map((r) => r.id)],
            );
            await denied(
              evidenceDownload(sessions[3], { ...scope, id: first }, store),
            );
          } finally {
            SecurityService.logAuditEventInTransaction = original;
            for (const grant of grants)
              await owner.query(
                "UPDATE memberships SET valid_until=$2 WHERE id=$1",
                [grant.id, grant.valid_until],
              );
          }
        },
      );
      await check(
        "private S3 stores and downloads exact bytes; anonymous access and forged HTTP writes fail",
        async () => {
          const response = await sessions[3].agent
            .post(base + "/work-evidence")
            .query({ ...scope, key: randomUUID() })
            .set("Origin", origin)
            .set("X-Admin-Csrf", sessions[3].csrf)
            .set("Content-Type", "text/plain")
            .send(bytes)
            .expect(201);
          const key = evidenceObjectKey(org, response.body.id);
          realKeys.push(key);
          assert.deepEqual(
            await evidenceDownload(
              sessions[2],
              { ...scope, id: response.body.id },
              real,
            ),
            bytes,
          );
          const download = await sessions[2].agent
            .get(base + "/work-evidence/download")
            .query({ ...scope, id: response.body.id })
            .expect(200);
          assert.match(download.headers["content-disposition"], /^attachment/);
          assert.equal(download.headers["cache-control"], "no-store");
          const anonymous = await fetch(
            `http://127.0.0.1:${process.env.ERTAD_STORAGE_PORT ?? 19000}/ertad-attachments/${key}`,
          );
          assert.ok([401, 403].includes(anonymous.status));
          for (const [type, body, status] of [
            ["application/octet-stream", bytes, 400],
            ["text/plain", Buffer.alloc(65537, 65), 413],
          ] as const) {
            await sessions[3].agent
              .post(base + "/work-evidence")
              .query({ ...scope, key: randomUUID() })
              .set("Origin", origin)
              .set("X-Admin-Csrf", sessions[3].csrf)
              .set("Content-Type", type)
              .send(body)
              .expect(status);
          }
          await request(app)
            .get(base + "/work-evidence")
            .query(scope)
            .expect(401);
          await sessions[3].agent
            .post(base + "/work-evidence")
            .query({ ...scope, key: randomUUID() })
            .set("Content-Type", "text/plain")
            .send(bytes)
            .expect(403);
          await sessions[4].agent
            .get(base + "/work-evidence/download")
            .query({ ...scope, id: first })
            .expect(403);
          await sessions[3].agent
            .post(base + "/work-evidence")
            .query({
              ...scope,
              key: randomUUID(),
              uploaderId: access.accounts[2].memberId,
            })
            .set("Origin", origin)
            .set("X-Admin-Csrf", sessions[3].csrf)
            .set("Content-Type", "text/plain")
            .send(bytes)
            .expect(400);
        },
      );
      await check(
        "expired content becomes unavailable and cleanup is idempotent and retryable",
        async () => {
          await owner.query(
            "UPDATE work_evidence SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [first],
          );
          await denied(
            evidenceDownload(sessions[3], { ...scope, id: first }, store),
          );
          await assert.rejects(
            purgeWorkEvidence(owner, {
              ...store,
              delete: async () => {
                throw new Error("Synthetic deletion outage");
              },
            }),
          );
          assert.equal(
            (
              await owner.query("SELECT state FROM work_evidence WHERE id=$1", [
                first,
              ])
            ).rows[0].state,
            "ready",
          );
          const original = SecurityService.logAuditEventInTransaction;
          SecurityService.logAuditEventInTransaction = async () => {
            throw new Error("Synthetic purge audit failure");
          };
          try {
            await assert.rejects(purgeWorkEvidence(owner, store));
          } finally {
            SecurityService.logAuditEventInTransaction = original;
          }
          assert.equal(memory.has(evidenceObjectKey(org, first)), false);
          assert.equal(
            (
              await owner.query("SELECT state FROM work_evidence WHERE id=$1", [
                first,
              ])
            ).rows[0].state,
            "ready",
          );
          assert.equal(await purgeWorkEvidence(owner, store), 1);
          assert.equal(await purgeWorkEvidence(owner, store), 0);
          assert.equal(memory.has(evidenceObjectKey(org, first)), false);
        },
      );
      await check(
        "concurrent last-slot uploads enforce lifetime contributor and task quotas",
        async () => {
          const count = Number(
            (
              await owner.query(
                "SELECT count(*) FROM work_evidence WHERE work_id=$1 AND uploader_id=$2",
                [task, access.accounts[3].memberId],
              )
            ).rows[0].count,
          );
          for (let n = count; n < 9; n++)
            await evidenceUpload(
              sessions[3],
              { ...scope, key: randomUUID() },
              bytes,
              store,
            );
          const outcomes = await Promise.allSettled(
            [1, 2].map(() =>
              evidenceUpload(
                sessions[3],
                { ...scope, key: randomUUID() },
                bytes,
                store,
              ),
            ),
          );
          assert.equal(
            outcomes.filter((result) => result.status === "fulfilled").length,
            1,
          );
          const failure = outcomes.find(
            (result) => result.status === "rejected",
          ) as PromiseRejectedResult;
          assert.equal(failure.reason.statusCode, 409);
          assert.equal(
            Number(
              (
                await owner.query(
                  "SELECT count(*) FROM work_evidence WHERE work_id=$1 AND uploader_id=$2",
                  [task, access.accounts[3].memberId],
                )
              ).rows[0].count,
            ),
            10,
          );
          // Owner-only synthetic capacity fixture; the runtime still uses the public command.
          await owner.query(
            "INSERT INTO work_evidence(organization_id,work_id,uploader_id,request_key,digest,bytes) SELECT $1,$2,$3,gen_random_uuid(),repeat('a',64),1 FROM generate_series(1,100-(SELECT count(*)::int FROM work_evidence WHERE work_id=$2))",
            [org, task, access.accounts[1].memberId],
          );
          await denied(
            evidenceUpload(
              sessions[2],
              { ...scope, key: randomUUID() },
              bytes,
              store,
            ),
            409,
          );
        },
      );
      await check(
        "moved hierarchy and closed tasks never inherit upload authority",
        async () => {
          await action(2, "cancel", { note: "Synthetic task cancellation" });
          assert.equal(
            (await evidenceList(sessions[2], scope)).canUpload,
            false,
          );
          await denied(
            evidenceUpload(
              sessions[3],
              { ...scope, key: randomUUID() },
              bytes,
              store,
            ),
          );
          const parent = (
            await owner.query(
              "SELECT parent_id FROM units WHERE organization_id=$1 AND id=$2",
              [org, unit],
            )
          ).rows[0].parent_id;
          await owner.query(
            "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
            [org, unit, access.accounts[4].unitId],
          );
          try {
            await denied(evidenceList(sessions[2], scope));
          } finally {
            await owner.query(
              "UPDATE units SET parent_id=$3 WHERE organization_id=$1 AND id=$2",
              [org, unit, parent],
            );
          }
          const runtime = new pg.Client({
            connectionString: process.env.DATABASE_URL,
          });
          await runtime.connect();
          try {
            await assert.rejects(
              runtime.query("SELECT * FROM ertad.work_evidence"),
              (e: any) => e.code === "42501",
            );
          } finally {
            await runtime.end();
          }
        },
      );
      console.log(`Work evidence: ${checks} scenarios passed`);
    }
    if (process.argv.includes("--browser")) {
      const { verifyEvidenceBrowser } = await import("./work-evidence-browser");
      const id = (
        await work(2, "create", {
          key: randomUUID(),
          unitId: unit,
          capacity: 1,
          title: "Synthetic browser evidence",
          description: "Private report browser flow",
          roleLabel: "Volunteer",
          priority: "normal",
          deadline: new Date(Date.now() + 86400000).toISOString(),
        })
      ).id;
      const act = async (
        i: number,
        op: Parameters<typeof workCommand>[1],
        extra = {},
      ) =>
        work(i, op, {
          id,
          key: randomUUID(),
          version: (await work(i, "detail", { id })).version,
          ...extra,
        });
      await act(3, "apply");
      await act(2, "assign", { memberId: access.accounts[3].memberId });
      try {
        await verifyEvidenceBrowser(
          app,
          access,
          process.argv.includes("--files"),
        );
      } finally {
        for (const row of (
          await owner.query(
            "SELECT id,kind FROM work_evidence WHERE organization_id=$1 AND work_id=$2",
            [org, id],
          )
        ).rows)
          realKeys.push(evidenceObjectKey(org, row.id, row.kind));
      }
    }
  } finally {
    for (const key of realKeys) await real.delete(key);
  }
} finally {
  if (close) await close();
  if (connected) await owner.end();
  if (created) await control.query(`DROP DATABASE ${database} WITH (FORCE)`);
  await control.end();
}
