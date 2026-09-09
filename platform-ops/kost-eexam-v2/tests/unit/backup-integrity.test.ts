import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, test } from "node:test";
import {
  artifactNameFromDetail,
  assertRecordedSha256,
  assertRecordedSize,
  verifyBackupArtifact,
} from "../../lib/backup-integrity";

function backupName(): string {
  return "kost-eexam-v2_2026-09-09T12-00-00-000Z.db";
}

describe("Intégrité et provenance des artefacts de sauvegarde", () => {
  test("accepte une base SQLite intègre sans violation de clé étrangère", () => {
    const dir = mkdtempSync(join(tmpdir(), "kost-backup-integrity-"));
    try {
      const path = join(dir, backupName());
      const db = new DatabaseSync(path);
      db.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
        INSERT INTO parent(id) VALUES (1);
        INSERT INTO child(id, parent_id) VALUES (1, 1);
      `);
      db.close();

      const verified = verifyBackupArtifact(path);
      assert.match(verified.sha256, /^[0-9a-f]{64}$/);
      assert.ok(verified.sizeBytes > 0);
      assert.doesNotThrow(() => assertRecordedSize(verified.sizeBytes, verified.sizeBytes));
      assert.doesNotThrow(() => assertRecordedSha256(verified.sha256, verified.sha256));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuse une base qui contient une violation de clé étrangère", () => {
    const dir = mkdtempSync(join(tmpdir(), "kost-backup-integrity-fk-"));
    try {
      const path = join(dir, backupName());
      const db = new DatabaseSync(path);
      db.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE parent (id INTEGER PRIMARY KEY);
        CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
        INSERT INTO child(id, parent_id) VALUES (1, 999);
      `);
      db.close();

      assert.throws(() => verifyBackupArtifact(path), /foreign_key_check/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuse un fichier non-SQLite comme artefact connu comme bon", () => {
    const dir = mkdtempSync(join(tmpdir(), "kost-backup-integrity-corrupt-"));
    try {
      const path = join(dir, backupName());
      writeFileSync(path, "not a sqlite database");
      assert.throws(() => verifyBackupArtifact(path));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("extrait uniquement un nom d'artefact KOST géré et sans chemin", () => {
    const name = backupName();
    assert.equal(
      artifactNameFromDetail(`artifact=${name}; integrity=ok; foreign_keys=ok; retention_deleted=0`),
      name,
    );

    assert.throws(() => artifactNameFromDetail(null));
    assert.throws(() => artifactNameFromDetail(`artifact=../${name}`));
    assert.throws(() => artifactNameFromDetail(`artifact=${name}; artifact=${name}`));
    assert.throws(() => artifactNameFromDetail("artifact=restore-test.db"));
  });

  test("refuse un SHA-256 absent, mal formé ou différent", () => {
    const actual = "a".repeat(64);
    assert.throws(() => assertRecordedSha256(actual, null));
    assert.throws(() => assertRecordedSha256(actual, "abc"));
    assert.throws(() => assertRecordedSha256(actual, "b".repeat(64)));
    assert.doesNotThrow(() => assertRecordedSha256(actual, "A".repeat(64)));
  });

  test("refuse une taille enregistrée absente, invalide ou différente", () => {
    assert.throws(() => assertRecordedSize(4096, null));
    assert.throws(() => assertRecordedSize(4096, 0));
    assert.throws(() => assertRecordedSize(4096, -1));
    assert.throws(() => assertRecordedSize(4096, 4096.5));
    assert.throws(() => assertRecordedSize(4096, 8192));
    assert.doesNotThrow(() => assertRecordedSize(4096, 4096));
  });
});
