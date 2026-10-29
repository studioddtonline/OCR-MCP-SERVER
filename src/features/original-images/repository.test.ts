import { strict as assert } from "node:assert";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createTempDirAsync, removeTempDirAsync } from "../../../test/support/temp-dir.js";
import test from "node:test";
import { OriginalImageRepository, compareImageNames } from "./repository.js";
import { ClientSafeError, describeForLog } from "../../shared/errors.js";

async function fixture() {
  const root = await createTempDirAsync("ocr-mcp-original-images-");
  const book = join(root, "Book folder");
  await mkdir(book);
  await writeFile(join(book, "020-021.webp"), Buffer.from("RIFFfake-webp"));
  await writeFile(join(book, "notes.txt"), "not an image");
  return { root, book, cleanup: () => removeTempDirAsync(root) };
}

test("image-name comparator is deterministic in either argument order and preserves natural sorting", () => {
  const forward = compareImageNames("A.png", "a.png");
  const reverse = compareImageNames("a.png", "A.png");
  assert.notEqual(forward, 0, "the code-unit tie-break must distinguish names the Collator considers equal");
  assert.equal(Math.sign(forward), -Math.sign(reverse), "comparison must be antisymmetric regardless of readdir order");
  assert.ok(compareImageNames("page_2.png", "page_10.png") < 0, "numeric ordering keeps page_2 before page_10");
});

test("lists book directories and image files without returning non-image files", async () => {
  const f = await fixture();
  try {
    const repo = new OriginalImageRepository(f.root);
    assert.deepEqual((await repo.listBookDirectories()).directories, ["Book folder"]);
    assert.deepEqual((await repo.listImages("Book folder")).images, [
      { fileName: "020-021.webp", sizeBytes: Buffer.byteLength("RIFFfake-webp") }
    ]);
    await writeFile(join(f.book, "A.png"), Buffer.from("A"));
    await writeFile(join(f.book, "a.png"), Buffer.from("a"));
    const firstPage = await repo.listImages("Book folder", 1, 0);
    assert.deepEqual(firstPage.images.map((image) => image.fileName), ["020-021.webp"]);
    assert.equal(firstPage.nextOffset, 1);
    const secondPage = await repo.listImages("Book folder", 1, firstPage.nextOffset!);
    assert.deepEqual(secondPage.images.map((image) => image.fileName), ["A.png"]);
    assert.equal(secondPage.nextOffset, 2);
    const thirdPage = await repo.listImages("Book folder", 1, secondPage.nextOffset!);
    assert.deepEqual(thirdPage.images.map((image) => image.fileName), ["a.png"]);
    assert.equal(thirdPage.nextOffset, null);
    await repo.checkAtStartup();
  } finally {
    await f.cleanup();
  }
});

test("returns image bytes as base64 with MIME type", async () => {
  const f = await fixture();
  try {
    const repo = new OriginalImageRepository(f.root);
    const image = await repo.getImage("Book folder", "020-021.webp");
    assert.equal(image.mimeType, "image/webp");
    assert.equal(Buffer.from(image.data, "base64").toString(), "RIFFfake-webp");
  } finally {
    await f.cleanup();
  }
});

test("unconfigured and unavailable storage give fixed messages and never expose the local path", async () => {
  const unconfigured = new OriginalImageRepository(undefined);
  await assert.rejects(unconfigured.listBookDirectories(), (error: unknown) => {
    assert.ok(error instanceof ClientSafeError);
    assert.equal(error.message, "Original image storage is not configured");
    return true;
  });
  const f = await fixture();
  try {
    const missingRoot = join(f.root, "missing-mount");
    await assert.rejects(new OriginalImageRepository(missingRoot).listBookDirectories(), (error: unknown) => {
      assert.ok(error instanceof ClientSafeError);
      assert.equal(error.message, "Original image storage is unavailable");
      assert.ok(!error.message.includes(missingRoot));
      assert.ok(describeForLog(error).includes(missingRoot), "the path is kept for the server log");
      return true;
    });
    // ルートがファイルを指している場合も同様
    await writeFile(join(f.root, "a-file"), "x");
    await assert.rejects(new OriginalImageRepository(join(f.root, "a-file")).listBookDirectories(), /Original image storage is unavailable/);
  } finally {
    await f.cleanup();
  }
});

test("not-found errors name only what the caller asked for, not the local path", async () => {
  const f = await fixture();
  try {
    const repo = new OriginalImageRepository(f.root);
    for (const run of [() => repo.listImages("no-such-book"), () => repo.getImage("no-such-book", "x.png"), () => repo.getImage("Book folder", "missing.png")]) {
      await assert.rejects(run(), (error: unknown) => {
        assert.ok(error instanceof ClientSafeError);
        assert.ok(!error.message.includes(f.root), error.message);
        assert.ok(!/ENOENT|realpath|lstat/.test(error.message), error.message);
        return true;
      });
    }
    await assert.rejects(repo.listImages("no-such-book"), /Book directory not found: no-such-book/);
    await assert.rejects(repo.getImage("Book folder", "missing.png"), /Image file not found: missing\.png/);
  } finally {
    await f.cleanup();
  }
});

test("rejects traversal and symbolic-link directories", async () => {
  const f = await fixture();
  const outside = await createTempDirAsync("ocr-mcp-original-outside-");
  try {
    await mkdir(join(outside, "secret"));
    await writeFile(join(outside, "secret", "x.png"), Buffer.from("x"));
    await symlink(join(outside, "secret"), join(f.root, "linked-book"));
    const repo = new OriginalImageRepository(f.root);
    await assert.rejects(repo.listImages("../outside"), /Invalid book directory/);
    await assert.rejects(repo.listImages("linked-book"));
    await assert.rejects(repo.getImage("Book folder", "../x.png"), /Invalid image file name/);
  } finally {
    await f.cleanup();
    await removeTempDirAsync(outside);
  }
});

test("image names with case-insensitive collation ties have deterministic code-unit order", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.book, "A.png"), Buffer.from("A"));
    await writeFile(join(f.book, "a.png"), Buffer.from("a"));
    const repo = new OriginalImageRepository(f.root);
    const names = (await repo.listImages("Book folder")).images.map((image) => image.fileName);
    assert.deepEqual(names, ["020-021.webp", "A.png", "a.png"]);
  } finally {
    await f.cleanup();
  }
});
