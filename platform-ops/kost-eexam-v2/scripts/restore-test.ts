// Test de restauration RÉEL — §21 de la mission : « une documentation seule
// ne suffit pas ». Restaure la dernière sauvegarde réussie explicitement
// journalisée dans un répertoire temporaire isolé et jetable (jamais un
// chemin partagé avec la production), vérifie son SHA-256 enregistré,
// l'intégrité SQLite native + les clés étrangères + les lignes des tables
// clés, PUIS supprime la copie — que le test réussisse ou échoue.
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { closeDb } from "../lib/db";
import { latestSuccessfulFullDb, recordBackupEvent } from "../lib/backup";
import {
  artifactNameFromDetail,
  assertRecordedSha256,
  verifyBackupArtifact,
} from "../lib/backup-integrity";

const KEY_TABLES = ["users", "companies", "groups", "questions", "assessments", "attempts", "results", "audit_logs"];

function main() {
  const backupDir = resolve(process.cwd(), process.env.BACKUP_DIR ?? "./data/backups");
  const start = Date.now();
  let status: "success" | "failure" = "success";
  let detail = "";
  let isolatedDir: string | null = null;
  let verifiedSha256: string | null = null;

  try {
    // La source de vérité est le journal d'une sauvegarde full_db réussie,
    // jamais le mtime d'un fichier *.db présent dans le répertoire.
    const backupRecord = latestSuccessfulFullDb();
    if (!backupRecord) {
      throw new Error(
        "Aucune sauvegarde réussie avec artifact=<nom> + SHA-256 n'est disponible — exécuter 'pnpm backup' d'abord.",
      );
    }

    const artifactName = artifactNameFromDetail(backupRecord.detail);
    const backupFile = join(backupDir, artifactName);

    // Répertoire isolé, jetable, aucun volume partagé avec la production.
    isolatedDir = mkdtempSync(join(tmpdir(), "kost-eexam-v2-restore-test-"));
    const restoredPath = join(isolatedDir, "restored.db");
    copyFileSync(backupFile, restoredPath);

    // Vérifier la copie réellement restaurée lie le drill aux octets testés,
    // y compris si le fichier source changeait entre sélection et copie.
    const verification = verifyBackupArtifact(restoredPath);
    assertRecordedSha256(verification.sha256, backupRecord.sha256);
    verifiedSha256 = verification.sha256;

    const restored = new DatabaseSync(restoredPath, { readOnly: true });
    const counts: Record<string, number> = {};
    try {
      for (const table of KEY_TABLES) {
        const row = restored.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        counts[table] = row.n;
      }
    } finally {
      restored.close();
    }

    detail = `artifact=${artifactName}; sha256=${verification.sha256.slice(0, 12)}…; integrity=ok; foreign_keys=ok; rows=${Object.entries(counts)
      .map(([table, count]) => `${table}:${count}`)
      .join(",")}`;
    console.log("Test de restauration réussi.");
    console.log(detail);
  } catch (err) {
    status = "failure";
    detail = err instanceof Error ? err.message : String(err);
    console.error("Échec du test de restauration :", detail);
  } finally {
    if (isolatedDir) rmSync(isolatedDir, { recursive: true, force: true });
  }

  const durationSeconds = (Date.now() - start) / 1000;
  recordBackupEvent({
    type: "restore_test",
    status,
    size_bytes: null,
    sha256: verifiedSha256,
    duration_seconds: durationSeconds,
    detail,
  });
  closeDb();
  if (status === "failure") process.exit(1);
}

main();
