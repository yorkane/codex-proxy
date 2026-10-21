import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoRoot as resolveRepoRoot } from "../helpers/repo-root";

/**
 * The wdev manager must stay off the path of every install that did not opt in.
 *
 * The manager layer is a spawn layer: it runs a python CLI, and a management route hands
 * it argv. A user who never enabled the wdevManager block must not merely skip calling it
 * -- the modules must not be reachable through the management graph at all, because a
 * loaded module is code that can be reached by a future refactor. This mirrors
 * tests/lab/core-lab-boundary.test.ts, with the fork's own shape: the routes module and
 * the spawner are both behind a dynamic import gated on the config, and the dispatcher
 * answers 404 before either is imported.
 *
 * The guard walks runtime imports (static + side-effect + re-export; `import type` is
 * erased). Dynamic import() edges are deferred edges and are allowed, because the
 * activation check gates them -- which is exactly the pattern the fork uses. What the
 * guard forbids (and this test proves by construction): a STATIC import of src/wdev/
 * from anything in the management graph except the activation seam.
 */
const repoRoot = resolveRepoRoot();
const ALLOWED_STATIC_EDGE = "src/wdev/activation.ts";
const PROTECTED = [
  "src/server/management-api.ts",
  "src/server/management/config-routes.ts",
] as const;
const WDEV_SPAWNERS = ["src/wdev/manager-cli.ts", "src/wdev/gate.ts", "src/server/management/wdev-routes.ts"] as const;

const IMPORT_RE = /^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']|^\s*import\s+["']([^"']+)["']|^\s*export\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm;
const DYNAMIC_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

function resolveSpec(spec: string, fromFile: string): string | null {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function relative(path: string): string {
  return path.replaceAll("\\", "/").replace(repoRoot.replaceAll("\\", "/") + "/", "");
}

function staticWdevEdges(file: string): string[] {
  const found: string[] = [];
  const visit = (current: string, seen: Set<string>) => {
    if (seen.has(current)) return;
    seen.add(current);
    const source = readFileSync(current, "utf8");
    IMPORT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = IMPORT_RE.exec(source)) !== null) {
      const spec = match[1] ?? match[2] ?? match[3];
      if (!spec) continue;
      const next = resolveSpec(spec, current);
      if (!next) continue;
      const rel = relative(next);
      if (rel.startsWith("src/wdev/")) found.push(`${relative(current)} -> ${rel}`);
      visit(next, seen);
    }
  };
  visit(resolve(repoRoot, file), new Set());
  return found;
}

describe("wdev core boundary", () => {
  test("the management graph reaches src/wdev only through the activation seam", () => {
    const violations: string[] = [];
    for (const file of PROTECTED) {
      for (const edge of staticWdevEdges(file)) {
        if (!edge.endsWith(ALLOWED_STATIC_EDGE)) violations.push(edge);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the dispatcher gates the namespace before importing the routes module", () => {
    const source = readFileSync(resolve(repoRoot, "src/server/management-api.ts"), "utf8");
    const gateAt = source.indexOf("if (!wdevManagerEnabled(ctx.config))");
    const importAt = source.indexOf('import("./management/wdev-routes")');
    expect(gateAt).toBeGreaterThan(-1);
    expect(importAt).toBeGreaterThan(gateAt);
  });

  test("the spawner is imported only from behind the routes module, dynamically", () => {
    for (const file of ["src/server/management-api.ts", "src/server/index.ts", "src/server/lifecycle.ts"]) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      expect(source.includes('from "../../wdev/manager-cli"') || source.includes('from "../wdev/manager-cli"'), file).toBe(false);
    }
    // The spawner is reachable only from the routes module (dynamic) and the tests.
    const routesSource = readFileSync(resolve(repoRoot, "src/server/management/wdev-routes.ts"), "utf8");
    expect(routesSource).toContain('await import("../../wdev/manager-cli")');
  });

  test("the activation seam itself imports no spawner, no fs mutator, no timer", () => {
    // Strip comments first: the seam's doc block explains, by name, the very modules it
    // must not import, and matching prose is not evidence about code (the same lesson
    // gui/tests/sidebar-rows.test.ts records).
    const source = readFileSync(resolve(repoRoot, "src/wdev/activation.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toContain("node:child_process");
    expect(source).not.toContain("node:fs");
    expect(source).not.toContain("setInterval");
    expect(source).not.toContain("Bun.spawn");
    expect(source).not.toContain("manager-cli");
  });

  test("every wdev spawn-layer file stays inside src/wdev", () => {
    for (const file of WDEV_SPAWNERS) {
      expect(existsSync(resolve(repoRoot, file)), file).toBe(true);
    }
  });
});
