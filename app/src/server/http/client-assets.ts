// Bun.build で browser entry point をまとめ、HTTP route から配信できる形にする
import { resolve } from "node:path";

export interface ClientAssets {
  indexHtml: string;
  scriptPath: string;
  stylePath: string | null;
  files: ReadonlyMap<string, Bun.BuildArtifact>;
}

/** HTML 内の asset URL を same-origin の絶対 path へ検証して変換する */
function assetReference(document: string, expression: RegExp): string | null {
  const reference = expression.exec(document)?.[1];

  if (!reference) {
    return null;
  }

  const url = new URL(reference, "http://client.local/");

  if (url.origin !== "http://client.local" || url.pathname.startsWith("/../")) {
    throw new TypeError("The client build contains an invalid asset reference");
  }

  return url.pathname;
}

/** HTML、script、style を build し、URL ごとの artifact map を作る */
export async function buildClientAssets(): Promise<ClientAssets> {
  const clientEntry = resolve(import.meta.dir, "../../client/index.html");
  const result = await Bun.build({
    entrypoints: [clientEntry],
    target: "browser",
  });

  if (!result.success) {
    throw new Error("The browser client could not be built");
  }

  const indexArtifact = result.outputs.find((output) =>
    output.path.endsWith("index.html"),
  );

  if (!indexArtifact) {
    throw new Error("The browser client build has no HTML entry point");
  }

  const indexHtml = await indexArtifact.text();
  const scriptPath = assetReference(
    indexHtml,
    /<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*><\/script>/i,
  );
  const stylePath = assetReference(
    indexHtml,
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/i,
  );

  if (!scriptPath) {
    throw new Error("The browser client build has no entry script");
  }

  const files = new Map<string, Bun.BuildArtifact>();

  for (const output of result.outputs) {
    const path = new URL(output.path, "http://client.local/").pathname;

    files.set(path, output);
  }

  if (!files.has(scriptPath) || (stylePath && !files.has(stylePath))) {
    throw new Error("The browser client build references a missing asset");
  }

  return { indexHtml, scriptPath, stylePath, files };
}
