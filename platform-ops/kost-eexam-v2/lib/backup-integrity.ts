import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseBackupFilename } from "./backup-retention";

export interface VerifiedBackupArtifact {
  sizeBytes: number;
  sha256: string;
}

/**
 * Vérifie l'artefact SQLite lui-même avant qu'il puisse autoriser une purge
 * destructive d'anciennes sauvegardes. Un hash seul prouve l'identité des
 * octets, pas l'intégrité logique de la base.
 */
export function verifyBackupArtifact(path: string): VerifiedBackupArtifact {
  const buf = readFileSync(path);
  const sha256 = createHash("sha256").update(buf).digest("hex");

  let artifactDb: DatabaseSync | null = null;
  try {
    artifactDb = new DatabaseSync(path, { readOnly: true });

    const integrityRows = artifactDb.prepare("PRAGMA integrity_check").all() as Array<{
      integrity_check?: string;
    }>;
    if (integrityRows.length !== 1 || integrityRows[0]?.integrity_check !== "ok") {
      const result = integrityRows.map((row) => row.integrity_check ?? "unknown").join(", ");
      throw new Error(`PRAGMA integrity_check a échoué : ${result || "aucun résultat"}`);
    }

    const foreignKeyRows = artifactDb.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyRows.length !== 0) {
      throw new Error(`PRAGMA foreign_key_check a détecté ${foreignKeyRows.length} violation(s)`);
    }
  } finally {
    artifactDb?.close();
  }

  return { sizeBytes: buf.byteLength, sha256 };
}

/**
 * Le nom de l'artefact est conservé comme métadonnée non secrète dans le
 * journal de sauvegarde. Le parseur de rétention impose déjà la forme exacte
 * du nom et exclut tout chemin / traversal.
 */
export function artifactNameFromDetail(detail: string | null): string {
  if (!detail) throw new Error("Aucune métadonnée d'artefact dans le journal de sauvegarde");

  const artifactSegments = detail
    .split(";")
    .map((segment) => segment.trim())
    .filter((segment) => segment.startsWith("artifact="));

  if (artifactSegments.length !== 1) {
    throw new Error("Le journal de sauvegarde doit contenir exactement un segment artifact=<nom>");
  }

  const name = artifactSegments[0]!.slice("artifact=".length);
  if (!parseBackupFilename(name)) {
    throw new Error("Le nom d'artefact enregistré n'est pas un nom de sauvegarde KOST géré valide");
  }
  return name;
}

export function assertRecordedSha256(actual: string, expected: string | null): void {
  if (!expected || !/^[0-9a-f]{64}$/i.test(expected)) {
    throw new Error("Le journal de sauvegarde ne contient pas de SHA-256 exploitable");
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error("Le SHA-256 de l'artefact restauré ne correspond pas au journal de sauvegarde");
  }
}

export function assertRecordedSize(actual: number, expected: number | null): void {
  if (!Number.isSafeInteger(expected) || expected === null || expected <= 0) {
    throw new Error("Le journal de sauvegarde ne contient pas de taille d'artefact exploitable");
  }
  if (actual !== expected) {
    throw new Error("La taille de l'artefact restauré ne correspond pas au journal de sauvegarde");
  }
}
