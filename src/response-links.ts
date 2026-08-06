import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXTERNAL_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);
const URL_SCHEME_PATTERN = /^([a-z][a-z\d+.-]*):/i;
const WINDOWS_ABSOLUTE_PATH_PATTERN = /^[a-z]:[\\/]/i;
const HASH_LOCATION_PATTERN = /#L\d+(?:C\d+)?$/i;
const COLON_LOCATION_PATTERN = /:\d+(?::\d+)?$/;

export type ResponseLinkTarget =
  | { kind: "anchor" }
  | { kind: "external"; url: string }
  | { kind: "file"; href: string };

export function classifyResponseLink(href: string): ResponseLinkTarget {
  const trimmedHref = href.trim();
  if (trimmedHref.startsWith("#")) {
    return { kind: "anchor" };
  }

  const scheme = trimmedHref.match(URL_SCHEME_PATTERN)?.[1]?.toLowerCase();
  if (!scheme || WINDOWS_ABSOLUTE_PATH_PATTERN.test(trimmedHref)) {
    return { kind: "file", href: trimmedHref };
  }
  if (scheme === "file") {
    return { kind: "file", href: trimmedHref };
  }
  if (!EXTERNAL_PROTOCOLS.has(`${scheme}:`)) {
    throw new Error(`Links using ${scheme}: are not supported.`);
  }

  const url = new URL(trimmedHref);
  return { kind: "external", url: url.toString() };
}

function decodeFileHref(href: string) {
  if (href.toLowerCase().startsWith("file:")) {
    return fileURLToPath(new URL(href));
  }
  try {
    return decodeURIComponent(href);
  } catch {
    throw new Error("The file link contains invalid URL encoding.");
  }
}

function expandHome(filePath: string, homeFolder: string) {
  if (filePath === "~") {
    return homeFolder;
  }
  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith("~/")) {
    return path.join(homeFolder, filePath.slice(2));
  }
  return filePath;
}

function filePathCandidates(href: string, homeFolder: string) {
  const decodedHref = expandHome(decodeFileHref(href), homeFolder);
  const withoutHashLocation = decodedHref.replace(HASH_LOCATION_PATTERN, "");
  const withoutColonLocation = withoutHashLocation.replace(
    COLON_LOCATION_PATTERN,
    "",
  );
  return [...new Set([decodedHref, withoutHashLocation, withoutColonLocation])];
}

export function resolveResponseFilePath(
  href: string,
  sourceFolder: string | undefined,
  homeFolder: string,
) {
  const baseFolder = sourceFolder ?? homeFolder;
  if (!path.isAbsolute(baseFolder)) {
    throw new Error("The response link has an invalid working directory.");
  }
  if (!fs.statSync(baseFolder, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error("The response link's working directory no longer exists.");
  }

  for (const candidate of filePathCandidates(href, homeFolder)) {
    const resolvedPath = path.resolve(baseFolder, candidate);
    if (fs.statSync(resolvedPath, { throwIfNoEntry: false })) {
      return resolvedPath;
    }
  }
  throw new Error("The linked file no longer exists.");
}
