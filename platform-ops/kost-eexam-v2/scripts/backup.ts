// Sauvegarde complète — §21 de la mission. `VACUUM INTO` produit une copie
// cohérente du fichier SQLite (même pendant une écriture WAL en cours) en
// un seul fichier autonome, horodaté, avec somme de contrôle. Prévu pour
// tourner via cron en production (voir Dockerfile / docs déploiement).
import { mkdirSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";
import { getDb, closeDb } from "../lib/db";
import { BACKUP_POLICY, recordBackupEvent } from "../lib/backup";
import { verifyBackupArtifact } from "../lib/backup-integrity";
import { enforceBackupRetention } from "../lib/backup-retention";

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeError(err: unknown, backupDir: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replaceAll(backupDir, "<backup-dir>");
}

function main() {
  const backupDir = resolve(process.cwd(), process.env.BACKUP_DIR ?? "./data/backups");
  mkdirSync(backupDir, { recursive: true });
  const outFile = resolve(backupDir, `kost-eexam-v2_${timestamp()}.db`);
  const outLabel = basename(outFile);

  const start = Date.now();
  const db = getDb();
  let status: "success" | "failure" = "success";
  let detail = "";
  let sizeBytes: number | null = null;
  let sha256: string | null = null;

  try {
    db.exec(`VACUUM INTO '${outFile.replace(/'/g, "''")}'`);

    // La copie courante ne devient « connue comme bonne » qu'après les deux
    // contrôles SQLite natifs. Un checksum seul ne suffit pas à autoriser la
    // suppression destructive d'anciennes sauvegardes.
    const verification = verifyBackupArtifact(outFile);
    sizeBytes = verification.sizeBytes;
    sha256 = verification.sha256;
    detail = `artifact=${outLabel}; integrity=ok; foreign_keys=ok`;
    console.log(
      `Sauvegarde réussie : ${outLabel} (${sizeBytes} octets, sha256=${sha256.slice(0, 12)}…)`,
    );
  } catch (err) {
    status = "failure";
    detail = safeError(err, backupDir);
    console.error("Échec de la sauvegarde :", detail);

    // Un artefact qui n'a pas passé integrity_check + foreign_key_check ne
    // doit jamais rester sous un nom géré : une exécution future de la
    // rétention pourrait sinon le prendre pour la copie quotidienne la plus
    // récente et supprimer une ancienne copie valide du même jour.
    try {
      rmSync(outFile, { force: true });
    } catch (cleanupErr) {
      console.error("Échec du nettoyage de l'artefact invalide :", safeError(cleanupErr, backupDir));
    }
  }

  // La purge n'est tentée qu'après création + checksum + contrôles SQLite
  // réussis. La copie courante est explicitement protégée par le planificateur
  // de rétention. Un échec de purge déclenche une alerte mais ne supprime pas
  // la nouvelle sauvegarde déjà vérifiée.
  if (status === "success") {
    try {
      const retention = enforceBackupRetention(backupDir, BACKUP_POLICY, outFile);
      detail = `${detail}; retention_deleted=${retention.deleted.length}; retention_kept=${retention.keptCount}`;
      console.log(
        `Rétention sauvegardes : ${retention.deleted.length} supprimée(s), ${retention.keptCount} conservée(s)`,
      );
    } catch (err) {
      status = "failure";
      detail = `${detail}; retention=failed`;
      console.error("Échec de la rétention des sauvegardes :", safeError(err, backupDir));
    }
  }

  const durationSeconds = (Date.now() - start) / 1000;
  recordBackupEvent({
    type: "full_db",
    status,
    size_bytes: sizeBytes,
    sha256,
    duration_seconds: durationSeconds,
    detail,
  });
  closeDb();
  if (status === "failure") process.exit(1);
}

main();
