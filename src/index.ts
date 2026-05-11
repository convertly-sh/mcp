#!/usr/bin/env node

import { createReadStream, type Stats } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import JSZip from "jszip";
import { z } from "zod";

type FileEntry = {
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  modifiedAt: string;
  mediaKind: "image" | "video" | "audio" | "archive" | "document" | "other";
};

type DocEntry = {
  slug: string;
  title: string;
  url: string;
  description: string;
  keywords: string[];
};

const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif", ".tif", ".tiff", ".heif", ".heic"]);
const videoExtensions = new Set([".mp4", ".mov", ".webm", ".mkv", ".avi"]);
const audioExtensions = new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"]);
const archiveExtensions = new Set([".zip", ".tar", ".gz", ".tgz", ".7z", ".rar", ".bz2", ".xz"]);
const documentExtensions = new Set([".pdf", ".doc", ".docx", ".txt", ".csv", ".md", ".json"]);

const roots = readRoots();
const apiKey = process.env.CONVERTLY_API_KEY ?? "";
const baseUrl = (process.env.CONVERTLY_BASE_URL ?? "https://convertly.sh").replace(/\/$/, "");
const docsBaseUrl = (process.env.CONVERTLY_DOCS_URL ?? "https://docs.convertly.sh").replace(/\/$/, "");
const convertlyDocs = createDocsIndex(docsBaseUrl);

const server = new McpServer({
  name: "convertly-local",
  version: "0.1.0",
});

server.registerTool(
  "list_convertly_docs",
  {
    title: "List Convertly Docs",
    description: "List available Convertly documentation pages for API, dashboard, storage, MCP, webhooks, and billing guidance.",
  },
  async () => jsonResult({ docsBaseUrl, docs: convertlyDocs }),
);

server.registerTool(
  "search_convertly_docs",
  {
    title: "Search Convertly Docs",
    description: "Search Convertly documentation pages by topic before calling API or filesystem tools.",
    inputSchema: {
      query: z.string().min(1),
      limit: z.number().int().min(1).max(20).default(8),
    },
  },
  async ({ query, limit }) => {
    const results = searchDocs(query, limit);
    return jsonResult({ query, count: results.length, results });
  },
);

server.registerTool(
  "get_convertly_doc",
  {
    title: "Get Convertly Doc",
    description: "Fetch a Convertly documentation page by slug or URL and return readable text.",
    inputSchema: {
      slugOrUrl: z.string().min(1),
      maxCharacters: z.number().int().min(1000).max(20000).default(8000),
    },
  },
  async ({ slugOrUrl, maxCharacters }) => {
    const doc = resolveDoc(slugOrUrl);
    const response = await fetch(doc.url, {
      headers: { accept: "text/html,text/markdown,text/plain" },
    });
    if (!response.ok) throw new Error(`Could not fetch Convertly doc ${doc.url}: ${response.status}`);
    const raw = await response.text();
    const text = readableText(raw).slice(0, maxCharacters);
    return jsonResult({ ...doc, text, truncated: raw.length > maxCharacters });
  },
);

server.registerTool(
  "list_roots",
  {
    title: "List Approved Roots",
    description: "List folders this Convertly MCP server is allowed to read and write.",
  },
  async () => jsonResult({ roots }),
);

server.registerTool(
  "scan_folder",
  {
    title: "Scan Folder",
    description: "Scan an approved folder and return files with size, modified date, and media category.",
    inputSchema: {
      folder: z.string(),
      recursive: z.boolean().default(false),
      limit: z.number().int().min(1).max(2000).default(300),
    },
  },
  async ({ folder, recursive, limit }) => {
    const root = resolveAllowed(folder);
    const files = await scanFolder(root, recursive, limit);
    return jsonResult({ folder: root, count: files.length, files });
  },
);

server.registerTool(
  "plan_organize_folder",
  {
    title: "Plan Folder Organization",
    description: "Create a dry-run plan that groups files into Images, Videos, Audio, Archives, Documents, and Other folders.",
    inputSchema: {
      folder: z.string(),
      recursive: z.boolean().default(false),
      olderThanDays: z.number().int().min(0).optional(),
      limit: z.number().int().min(1).max(2000).default(500),
    },
  },
  async ({ folder, recursive, olderThanDays, limit }) => {
    const root = resolveAllowed(folder);
    const files = await scanFolder(root, recursive, limit);
    const cutoff = olderThanDays ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null;
    const moves = files
      .filter((file) => (cutoff ? new Date(file.modifiedAt).getTime() < cutoff : true))
      .map((file) => {
        const targetDir = path.join(root, labelForKind(file.mediaKind));
        return {
          from: file.path,
          to: path.join(targetDir, file.name),
          sizeBytes: file.sizeBytes,
          mediaKind: file.mediaKind,
        };
      })
      .filter((move) => move.from !== move.to);

    return jsonResult({ dryRun: true, root, moveCount: moves.length, moves });
  },
);

server.registerTool(
  "move_files",
  {
    title: "Move Files",
    description: "Move approved files to approved destinations. Requires confirm=true and creates destination folders.",
    inputSchema: {
      moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1),
      confirm: z.boolean().default(false),
      overwrite: z.boolean().default(false),
    },
  },
  async ({ moves, confirm, overwrite }) => {
    const resolved = moves.map((move) => ({
      from: resolveAllowed(move.from),
      to: resolveAllowed(move.to),
    }));
    if (!confirm) return jsonResult({ dryRun: true, wouldMove: resolved, note: "Call again with confirm=true to move files." });

    const moved: Array<{ from: string; to: string }> = [];
    for (const move of resolved) {
      const sourceStat = await stat(move.from);
      if (!sourceStat.isFile()) throw new Error(`Refusing to move non-file path: ${move.from}`);
      if (!overwrite && await exists(move.to)) throw new Error(`Destination already exists: ${move.to}`);
      await mkdir(path.dirname(move.to), { recursive: true });
      await rename(move.from, move.to);
      moved.push(move);
    }
    return jsonResult({ movedCount: moved.length, moved });
  },
);

server.registerTool(
  "create_archive",
  {
    title: "Create ZIP Archive",
    description: "Create a ZIP archive from approved files or all files in an approved folder. Does not delete originals.",
    inputSchema: {
      outputPath: z.string(),
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      recursive: z.boolean().default(false),
      olderThanDays: z.number().int().min(0).optional(),
      includeMediaOnly: z.boolean().default(false),
      limit: z.number().int().min(1).max(5000).default(1000),
    },
  },
  async ({ outputPath, files, folder, recursive, olderThanDays, includeMediaOnly, limit }) => {
    const output = resolveAllowed(outputPath);
    if (!output.toLowerCase().endsWith(".zip")) throw new Error("outputPath must end with .zip");

    const inputs = files?.length
      ? files.map((item) => resolveAllowed(item))
      : folder
        ? (await scanFolder(resolveAllowed(folder), recursive, limit)).map((item) => item.path)
        : [];

    if (!inputs.length) throw new Error("Provide files or folder.");

    const cutoff = olderThanDays ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null;
    const selected: FileEntry[] = [];
    for (const input of inputs) {
      const s = await stat(input);
      if (!s.isFile()) continue;
      const entry = toEntry(input, s);
      if (cutoff && new Date(entry.modifiedAt).getTime() >= cutoff) continue;
      if (includeMediaOnly && !["image", "video", "audio"].includes(entry.mediaKind)) continue;
      selected.push(entry);
      if (selected.length >= limit) break;
    }

    const zip = new JSZip();
    for (const file of selected) {
      zip.file(file.name, createReadStream(file.path));
    }
    await mkdir(path.dirname(output), { recursive: true });
    const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 } });
    await writeFile(output, buffer);
    return jsonResult({ outputPath: output, archivedCount: selected.length, sizeBytes: buffer.byteLength });
  },
);

server.registerTool(
  "convert_media",
  {
    title: "Convert Media",
    description: "Convert approved local media files using the Convertly API and write results locally.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      format: z.string().min(1),
      recursive: z.boolean().default(false),
      compression: z.number().int().min(1).max(100).default(82),
      resize: z.string().optional(),
      resizeWidth: z.number().int().min(1).optional(),
      resizeHeight: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, format, recursive, compression, resize, resizeWidth, resizeHeight, limit }) => {
    if (!apiKey) throw new Error("CONVERTLY_API_KEY is required for conversion.");
    const outputDir = resolveAllowed(outputFolder);
    const inputs = files?.length
      ? files.map((item) => resolveAllowed(item))
      : folder
        ? (await scanFolder(resolveAllowed(folder), recursive, limit)).filter((item) => ["image", "video", "audio", "archive", "document"].includes(item.mediaKind)).map((item) => item.path)
        : [];
    if (!inputs.length) throw new Error("Provide media files or a folder.");

    await mkdir(outputDir, { recursive: true });
    const converted: Array<{ from: string; to: string; originalBytes: number; outputBytes: number }> = [];

    for (const input of inputs.slice(0, limit)) {
      const s = await stat(input);
      if (!s.isFile()) continue;
      const entry = toEntry(input, s);
      const buffer = await convertFile(input, {
        format,
        compression,
        resize,
        resizeWidth,
        resizeHeight,
      });
      const target = uniqueOutputPath(path.join(outputDir, `${path.basename(entry.name, entry.extension)}.${format}`));
      await writeFile(target, buffer);
      converted.push({ from: input, to: target, originalBytes: entry.sizeBytes, outputBytes: buffer.byteLength });
    }

    return jsonResult({ convertedCount: converted.length, converted });
  },
);

server.registerTool(
  "compress_media",
  {
    title: "Compress Media",
    description: "Compress approved local image, video, or audio files using the Convertly API and write results locally.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      mode: z.enum(["quality", "target-size"]).default("quality"),
      quality: z.number().int().min(1).max(100).default(82),
      targetBytes: z.number().int().min(1).optional(),
      lossless: z.boolean().default(false),
      stripMetadata: z.boolean().default(true),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, mode, quality, targetBytes, lossless, stripMetadata, limit }) => {
    if (!apiKey) throw new Error("CONVERTLY_API_KEY is required for compression.");
    const outputDir = resolveAllowed(outputFolder);
    const inputs = files?.length
      ? files.map((item) => resolveAllowed(item))
      : folder
        ? (await scanFolder(resolveAllowed(folder), recursive, limit)).filter((item) => ["image", "video", "audio"].includes(item.mediaKind)).map((item) => item.path)
        : [];
    if (!inputs.length) throw new Error("Provide image, video, or audio files or a folder.");

    await mkdir(outputDir, { recursive: true });
    const compressed: Array<{ from: string; to: string; originalBytes: number; outputBytes: number }> = [];

    for (const input of inputs.slice(0, limit)) {
      const s = await stat(input);
      if (!s.isFile()) continue;
      const entry = toEntry(input, s);
      const buffer = await compressFile(input, {
        mode,
        quality,
        targetBytes,
        lossless,
        stripMetadata,
      });
      const target = uniqueOutputPath(path.join(outputDir, entry.name));
      await writeFile(target, buffer);
      compressed.push({ from: input, to: target, originalBytes: entry.sizeBytes, outputBytes: buffer.byteLength });
    }

    return jsonResult({ compressedCount: compressed.length, compressed });
  },
);

server.registerTool(
  "convert_images_to_webp",
  {
    title: "Convert Images To WebP",
    description: "Convenience wrapper around convert_media for converting approved local images to WebP.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      quality: z.number().int().min(1).max(100).default(82),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, quality, limit }) => {
    if (!apiKey) throw new Error("CONVERTLY_API_KEY is required for conversion.");
    const outputDir = resolveAllowed(outputFolder);
    const inputs = files?.length
      ? files.map((item) => resolveAllowed(item))
      : folder
        ? (await scanFolder(resolveAllowed(folder), recursive, limit)).filter((item) => item.mediaKind === "image").map((item) => item.path)
        : [];
    if (!inputs.length) throw new Error("Provide image files or a folder.");

    await mkdir(outputDir, { recursive: true });
    const converted: Array<{ from: string; to: string; originalBytes: number; outputBytes: number }> = [];

    for (const input of inputs.slice(0, limit)) {
      const s = await stat(input);
      if (!s.isFile()) continue;
      const entry = toEntry(input, s);
      if (entry.mediaKind !== "image") continue;
      const buffer = await convertFile(input, { format: "webp", compression: quality });
      const target = uniqueOutputPath(path.join(outputDir, `${path.basename(entry.name, entry.extension)}.webp`));
      await writeFile(target, buffer);
      converted.push({ from: input, to: target, originalBytes: entry.sizeBytes, outputBytes: buffer.byteLength });
    }

    return jsonResult({ convertedCount: converted.length, converted });
  },
);

server.registerTool(
  "delete_files",
  {
    title: "Delete Files",
    description: "Delete approved files. Requires confirm=true. Prefer calling scan_folder or plan_organize_folder first.",
    inputSchema: {
      files: z.array(z.string()).min(1),
      confirm: z.boolean().default(false),
    },
  },
  async ({ files, confirm }) => {
    const targets = files.map((item) => resolveAllowed(item));
    if (!confirm) return jsonResult({ dryRun: true, wouldDelete: targets, note: "Call again with confirm=true to delete." });
    for (const target of targets) {
      const s = await stat(target);
      if (!s.isFile()) throw new Error(`Refusing to delete non-file path: ${target}`);
      await rm(target);
    }
    return jsonResult({ deletedCount: targets.length, deleted: targets });
  },
);

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

function readRoots() {
  const raw = process.env.CONVERTLY_MCP_ROOTS;
  const values = raw?.trim()
    ? raw.split(process.platform === "win32" ? ";" : ":")
    : [process.cwd()];

  return values
    .map((item) => item.replace(/^~(?=$|[\\/])/, homedir()))
    .map((item) => path.resolve(item))
    .filter(Boolean);
}

function resolveAllowed(input: string) {
  const resolved = path.resolve(input.replace(/^~(?=$|[\\/])/, homedir()));
  const allowed = roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
  if (!allowed) throw new Error(`Path is outside approved roots: ${resolved}`);
  return resolved;
}

async function scanFolder(folder: string, recursive: boolean, limit: number) {
  const out: FileEntry[] = [];
  await walk(folder, recursive, out, limit);
  return out;
}

async function walk(folder: string, recursive: boolean, out: FileEntry[], limit: number) {
  const entries = await readdir(folder, { withFileTypes: true });
  for (const entry of entries) {
    if (out.length >= limit) return;
    const fullPath = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      if (recursive) await walk(fullPath, recursive, out, limit);
      continue;
    }
    if (!entry.isFile()) continue;
    out.push(toEntry(fullPath, await stat(fullPath)));
  }
}

function toEntry(filePath: string, s: Stats): FileEntry {
  const extension = path.extname(filePath).toLowerCase();
  return {
    path: filePath,
    name: path.basename(filePath),
    extension,
    sizeBytes: s.size,
    modifiedAt: s.mtime.toISOString(),
    mediaKind: kindForExtension(extension),
  };
}

function kindForExtension(extension: string): FileEntry["mediaKind"] {
  if (imageExtensions.has(extension)) return "image";
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  if (archiveExtensions.has(extension)) return "archive";
  if (documentExtensions.has(extension)) return "document";
  return "other";
}

function labelForKind(kind: FileEntry["mediaKind"]) {
  switch (kind) {
    case "image":
      return "Images";
    case "video":
      return "Videos";
    case "audio":
      return "Audio";
    case "archive":
      return "Archives";
    case "document":
      return "Documents";
    default:
      return "Other";
  }
}

async function exists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function convertFile(
  filePath: string,
  options: {
    format: string;
    compression?: number;
    resize?: string;
    resizeWidth?: number;
    resizeHeight?: number;
  },
) {
  const form = new FormData();
  const data = await readFile(filePath);
  form.append("files", new Blob([data]), path.basename(filePath));
  form.append("format", options.format);
  if (options.compression !== undefined) form.append("compression", String(options.compression));
  if (options.resize) form.append("resize", options.resize);
  if (options.resizeWidth !== undefined) form.append("resizeWidth", String(options.resizeWidth));
  if (options.resizeHeight !== undefined) form.append("resizeHeight", String(options.resizeHeight));
  form.append("saveToStorage", "false");

  const response = await fetch(`${baseUrl}/api/convert`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const payload = await response.json() as {
    files?: Array<{ downloadUrl?: string; filename?: string }>;
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? `Convertly API returned ${response.status}`);
  const first = payload.files?.[0];
  if (!first?.downloadUrl) throw new Error("Convertly API did not return a converted file.");
  if (first.downloadUrl.startsWith("data:")) {
    const comma = first.downloadUrl.indexOf(",");
    return Buffer.from(first.downloadUrl.slice(comma + 1), "base64");
  }
  const fileResponse = await fetch(first.downloadUrl);
  if (!fileResponse.ok) throw new Error(`Could not download converted file: ${fileResponse.status}`);
  return Buffer.from(await fileResponse.arrayBuffer());
}

async function compressFile(
  filePath: string,
  options: {
    mode: "quality" | "target-size";
    quality?: number;
    targetBytes?: number;
    lossless?: boolean;
    stripMetadata?: boolean;
  },
) {
  const form = new FormData();
  const data = await readFile(filePath);
  form.append("files", new Blob([data]), path.basename(filePath));
  form.append("mode", options.mode);
  if (options.quality !== undefined) form.append("quality", String(options.quality));
  if (options.targetBytes !== undefined) form.append("targetBytes", String(options.targetBytes));
  if (options.lossless !== undefined) form.append("lossless", options.lossless ? "true" : "false");
  if (options.stripMetadata !== undefined) form.append("stripMetadata", options.stripMetadata ? "true" : "false");
  form.append("saveToStorage", "false");

  const response = await fetch(`${baseUrl}/api/compress`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const payload = await response.json() as {
    files?: Array<{ downloadUrl?: string; filename?: string }>;
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? `Convertly API returned ${response.status}`);
  const first = payload.files?.[0];
  if (!first?.downloadUrl) throw new Error("Convertly API did not return a compressed file.");
  if (first.downloadUrl.startsWith("data:")) {
    const comma = first.downloadUrl.indexOf(",");
    return Buffer.from(first.downloadUrl.slice(comma + 1), "base64");
  }
  const fileResponse = await fetch(first.downloadUrl);
  if (!fileResponse.ok) throw new Error(`Could not download compressed file: ${fileResponse.status}`);
  return Buffer.from(await fileResponse.arrayBuffer());
}

function uniqueOutputPath(target: string) {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function createDocsIndex(origin: string): DocEntry[] {
  const page = (slug: string, title: string, description: string, keywords: string[] = []) => ({
    slug,
    title,
    url: `${origin}/${slug}`,
    description,
    keywords,
  });

  return [
    page("", "Overview", "Start here for Convertly concepts, authentication, and the main API surfaces.", ["quickstart", "overview", "start"]),
    page("quickstart", "Quickstart", "Make your first authenticated Convertly API request.", ["api key", "curl", "sdk"]),
    page("authentication", "Authentication", "Use Convertly API keys with Bearer auth or x-api-key headers.", ["api key", "auth", "security"]),
    page("docs/sdk", "SDK", "Use the Convertly JavaScript SDK for conversion, compression, jobs, storage, and transfer workflows.", ["javascript", "typescript", "sdk"]),
    page("docs/php-sdk", "PHP SDK", "Use Convertly from PHP applications.", ["php", "sdk"]),
    page("docs/mcp-agents", "MCP for AI Agents", "Connect Convertly tools and approved local folders to MCP-compatible AI clients.", ["mcp", "claude", "chatgpt", "cursor", "agents"]),
    page("docs/wordpress-plugin", "WordPress Plugin", "Optimize WordPress media with Convertly.", ["wordpress", "plugin", "media library"]),
    page("docs/media-conversion", "Media Conversion", "Convert images, video, audio, documents, and archives through the Convertly API.", ["convert", "formats", "image", "video", "audio"]),
    page("docs/media-tools", "Media Tools", "Use thumbnails, watermarks, PDF previews, metadata tools, trimming, GIFs, and storyboards.", ["thumbnail", "watermark", "pdf", "metadata", "trim"]),
    page("docs/archive-api", "Archive API", "Create, inspect, and work with archive files.", ["zip", "archive", "tar"]),
    page("docs/workflows", "Workflows", "Build reusable media workflows for repeatable processing.", ["workflow", "automation"]),
    page("docs/use-cases", "Use Cases", "Common media automation patterns for products, teams, and agents.", ["examples", "use cases"]),
    page("docs/async-processing", "Async Processing", "Run longer media work with jobs, polling, and webhooks.", ["jobs", "async", "queue"]),
    page("docs/files-and-storage", "Files and Storage", "Store, organize, retrieve, and manage files in Convertly Storage.", ["storage", "files", "folders"]),
    page("docs/transfer-api", "Transfer API", "Fetch public file URLs and return them or save them to Convertly Storage.", ["transfer", "move", "remote url", "storage"]),
    page("docs/webhooks", "Webhooks", "Receive Convertly events when jobs and workflows complete.", ["webhook", "events"]),
    page("docs/currency-conversion", "Currency Conversion", "Convert currencies through Convertly utility APIs.", ["currency", "fx", "rates"]),
    page("limits", "Limits", "Plan limits, quotas, and usage controls.", ["pricing", "quota", "limits", "overage"]),
    page("errors", "Errors", "Understand Convertly API error shapes and status codes.", ["errors", "status codes"]),
    page("guides/media-conversion", "Media Conversion Guide", "Design reliable media conversion flows.", ["guide", "convert"]),
    page("guides/media-tools", "Media Tools Guide", "Apply specialized tools in production workflows.", ["guide", "tools"]),
    page("guides/archive-api", "Archive API Guide", "Build archive automation with Convertly.", ["guide", "archive"]),
    page("guides/workflows", "Workflows Guide", "Compose and run multi-step media automation.", ["guide", "workflow"]),
    page("guides/wordpress-media-optimization", "WordPress Media Optimization", "Optimize WordPress uploads with Convertly.", ["guide", "wordpress"]),
    page("guides/async-jobs", "Async Jobs Guide", "Use background jobs for larger files and longer-running media tasks.", ["guide", "jobs"]),
    page("guides/currency", "Currency Guide", "Use Convertly for currency conversion flows.", ["guide", "currency"]),
    page("guides/webhooks", "Webhooks Guide", "Secure and operate webhook integrations.", ["guide", "webhooks"]),
  ];
}

function searchDocs(query: string, limit: number) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return convertlyDocs
    .map((doc) => {
      const haystack = [doc.slug, doc.title, doc.description, ...doc.keywords].join(" ").toLowerCase();
      const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 1 : 0), 0);
      return { doc, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.doc.title.localeCompare(b.doc.title))
    .slice(0, limit)
    .map((item) => item.doc);
}

function resolveDoc(slugOrUrl: string) {
  const value = slugOrUrl.trim();
  const normalized = value.replace(/^\/+/, "").replace(/\/$/, "");
  const existing = convertlyDocs.find((doc) => doc.slug === normalized || doc.url === value || doc.url.replace(/\/$/, "") === value.replace(/\/$/, ""));
  if (existing) return existing;
  if (/^https?:\/\//i.test(value)) {
    return {
      slug: value,
      title: value,
      url: value,
      description: "Custom Convertly documentation URL.",
      keywords: [],
    };
  }
  return {
    slug: normalized,
    title: normalized || "Overview",
    url: `${docsBaseUrl}/${normalized}`,
    description: "Convertly documentation page.",
    keywords: [],
  };
}

function readableText(raw: string) {
  return raw
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function jsonResult(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}
