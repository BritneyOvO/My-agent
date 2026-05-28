import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export async function ensureDir(dirPath: string) {
  mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  const content = readFileSync(filePath, "utf8");
  return JSON.parse(content) as T;
}

export async function writeJsonFile(filePath: string, value: unknown) {
  await ensureDir(path.dirname(filePath));
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
