import * as path from "node:path";

/** Whether `file` is inside `root`: a path comparison, not a string prefix (so
 *  `/work/app-old/x` is not under `/work/app`), and case-insensitive where the
 *  platform's paths are (`path.relative` follows the platform). `root` itself is
 *  not inside `root`. */
export function isInside(root: string, file: string): boolean {
  const rel = path.relative(root, file);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
