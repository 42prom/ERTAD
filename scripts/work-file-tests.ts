import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { inflateSync } from "node:zlib";
import sharp from "sharp";
import { PDFDocument, PDFName, PDFArray, PDFRawStream } from "pdf-lib";
import {
  materialFileList,
  materialFileUpload,
  materialFileDownload,
  materialFileRemove,
} from "../backend/src/modules/work/materialFiles";
import {
  evidenceList,
  evidenceDownload,
  evidenceUpload,
  evidenceObjectKey,
} from "../backend/src/modules/work/evidence";
import {
  normalizeMaterial,
  materialFormat,
} from "../backend/src/modules/work/attachmentNormalizer";
import { SecurityService } from "../backend/src/services/security";
import { purgeWorkEvidence } from "./purge-work-evidence";

// Reuse the disposable evidence harness and its real session/authority fixture.
export async function testWorkFiles({
  check,
  sessions,
  scope,
  store,
  memory,
  owner,
  realKeys,
  access,
}: any) {
  const manager = sessions[2],
    reader = sessions[3],
    sibling = sessions[4];
  const denied = (promise: Promise<unknown>, status = 403) =>
    assert.rejects(promise, (e: any) => e.statusCode === status);
  const image = await sharp({
    create: { width: 32, height: 24, channels: 3, background: "red" },
  })
    .withExif({ IFD0: { Artist: "Synthetic private metadata" } })
    .jpeg()
    .toBuffer();
  const upload = (
    key = randomUUID(),
    storage = store,
    body = image,
    type = "image/jpeg",
  ) => materialFileUpload(manager, { ...scope, key }, body, type, storage);
  let first = "";
  await check(
    "shared files normalize images and reconstruct PDFs without active source objects",
    async () => {
      const output = await normalizeMaterial(image, "image");
      const metadata = await sharp(output).metadata();
      assert.equal(metadata.format, "png");
      assert.equal(metadata.exif, undefined);
      assert.equal(metadata.width, 32);
      const doc = await PDFDocument.create();
      doc
        .addPage([200, 200])
        .drawText("Synthetic instructions", { x: 10, y: 100, size: 12 });
      doc.setAuthor("Synthetic private author");
      doc.addJavaScript("synthetic", 'app.alert("fixture")');
      await doc.attach(Buffer.from("synthetic embedded file"), "fixture.txt");
      const source = Buffer.from(await doc.save());
      const pdf = await normalizeMaterial(source, "pdf");
      assert.deepEqual(await normalizeMaterial(source, "pdf"), pdf);
      const cleaned = await PDFDocument.load(pdf);
      assert.equal(cleaned.getPageCount(), 1);
      assert.equal(cleaned.getAuthor(), undefined);
      const pageImages = cleaned.context
        .enumerateIndirectObjects()
        .map(([, object]) => object)
        .filter(
          (object): object is PDFRawStream =>
            object instanceof PDFRawStream &&
            object.dict.get(PDFName.of("Subtype"))?.toString() === "/Image",
        );
      assert.ok(
        pageImages.some((object) =>
          inflateSync(object.contents).some((value) => value < 200),
        ),
        "Reconstruction must retain visible text, not a blank page",
      );
      for (const name of ["Names", "OpenAction", "AA", "AcroForm"])
        assert.equal(cleaned.catalog.get(PDFName.of(name)), undefined);
      assert.equal(
        cleaned
          .getPage(0)
          .node.lookupMaybe(PDFName.of("Annots"), PDFArray)
          ?.size() ?? 0,
        0,
      );
      assert.notDeepEqual(pdf, source);
    },
  );
  await check(
    "file parser rejects malformed, mismatched, oversized and excessive-page inputs",
    async () => {
      assert.throws(() => materialFormat(image, "application/pdf"));
      assert.throws(() => materialFormat(Buffer.alloc(5242881), "image/png"));
      await denied(normalizeMaterial(Buffer.from("%PDF-invalid"), "pdf"), 400);
      await denied(normalizeMaterial(image.subarray(0, 20), "image"), 400);
      const doc = await PDFDocument.create();
      for (let i = 0; i < 6; i++) doc.addPage([100, 100]);
      await denied(
        normalizeMaterial(Buffer.from(await doc.save()), "pdf"),
        400,
      );
      const large = await sharp({
        create: { width: 4001, height: 4001, channels: 3, background: "white" },
      })
        .png()
        .toBuffer();
      await denied(normalizeMaterial(large, "image"), 400);
      const running = normalizeMaterial(image, "image");
      await denied(normalizeMaterial(image, "image"), 503);
      await running;
    },
  );
  await check(
    "managers publish, scoped readers download, private reports remain separate",
    async () => {
      assert.equal((await materialFileList(reader, scope)).canUpload, false);
      await denied(
        materialFileUpload(
          reader,
          { ...scope, key: randomUUID() },
          image,
          "image/jpeg",
          store,
        ),
      );
      await denied(materialFileList(sibling, scope));
      first = (await upload()).id;
      const listing = await materialFileList(reader, scope);
      assert.equal(listing.items.length, 1);
      assert.equal(listing.items[0].mediaType, "image/png");
      assert.equal(listing.canRemove, false);
      const downloaded = await materialFileDownload(
        reader,
        { ...scope, id: first },
        store,
      );
      assert.equal((await sharp(downloaded.bytes).metadata()).exif, undefined);
      assert.notDeepEqual(downloaded.bytes, image);
      assert.equal((await evidenceList(manager, scope)).items.length, 0);
      await denied(evidenceDownload(manager, { ...scope, id: first }, store));
      const report = await evidenceUpload(
        manager,
        { ...scope, key: randomUUID() },
        Buffer.from("Private synthetic report"),
        store,
      );
      await denied(
        materialFileDownload(reader, { ...scope, id: report.id }, store),
      );
      await denied(materialFileRemove(manager, { ...scope, id: report.id }));
      assert.equal((await materialFileList(reader, scope)).items.length, 1);
    },
  );
  await check(
    "file retries are exact, failed storage stays hidden and retry publishes once",
    async () => {
      const key = randomUUID();
      await assert.rejects(
        upload(key, {
          ...store,
          put: async () => {
            throw new Error("synthetic storage failure");
          },
        }),
      );
      assert.equal((await materialFileList(reader, scope)).items.length, 1);
      const result = await upload(key);
      assert.deepEqual(await upload(key), result);
      await denied(
        upload(key, store, await sharp(image).png().toBuffer(), "image/png"),
        409,
      );
      const row = (
        await owner.query(
          "SELECT count(*)::int AS count FROM work_evidence WHERE organization_id=$1 AND request_key=$2",
          [scope.organizationId, key],
        )
      ).rows[0];
      assert.equal(row.count, 1);
      const concurrent = await Promise.allSettled([
        upload(randomUUID()),
        upload(randomUUID()),
      ]);
      assert.ok(concurrent.some((r) => r.status === "fulfilled"));
      for (const r of concurrent)
        if (r.status === "rejected") assert.equal(r.reason.statusCode, 503);
    },
  );
  await check(
    "file audit failure prevents disclosure and publication; damaged storage is rejected",
    async () => {
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async () => {
        throw new Error("synthetic audit failure");
      };
      try {
        await assert.rejects(
          materialFileDownload(reader, { ...scope, id: first }, store),
        );
        await assert.rejects(upload());
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      const key = evidenceObjectKey(scope.organizationId, first, "material"),
        bytes = memory.get(key);
      memory.set(key, Buffer.from("corrupted"));
      await assert.rejects(
        materialFileDownload(reader, { ...scope, id: first }, store),
      );
      memory.set(key, bytes);
    },
  );
  await check(
    "file HTTP/S3 boundaries enforce CSRF, schemas, hierarchy and attachment headers",
    async () => {
      const route = "/api/v1/admin/work-material-files",
        origin = "http://localhost:15173";
      await reader.agent.get(route).query(scope).expect(200);
      await sibling.agent.get(route).query(scope).expect(403);
      await manager.agent
        .post(route)
        .query({ ...scope, key: randomUUID() })
        .set("Content-Type", "image/jpeg")
        .send(image)
        .expect(403);
      const post = () =>
        manager.agent
          .post(route)
          .query({ ...scope, key: randomUUID() })
          .set("Origin", origin)
          .set("X-Admin-Csrf", manager.csrf);
      await post().set("Content-Type", "image/png").send(image).expect(400);
      await post()
        .set("Content-Type", "image/png")
        .send(Buffer.alloc(5242881))
        .expect(413);
      await manager.agent
        .get(route)
        .query({ ...scope, extra: "forbidden" })
        .expect(400);
      const response = await post()
        .set("Content-Type", "image/jpeg")
        .send(image)
        .expect(201);
      const id = response.body.id;
      realKeys.push(evidenceObjectKey(scope.organizationId, id, "material"));
      const downloaded = await reader.agent
        .get(route + "/download")
        .query({ ...scope, id })
        .expect(200);
      assert.match(
        downloaded.headers["content-disposition"],
        /task-material.png/,
      );
      assert.equal(downloaded.headers["cache-control"], "no-store");
      assert.equal(downloaded.headers["x-content-type-options"], "nosniff");
      assert.equal((await sharp(downloaded.body).metadata()).format, "png");
      await reader.agent
        .post(route + "/remove")
        .set("Origin", origin)
        .set("X-Admin-Csrf", reader.csrf)
        .send({ ...scope, id })
        .expect(403);
      await manager.agent
        .post(route + "/remove")
        .set("Origin", origin)
        .set("X-Admin-Csrf", manager.csrf)
        .send({ ...scope, id })
        .expect(200);
      await reader.agent
        .get(route + "/download")
        .query({ ...scope, id })
        .expect(403);
      const document = await PDFDocument.create();
      document.addPage([200, 200]).drawText("Synthetic PDF task instructions");
      document.addJavaScript("synthetic", 'app.alert("fixture")');
      const uploadedPdf = await post()
        .set("Content-Type", "application/pdf")
        .send(Buffer.from(await document.save()))
        .expect(201);
      const pdfId = uploadedPdf.body.id;
      realKeys.push(evidenceObjectKey(scope.organizationId, pdfId, "material"));
      const pdfResponse = await reader.agent
        .get(route + "/download")
        .query({ ...scope, id: pdfId })
        .expect(200);
      assert.match(
        pdfResponse.headers["content-disposition"],
        /task-material.pdf/,
      );
      assert.equal(
        (await PDFDocument.load(pdfResponse.body)).catalog.get(
          PDFName.of("Names"),
        ),
        undefined,
      );
      await materialFileRemove(manager, { ...scope, id: pdfId });
    },
  );
  await check(
    "manager removal immediately hides files and retention purges material objects",
    async () => {
      await denied(materialFileRemove(reader, { ...scope, id: first }));
      await materialFileRemove(manager, { ...scope, id: first });
      await materialFileRemove(manager, { ...scope, id: first });
      await denied(
        materialFileDownload(reader, { ...scope, id: first }, store),
      );
      assert.equal(
        (await materialFileList(reader, scope)).items.some(
          (x: any) => x.id === first,
        ),
        false,
      );
      await purgeWorkEvidence(owner, store);
      assert.equal(
        memory.has(evidenceObjectKey(scope.organizationId, first, "material")),
        false,
      );
    },
  );
  await check(
    "current membership expiry during download audit withholds material bytes",
    async () => {
      const id = (await materialFileList(reader, scope)).items[0].id;
      const grants = (
        await owner.query(
          "SELECT id,valid_until FROM memberships WHERE organization_id=$1 AND user_id=$2 AND status='active'",
          [scope.organizationId, access.accounts[3].memberId],
        )
      ).rows;
      const original = SecurityService.logAuditEventInTransaction;
      SecurityService.logAuditEventInTransaction = async (client, ...rest) => {
        await original.call(SecurityService, client, ...rest);
        await client.query("SELECT pg_sleep(3)");
      };
      try {
        await owner.query(
          "UPDATE memberships SET valid_until=clock_timestamp()+interval '2 seconds' WHERE id=ANY($1::uuid[])",
          [grants.map((g: any) => g.id)],
        );
        await denied(materialFileDownload(reader, { ...scope, id }, store));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
        for (const g of grants)
          await owner.query(
            "UPDATE memberships SET valid_until=$2 WHERE id=$1",
            [g.id, g.valid_until],
          );
      }
    },
  );
  await check(
    "failed publication audit keeps canonical object quarantined and recoverable",
    async () => {
      const key = randomUUID(),
        original = SecurityService.logAuditEventInTransaction;
      let calls = 0;
      SecurityService.logAuditEventInTransaction = async (client, ...rest) => {
        if (++calls === 3) throw new Error("synthetic publication failure");
        return original.call(SecurityService, client, ...rest);
      };
      try {
        await assert.rejects(upload(key));
      } finally {
        SecurityService.logAuditEventInTransaction = original;
      }
      const row = (
        await owner.query(
          "SELECT id,state FROM work_evidence WHERE request_key=$1",
          [key],
        )
      ).rows[0];
      assert.equal(row.state, "pending");
      assert.ok(
        memory.has(evidenceObjectKey(scope.organizationId, row.id, "material")),
      );
      await denied(
        materialFileDownload(reader, { ...scope, id: row.id }, store),
      );
      assert.equal((await upload(key)).id, row.id);
    },
  );
  await check(
    "material lifetime quota remains bounded after removal and is separate from reports",
    async () => {
      const count = Number(
        (
          await owner.query(
            "SELECT count(*) FROM work_evidence WHERE organization_id=$1 AND work_id=$2 AND uploader_id=$3 AND kind='material'",
            [scope.organizationId, scope.workId, access.accounts[2].memberId],
          )
        ).rows[0].count,
      );
      for (let n = count; n < 10; n++) await upload();
      await denied(upload(), 409);
      // Material reservations must not consume the report quota.
      await evidenceUpload(
        manager,
        { ...scope, key: randomUUID() },
        Buffer.from("Another private synthetic report"),
        store,
      );
    },
  );
}
