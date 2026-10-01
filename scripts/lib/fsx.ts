// Small file helpers for the operator scripts.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function md5File(path: string): string {
  return createHash('md5').update(readFileSync(path)).digest('hex').toUpperCase();
}

/** Every file under root, recursively, as absolute paths (sorted, stable for output). */
export function walkFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  };
  walk(root);
  return out;
}

/** The first file under root whose path relative to root satisfies pick (forward slashes), or undefined. */
export function findFile(root: string, pick: (rel: string) => boolean): string | undefined {
  return walkFiles(root).find((p) => pick(relative(root, p).split(sep).join('/')));
}

/** The first directory named `name` under root (depth-first), or undefined. */
export function findDir(root: string, name: string): string | undefined {
  const walk = (dir: string): string | undefined => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const p = join(dir, e.name);
      if (e.name === name) return p;
      const inner = walk(p);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(root);
}

/** Copy the plain files of src (not subfolders) into dst, creating dst. Returns the file names copied. */
export function copyFlat(src: string, dst: string): string[] {
  mkdirSync(dst, { recursive: true });
  const names: string[] = [];
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (!e.isFile()) continue;
    copyFileSync(join(src, e.name), join(dst, e.name));
    names.push(e.name);
  }
  return names.sort();
}

export function mtimeMs(path: string): number {
  return statSync(path).mtimeMs;
}
