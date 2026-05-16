#!/usr/bin/env node

import { createReadStream, type Stats } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
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
const docsBaseUrl = "https://docs.convertly.sh";
const convertlyDocs = createDocsIndex(docsBaseUrl);

const isHttpMode = !!process.env.CONVERTLY_MCP_HTTP_PORT;

const server = new McpServer({
  name: isHttpMode ? "convertly-remote" : "convertly-local",
  version: "0.2.0",
});

function assertLocalMode() {
  if (isHttpMode) throw new Error("This tool requires the local stdio MCP server. It cannot access your computer's filesystem over HTTP. Run the server locally to use filesystem tools.");
}

/* ------------------------------------------------------------------ */
/*  Shared helpers                                                      */
/* ------------------------------------------------------------------ */

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
    case "image": return "Images";
    case "video": return "Videos";
    case "audio": return "Audio";
    case "archive": return "Archives";
    case "document": return "Documents";
    default: return "Other";
  }
}

async function exists(target: string) {
  try { await stat(target); return true; } catch { return false; }
}

function uniqueOutputPath(target: string) {
  const parsed = path.parse(target);
  return path.join(parsed.dir, `${parsed.name}-${Date.now()}${parsed.ext}`);
}

function jsonResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

async function apiFetch(endpoint: string, init?: RequestInit) {
  const url = endpoint.startsWith("http") ? endpoint : `${baseUrl}${endpoint}`;
  const response = await fetch(url, {
    ...(init ?? {}),
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(data.error ?? `API error ${response.status}`);
  return data;
}

async function downloadToBuffer(url: string): Promise<Buffer> {
  if (url.startsWith("data:")) {
    const comma = url.indexOf(",");
    return Buffer.from(url.slice(comma + 1), "base64");
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

async function resolveMediaInputs(
  files: string[] | undefined,
  folder: string | undefined,
  recursive: boolean,
  limit: number,
  acceptKinds?: string[],
) {
  const inputs = files?.length
    ? files.map((item) => resolveAllowed(item))
    : folder
      ? (await scanFolder(resolveAllowed(folder), recursive, limit)).filter((item) => !acceptKinds || acceptKinds.includes(item.mediaKind)).map((item) => item.path)
      : [];
  if (!inputs.length) throw new Error("Provide media files or a folder.");
  return inputs.slice(0, limit);
}

async function postMediaFile(endpoint: string, filePath: string, extraParams: Record<string, string>) {
  const form = new FormData();
  const data = await readFile(filePath);
  form.append("files", new Blob([data]), path.basename(filePath));
  for (const [key, value] of Object.entries(extraParams)) {
    if (value !== undefined && value !== null && value !== "") form.append(key, String(value));
  }
  form.append("saveToStorage", "false");

  const response = await fetch(`${baseUrl}${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });

  const payload = await response.json() as {
    files?: Array<{ downloadUrl?: string; filename?: string }>;
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error ?? `API returned ${response.status}`);
  const first = payload.files?.[0];
  if (!first?.downloadUrl) throw new Error("API did not return a processed file.");
  return { downloadUrl: first.downloadUrl, filename: first.filename ?? path.basename(filePath) };
}

async function processMediaTool(
  endpoint: string,
  options: {
    files?: string[];
    folder?: string;
    outputFolder: string;
    recursive?: boolean;
    limit?: number;
    params: Record<string, string>;
    acceptKinds?: string[];
    outputExt?: (entry: FileEntry) => string;
  },
) {
  if (!apiKey) throw new Error("CONVERTLY_API_KEY is required.");
  const outputDir = resolveAllowed(options.outputFolder);
  const inputs = await resolveMediaInputs(options.files, options.folder, options.recursive ?? false, options.limit ?? 100, options.acceptKinds);
  await mkdir(outputDir, { recursive: true });

  const results: Array<{ from: string; to: string; originalBytes: number; outputBytes: number }> = [];

  for (const input of inputs) {
    const s = await stat(input);
    if (!s.isFile()) continue;
    const entry = toEntry(input, s);
    const { downloadUrl } = await postMediaFile(endpoint, input, options.params);
    const buffer = await downloadToBuffer(downloadUrl);
    const ext = options.outputExt ? options.outputExt(entry) : entry.extension;
    const target = uniqueOutputPath(path.join(outputDir, `${path.basename(entry.name, entry.extension)}${ext}`));
    await writeFile(target, buffer);
    results.push({ from: input, to: target, originalBytes: entry.sizeBytes, outputBytes: buffer.byteLength });
  }

  return { processedCount: results.length, results };
}

/* ------------------------------------------------------------------ */
/*  Docs tools                                                          */
/* ------------------------------------------------------------------ */

server.registerTool(
  "list_convertly_docs",
  { title: "List Convertly Docs", description: "List available Convertly documentation pages for API, dashboard, storage, MCP, webhooks, and billing guidance." },
  async () => jsonResult({ docsBaseUrl, docs: convertlyDocs }),
);

server.registerTool(
  "search_convertly_docs",
  {
    title: "Search Convertly Docs",
    description: "Search Convertly documentation pages by topic before calling API or filesystem tools.",
    inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(20).default(8) },
  },
  async ({ query, limit }) => jsonResult({ query, count: searchDocs(query, limit).length, results: searchDocs(query, limit) }),
);

server.registerTool(
  "get_convertly_doc",
  {
    title: "Get Convertly Doc",
    description: "Fetch a Convertly documentation page by slug or URL and return readable text.",
    inputSchema: { slugOrUrl: z.string().min(1), maxCharacters: z.number().int().min(1000).max(20000).default(8000) },
  },
  async ({ slugOrUrl, maxCharacters }) => {
    const doc = resolveDoc(slugOrUrl);
    const response = await fetch(doc.url, { headers: { accept: "text/html,text/markdown,text/plain" } });
    if (!response.ok) throw new Error(`Could not fetch doc ${doc.url}: ${response.status}`);
    const raw = await response.text();
    const text = readableText(raw).slice(0, maxCharacters);
    return jsonResult({ ...doc, text, truncated: raw.length > maxCharacters });
  },
);

/* ------------------------------------------------------------------ */
/*  Filesystem tools                                                    */
/* ------------------------------------------------------------------ */

server.registerTool(
  "list_roots",
  { title: "List Approved Roots", description: "List folders this Convertly MCP server is allowed to read and write." },
  async () => {
    assertLocalMode();
    return jsonResult({ roots });
  },
);

server.registerTool(
  "scan_folder",
  {
    title: "Scan Folder",
    description: "Scan an approved folder and return files with size, modified date, and media category.",
    inputSchema: { folder: z.string(), recursive: z.boolean().default(false), limit: z.number().int().min(1).max(2000).default(300) },
  },
  async ({ folder, recursive, limit }) => {
    assertLocalMode();
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
    inputSchema: { folder: z.string(), recursive: z.boolean().default(false), olderThanDays: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(2000).default(500) },
  },
  async ({ folder, recursive, olderThanDays, limit }) => {
    assertLocalMode();
    const root = resolveAllowed(folder);
    const files = await scanFolder(root, recursive, limit);
    const cutoff = olderThanDays ? Date.now() - olderThanDays * 24 * 60 * 60 * 1000 : null;
    const moves = files
      .filter((file) => (cutoff ? new Date(file.modifiedAt).getTime() < cutoff : true))
      .map((file) => ({ from: file.path, to: path.join(root, labelForKind(file.mediaKind), file.name), sizeBytes: file.sizeBytes, mediaKind: file.mediaKind }))
      .filter((move) => move.from !== move.to);
    return jsonResult({ dryRun: true, root, moveCount: moves.length, moves });
  },
);

server.registerTool(
  "move_files",
  {
    title: "Move Files",
    description: "Move approved files to approved destinations. Requires confirm=true and creates destination folders.",
    inputSchema: { moves: z.array(z.object({ from: z.string(), to: z.string() })).min(1), confirm: z.boolean().default(false), overwrite: z.boolean().default(false) },
  },
  async ({ moves, confirm, overwrite }) => {
    assertLocalMode();
    const resolved = moves.map((move) => ({ from: resolveAllowed(move.from), to: resolveAllowed(move.to) }));
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
  "rename_files",
  {
    title: "Rename Files",
    description: "Rename approved files. Requires confirm=true. Works on individual files within approved roots.",
    inputSchema: { renames: z.array(z.object({ from: z.string(), to: z.string() })).min(1), confirm: z.boolean().default(false), overwrite: z.boolean().default(false) },
  },
  async ({ renames, confirm, overwrite }) => {
    assertLocalMode();
    const resolved = renames.map((r) => ({ from: resolveAllowed(r.from), to: resolveAllowed(r.to) }));
    if (!confirm) return jsonResult({ dryRun: true, wouldRename: resolved, note: "Call again with confirm=true to rename files." });
    const renamed: Array<{ from: string; to: string }> = [];
    for (const r of resolved) {
      const sourceStat = await stat(r.from);
      if (!sourceStat.isFile()) throw new Error(`Refusing to rename non-file path: ${r.from}`);
      if (!overwrite && await exists(r.to)) throw new Error(`Destination already exists: ${r.to}`);
      await rename(r.from, r.to);
      renamed.push(r);
    }
    return jsonResult({ renamedCount: renamed.length, renamed });
  },
);

server.registerTool(
  "copy_files",
  {
    title: "Copy Files",
    description: "Copy approved files to approved destinations. Requires confirm=true and creates destination folders.",
    inputSchema: { copies: z.array(z.object({ from: z.string(), to: z.string() })).min(1), confirm: z.boolean().default(false), overwrite: z.boolean().default(false) },
  },
  async ({ copies, confirm, overwrite }) => {
    assertLocalMode();
    const resolved = copies.map((c) => ({ from: resolveAllowed(c.from), to: resolveAllowed(c.to) }));
    if (!confirm) return jsonResult({ dryRun: true, wouldCopy: resolved, note: "Call again with confirm=true to copy files." });
    const copied: Array<{ from: string; to: string }> = [];
    for (const c of resolved) {
      const sourceStat = await stat(c.from);
      if (!sourceStat.isFile()) throw new Error(`Refusing to copy non-file path: ${c.from}`);
      if (!overwrite && await exists(c.to)) throw new Error(`Destination already exists: ${c.to}`);
      await mkdir(path.dirname(c.to), { recursive: true });
      await copyFile(c.from, c.to);
      copied.push(c);
    }
    return jsonResult({ copiedCount: copied.length, copied });
  },
);

server.registerTool(
  "create_folder",
  {
    title: "Create Folder",
    description: "Create a folder inside approved roots. Creates parent directories as needed.",
    inputSchema: { path: z.string(), recursive: z.boolean().default(true) },
  },
  async ({ path: folderPath, recursive }) => {
    assertLocalMode();
    const resolved = resolveAllowed(folderPath);
    await mkdir(resolved, { recursive });
    return jsonResult({ created: resolved });
  },
);

server.registerTool(
  "read_file",
  {
    title: "Read File",
    description: "Read the contents of an approved text file. Returns UTF-8 text. Binary files may return garbled text.",
    inputSchema: { path: z.string(), limitBytes: z.number().int().min(1).max(1048576).default(262144) },
  },
  async ({ path: filePath, limitBytes }) => {
    assertLocalMode();
    const resolved = resolveAllowed(filePath);
    const s = await stat(resolved);
    if (!s.isFile()) throw new Error(`Not a file: ${filePath}`);
    if (s.size > limitBytes) {
      const fd = await readFile(resolved);
      const truncated = fd.toString("utf-8", 0, limitBytes);
      return jsonResult({ path: resolved, sizeBytes: s.size, truncated: true, limitBytes, text: truncated });
    }
    const text = await readFile(resolved, "utf-8");
    return jsonResult({ path: resolved, sizeBytes: s.size, truncated: false, text });
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
    assertLocalMode();
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
  "delete_files",
  {
    title: "Delete Files",
    description: "Delete approved files. Requires confirm=true. Prefer calling scan_folder or plan_organize_folder first.",
    inputSchema: { files: z.array(z.string()).min(1), confirm: z.boolean().default(false) },
  },
  async ({ files, confirm }) => {
    assertLocalMode();
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

/* ------------------------------------------------------------------ */
/*  Core conversion & compression                                       */
/* ------------------------------------------------------------------ */

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
    const result = await processMediaTool("/api/convert", {
      files, folder, outputFolder, recursive, limit,
      params: { format, compression: String(compression), resize: resize ?? "", resizeWidth: resizeWidth ? String(resizeWidth) : "", resizeHeight: resizeHeight ? String(resizeHeight) : "" },
    });
    return jsonResult({ convertedCount: result.processedCount, converted: result.results });
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
    const result = await processMediaTool("/api/compress", {
      files, folder, outputFolder, recursive, limit,
      params: { mode, quality: String(quality), targetBytes: targetBytes ? String(targetBytes) : "", lossless: String(lossless), stripMetadata: String(stripMetadata) },
    });
    return jsonResult({ compressedCount: result.processedCount, compressed: result.results });
  },
);

/* ------------------------------------------------------------------ */
/*  Media tools                                                         */
/* ------------------------------------------------------------------ */

server.registerTool(
  "remove_background",
  {
    title: "Remove Background",
    description: "Remove the background from local image files using AI and save transparent cutouts locally.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["png", "webp", "jpg"]).default("png"),
      model: z.enum(["small", "medium", "large"]).default("medium"),
      quality: z.number().int().min(1).max(100).default(92),
      trim: z.boolean().default(false),
      force: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, model, quality, trim, force, limit }) => {
    const result = await processMediaTool("/api/media/remove-background", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["image"],
      params: { format, model, quality: String(quality), trim: String(trim), force: String(force) },
      outputExt: (entry) => `.${format}`,
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "transform_image",
  {
    title: "Transform Image",
    description: "Resize, crop, rotate, flip, and format-shift local images using Convertly.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["jpg", "png", "webp", "avif"]).default("webp"),
      preset: z.enum(["ecommerce", "avatar", "blog-hero", "social-preview"]).optional(),
      width: z.number().int().min(1).optional(),
      height: z.number().int().min(1).optional(),
      fit: z.enum(["cover", "contain", "fill", "inside", "outside"]).default("cover"),
      rotate: z.number().int().default(0),
      flip: z.boolean().default(false),
      flop: z.boolean().default(false),
      quality: z.number().int().min(1).max(100).default(86),
      cropLeft: z.number().int().min(0).optional(),
      cropTop: z.number().int().min(0).optional(),
      cropWidth: z.number().int().min(1).optional(),
      cropHeight: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, preset, width, height, fit, rotate, flip, flop, quality, cropLeft, cropTop, cropWidth, cropHeight, limit }) => {
    const result = await processMediaTool("/api/media/transform", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["image"],
      params: {
        format, preset: preset ?? "", width: width ? String(width) : "", height: height ? String(height) : "",
        fit, rotate: String(rotate), flip: String(flip), flop: String(flop), quality: String(quality),
        cropLeft: cropLeft !== undefined ? String(cropLeft) : "", cropTop: cropTop !== undefined ? String(cropTop) : "",
        cropWidth: cropWidth !== undefined ? String(cropWidth) : "", cropHeight: cropHeight !== undefined ? String(cropHeight) : "",
      },
      outputExt: (entry) => `.${format}`,
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "generate_thumbnail",
  {
    title: "Generate Thumbnail",
    description: "Create thumbnails from local images or videos.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["jpg", "png", "webp", "avif"]).default("jpg"),
      width: z.number().int().min(1).default(512),
      height: z.number().int().min(1).default(512),
      fit: z.enum(["cover", "contain", "inside"]).default("cover"),
      quality: z.number().int().min(1).max(100).default(82),
      timestamp: z.number().default(1),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, width, height, fit, quality, timestamp, limit }) => {
    const result = await processMediaTool("/api/media/thumbnail", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["image", "video"],
      params: { format, width: String(width), height: String(height), fit, quality: String(quality), timestamp: String(timestamp) },
      outputExt: (entry) => `.${format}`,
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "watermark_media",
  {
    title: "Watermark Media",
    description: "Add text or logo watermarks to local images and videos.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      text: z.string().optional(),
      logoFile: z.string().optional(),
      position: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "center"]).default("bottom-right"),
      opacity: z.number().min(0).max(1).default(0.72),
      margin: z.number().int().min(0).default(32),
      watermarkWidth: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, text, logoFile, position, opacity, margin, watermarkWidth, limit }) => {
    if (!apiKey) throw new Error("CONVERTLY_API_KEY is required.");
    const outputDir = resolveAllowed(outputFolder);
    const inputs = await resolveMediaInputs(files, folder, recursive, limit, ["image", "video"]);
    await mkdir(outputDir, { recursive: true });

    const results: Array<{ from: string; to: string; originalBytes: number; outputBytes: number }> = [];

    for (const input of inputs) {
      const s = await stat(input);
      if (!s.isFile()) continue;
      const entry = toEntry(input, s);
      const form = new FormData();
      const data = await readFile(input);
      form.append("files", new Blob([data]), path.basename(input));
      if (text) form.append("text", text);
      if (logoFile) {
        const logoPath = resolveAllowed(logoFile);
        const logoData = await readFile(logoPath);
        form.append("watermarkFile", new Blob([logoData]), path.basename(logoPath));
      }
      form.append("position", position);
      form.append("opacity", String(opacity));
      form.append("margin", String(margin));
      if (watermarkWidth) form.append("watermarkWidth", String(watermarkWidth));
      form.append("saveToStorage", "false");

      const response = await fetch(`${baseUrl}/api/media/watermark`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
      });
      const payload = await response.json() as { files?: Array<{ downloadUrl?: string }>; error?: string };
      if (!response.ok) throw new Error(payload.error ?? `API returned ${response.status}`);
      const url = payload.files?.[0]?.downloadUrl;
      if (!url) throw new Error("API did not return a watermarked file.");
      const buffer = await downloadToBuffer(url);
      const ext = entry.mediaKind === "video" ? ".mp4" : ".png";
      const target = uniqueOutputPath(path.join(outputDir, `${path.basename(entry.name, entry.extension)}-watermarked${ext}`));
      await writeFile(target, buffer);
      results.push({ from: input, to: target, originalBytes: entry.sizeBytes, outputBytes: buffer.byteLength });
    }

    return jsonResult({ processedCount: results.length, results });
  },
);

server.registerTool(
  "create_storyboard",
  {
    title: "Create Storyboard",
    description: "Generate a storyboard grid image from local video files.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["jpg", "png", "webp", "avif"]).default("jpg"),
      frames: z.number().int().min(1).default(12),
      columns: z.number().int().min(1).default(4),
      width: z.number().int().min(1).default(240),
      quality: z.number().int().min(1).max(100).default(86),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, frames, columns, width, quality, limit }) => {
    const result = await processMediaTool("/api/media/storyboard", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["video"],
      params: { format, frames: String(frames), columns: String(columns), width: String(width), quality: String(quality) },
      outputExt: (entry) => `.${format}`,
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "trim_media",
  {
    title: "Trim Media",
    description: "Trim local video and audio files to a specific start time and duration.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["mp4", "webm", "mov", "mp3", "m4a", "wav"]).optional(),
      start: z.number().min(0).default(0),
      duration: z.number().min(0.1).default(10),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, start, duration, limit }) => {
    const result = await processMediaTool("/api/media/trim", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["video", "audio"],
      params: { format: format ?? "", start: String(start), duration: String(duration) },
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "video_to_gif",
  {
    title: "Video to GIF",
    description: "Convert local video files to animated GIF previews.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      start: z.number().min(0).default(0),
      duration: z.number().min(0.1).default(4),
      width: z.number().int().min(1).default(480),
      fps: z.number().int().min(1).default(12),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, start, duration, width, fps, limit }) => {
    const result = await processMediaTool("/api/media/gif", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["video"],
      params: { start: String(start), duration: String(duration), width: String(width), fps: String(fps) },
      outputExt: () => ".gif",
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "pdf_preview",
  {
    title: "PDF Preview",
    description: "Convert pages from local PDF files to image previews.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["jpg", "png", "webp", "avif"]).default("jpg"),
      page: z.number().int().min(1).default(1),
      width: z.number().int().min(1).default(1600),
      quality: z.number().int().min(1).max(100).default(86),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, page, width, quality, limit }) => {
    const result = await processMediaTool("/api/media/pdf-preview", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["document"],
      params: { format, page: String(page), width: String(width), quality: String(quality) },
      outputExt: (entry) => `.${format}`,
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "poster_frame",
  {
    title: "Poster Frame",
    description: "Extract a poster frame image from local video files.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["jpg", "png", "webp", "avif"]).default("jpg"),
      timestamp: z.number().default(1),
      width: z.number().int().min(1).default(1280),
      quality: z.number().int().min(1).max(100).default(86),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, timestamp, width, quality, limit }) => {
    const result = await processMediaTool("/api/media/poster-frame", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["video"],
      params: { format, timestamp: String(timestamp), width: String(width), quality: String(quality) },
      outputExt: (entry) => `.${format}`,
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "extract_audio",
  {
    title: "Extract Audio",
    description: "Extract audio tracks from local video files.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.enum(["mp3", "m4a", "wav", "ogg", "flac"]).default("mp3"),
      bitrateKbps: z.number().int().min(32).default(192),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, bitrateKbps, limit }) => {
    const result = await processMediaTool("/api/media/extract-audio", {
      files, folder, outputFolder, recursive, limit,
      acceptKinds: ["video"],
      params: { format, bitrateKbps: String(bitrateKbps) },
      outputExt: () => `.${format}`,
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "strip_metadata",
  {
    title: "Strip Metadata",
    description: "Remove metadata from local media files.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, limit }) => {
    const result = await processMediaTool("/api/media/strip-metadata", {
      files, folder, outputFolder, recursive, limit,
      params: {},
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

server.registerTool(
  "images_to_pdf",
  {
    title: "Images to PDF",
    description: "Combine local images into a single PDF document.",
    inputSchema: {
      files: z.array(z.string()).min(1),
      outputPath: z.string(),
      pageSize: z.enum(["auto", "letter", "a4"]).default("auto"),
    },
  },
  async ({ files, outputPath, pageSize }) => {
    if (!apiKey) throw new Error("CONVERTLY_API_KEY is required.");
    const output = resolveAllowed(outputPath);
    await mkdir(path.dirname(output), { recursive: true });

    const form = new FormData();
    for (const file of files) {
      const p = resolveAllowed(file);
      const data = await readFile(p);
      form.append("files", new Blob([data]), path.basename(p));
    }
    form.append("pageSize", pageSize);
    form.append("saveToStorage", "false");

    const response = await fetch(`${baseUrl}/api/media/image-to-pdf`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
    const payload = await response.json() as { files?: Array<{ downloadUrl?: string }>; error?: string };
    if (!response.ok) throw new Error(payload.error ?? `API returned ${response.status}`);
    const url = payload.files?.[0]?.downloadUrl;
    if (!url) throw new Error("API did not return a PDF.");
    const buffer = await downloadToBuffer(url);
    await writeFile(output, buffer);
    return jsonResult({ outputPath: output, pageCount: files.length, sizeBytes: buffer.byteLength });
  },
);

server.registerTool(
  "inspect_media",
  {
    title: "Inspect Media",
    description: "Return metadata and properties for local media files.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      recursive: z.boolean().default(false),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, recursive, limit }) => {
    if (!apiKey) throw new Error("CONVERTLY_API_KEY is required.");
    const inputs = await resolveMediaInputs(files, folder, recursive, limit);
    const results: Array<{ file: string; metadata: unknown }> = [];
    for (const input of inputs) {
      const s = await stat(input);
      if (!s.isFile()) continue;
      const { downloadUrl } = await postMediaFile("/api/media/inspect", input, {});
      const buffer = await downloadToBuffer(downloadUrl);
      const text = buffer.toString("utf-8");
      const metadata = text ? JSON.parse(text) : {};
      results.push({ file: input, metadata });
    }
    return jsonResult({ inspectedCount: results.length, results });
  },
);

server.registerTool(
  "adjust_media",
  {
    title: "Adjust Media",
    description: "Apply brightness, contrast, saturation, hue, grayscale, and other adjustments to images, video, and audio.",
    inputSchema: {
      files: z.array(z.string()).optional(),
      folder: z.string().optional(),
      outputFolder: z.string(),
      recursive: z.boolean().default(false),
      format: z.string().optional(),
      quality: z.number().int().min(1).max(100).default(86),
      brightness: z.number().default(1),
      saturation: z.number().default(1),
      hue: z.number().default(0),
      contrast: z.number().default(1),
      grayscale: z.boolean().default(false),
      invert: z.boolean().default(false),
      sharpen: z.boolean().default(false),
      volume: z.number().default(1),
      normalize: z.boolean().default(false),
      fadeIn: z.number().min(0).default(0),
      fadeOut: z.number().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ files, folder, outputFolder, recursive, format, quality, brightness, saturation, hue, contrast, grayscale, invert, sharpen, volume, normalize, fadeIn, fadeOut, limit }) => {
    const result = await processMediaTool("/api/media/adjust", {
      files, folder, outputFolder, recursive, limit,
      params: {
        format: format ?? "", quality: String(quality), brightness: String(brightness), saturation: String(saturation),
        hue: String(hue), contrast: String(contrast), grayscale: String(grayscale), invert: String(invert),
        sharpen: String(sharpen), volume: String(volume), normalize: String(normalize), fadeIn: String(fadeIn), fadeOut: String(fadeOut),
      },
    });
    return jsonResult({ processedCount: result.processedCount, results: result.results });
  },
);

/* ------------------------------------------------------------------ */
/*  Transfer                                                            */
/* ------------------------------------------------------------------ */

server.registerTool(
  "transfer_url",
  {
    title: "Transfer URL",
    description: "Download a public remote file URL and save it to an approved local folder.",
    inputSchema: {
      sourceUrl: z.string().url(),
      outputPath: z.string(),
      extract: z.boolean().default(false),
    },
  },
  async ({ sourceUrl, outputPath, extract }) => {
    assertLocalMode();
    const output = resolveAllowed(outputPath);
    await mkdir(path.dirname(output), { recursive: true });

    const response = await fetch(sourceUrl, { redirect: "follow", headers: { "user-agent": "Convertly-MCP/1.0" } });
    if (!response.ok) throw new Error(`Source returned ${response.status}.`);
    const buffer = Buffer.from(await response.arrayBuffer());

    if (extract) {
      if (!output.toLowerCase().endsWith(".zip")) throw new Error("extract=true requires outputPath to end with .zip (archive will be extracted next to it).");
      const tmpPath = output;
      await writeFile(tmpPath, buffer);
      const extractDir = output.replace(/\.zip$/i, "");
      await mkdir(extractDir, { recursive: true });
      // Extract using JSZip
      const zip = await JSZip.loadAsync(buffer);
      const extracted: string[] = [];
      for (const [name, entry] of Object.entries(zip.files)) {
        if (entry.dir || name.includes("__MACOSX/")) continue;
        const entryBuffer = await entry.async("nodebuffer");
        const target = path.join(extractDir, name.replace(/\//g, path.sep));
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, entryBuffer);
        extracted.push(target);
      }
      await rm(tmpPath);
      return jsonResult({ sourceUrl, extractedTo: extractDir, extractedCount: extracted.length, files: extracted });
    }

    await writeFile(output, buffer);
    return jsonResult({ sourceUrl, outputPath: output, sizeBytes: buffer.byteLength });
  },
);

/* ------------------------------------------------------------------ */
/*  Currency                                                            */
/* ------------------------------------------------------------------ */

server.registerTool(
  "convert_currency",
  {
    title: "Convert Currency",
    description: "Convert an amount from one currency to another using Convertly exchange rates.",
    inputSchema: {
      amount: z.union([z.string(), z.number()]),
      from: z.string().length(3).toUpperCase(),
      to: z.string().length(3).toUpperCase(),
      precision: z.number().int().min(0).max(12).default(6),
    },
  },
  async ({ amount, from, to, precision }) => {
    const data = await apiFetch("/api/currency/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: String(amount), from, to, precision }),
    });
    return jsonResult(data);
  },
);

/* ------------------------------------------------------------------ */
/*  Async jobs                                                          */
/* ------------------------------------------------------------------ */

server.registerTool(
  "list_jobs",
  {
    title: "List Async Jobs",
    description: "List recent async conversion and media-tool jobs from your Convertly account.",
    inputSchema: { limit: z.number().int().min(1).max(100).default(20), offset: z.number().int().min(0).default(0), status: z.string().optional() },
  },
  async ({ limit, offset, status }) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (status) params.set("status", status);
    const data = await apiFetch(`/api/jobs?${params.toString()}`);
    return jsonResult(data);
  },
);

server.registerTool(
  "get_job",
  {
    title: "Get Job Status",
    description: "Get the status and results of a specific async job by ID.",
    inputSchema: { jobId: z.string().uuid() },
  },
  async ({ jobId }) => {
    const data = await apiFetch(`/api/jobs/${jobId}`);
    return jsonResult(data);
  },
);

/* ------------------------------------------------------------------ */
/*  Cloud storage                                                       */
/* ------------------------------------------------------------------ */

server.registerTool(
  "list_cloud_files",
  {
    title: "List Cloud Files",
    description: "List files stored in your Convertly cloud storage.",
    inputSchema: { folderId: z.string().uuid().optional(), limit: z.number().int().min(1).max(200).default(50) },
  },
  async ({ folderId, limit }) => {
    const params = new URLSearchParams({ limit: String(limit) });
    if (folderId) params.set("folderId", folderId);
    const data = await apiFetch(`/api/files?${params.toString()}`);
    return jsonResult(data);
  },
);

server.registerTool(
  "delete_cloud_file",
  {
    title: "Delete Cloud File",
    description: "Delete a file from your Convertly cloud storage.",
    inputSchema: { fileId: z.string().uuid(), confirm: z.boolean().default(false) },
  },
  async ({ fileId, confirm }) => {
    if (!confirm) return jsonResult({ dryRun: true, wouldDelete: fileId, note: "Call again with confirm=true to delete." });
    const data = await apiFetch(`/api/files/${fileId}`, { method: "DELETE" });
    return jsonResult({ deleted: true, fileId, ...data });
  },
);

server.registerTool(
  "list_folders",
  {
    title: "List Folders",
    description: "List folders in your Convertly cloud storage.",
    inputSchema: { parentId: z.string().uuid().optional() },
  },
  async ({ parentId }) => {
    const params = new URLSearchParams();
    if (parentId) params.set("parentId", parentId);
    const data = await apiFetch(`/api/folders${params.toString() ? `?${params.toString()}` : ""}`);
    return jsonResult(data);
  },
);

server.registerTool(
  "create_cloud_folder",
  {
    title: "Create Cloud Folder",
    description: "Create a folder in your Convertly cloud storage.",
    inputSchema: { name: z.string().min(1), parentId: z.string().uuid().optional(), color: z.string().optional() },
  },
  async ({ name, parentId, color }) => {
    const data = await apiFetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, parentId, color }),
    });
    return jsonResult(data);
  },
);

server.registerTool(
  "download_cloud_file",
  {
    title: "Download Cloud File",
    description: "Get a temporary signed download URL for a file in your Convertly cloud storage. The URL expires in 5 minutes.",
    inputSchema: { fileId: z.string().uuid() },
  },
  async ({ fileId }) => {
    const data = await apiFetch(`/api/files/${fileId}`, {
      headers: { Accept: "application/json" },
    });
    return jsonResult(data);
  },
);

server.registerTool(
  "save_cloud_file",
  {
    title: "Save Cloud File to Local",
    description: "Download a file from Convertly cloud storage directly to an approved local folder. One-step cloud to local.",
    inputSchema: { fileId: z.string().uuid(), outputPath: z.string() },
  },
  async ({ fileId, outputPath }) => {
    assertLocalMode();
    const out = resolveAllowed(outputPath);
    const meta = await apiFetch(`/api/files/${fileId}`, {
      headers: { Accept: "application/json" },
    });
    const downloadUrl = meta.file?.downloadUrl;
    if (!downloadUrl) throw new Error("No download URL returned from cloud storage.");
    const response = await fetch(downloadUrl, { redirect: "follow", headers: { "user-agent": "Convertly-MCP/1.0" } });
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = Buffer.from(await response.arrayBuffer());
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, buffer);
    return jsonResult({ saved: true, fileId, outputPath: out, bytes: buffer.length, filename: meta.file?.filename });
  },
);

server.registerTool(
  "rename_cloud_file",
  {
    title: "Rename Cloud File",
    description: "Rename a file in your Convertly cloud storage.",
    inputSchema: { fileId: z.string().uuid(), name: z.string().min(1), confirm: z.boolean().default(false) },
  },
  async ({ fileId, name, confirm }) => {
    if (!confirm) return jsonResult({ dryRun: true, wouldRename: { fileId, name }, note: "Call again with confirm=true to rename." });
    const data = await apiFetch(`/api/files/${fileId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filename: name }),
    });
    return jsonResult({ renamed: true, fileId, ...data });
  },
);

server.registerTool(
  "rename_folder",
  {
    title: "Rename Folder",
    description: "Rename a folder in your Convertly cloud storage.",
    inputSchema: { folderId: z.string().uuid(), name: z.string().min(1), confirm: z.boolean().default(false) },
  },
  async ({ folderId, name, confirm }) => {
    if (!confirm) return jsonResult({ dryRun: true, wouldRename: { folderId, name }, note: "Call again with confirm=true to rename." });
    const data = await apiFetch(`/api/folders/${folderId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    return jsonResult({ renamed: true, folderId, ...data });
  },
);

/* ------------------------------------------------------------------ */
/*  Main                                                                */
/* ------------------------------------------------------------------ */

const MAX_HTTP_SESSIONS = Number(process.env.CONVERTLY_MCP_MAX_SESSIONS ?? "100");
const HTTP_SESSION_TIMEOUT_MS = Number(process.env.CONVERTLY_MCP_SESSION_TIMEOUT_MS ?? "600000");

function setCorsHeaders(res: import("node:http").ServerResponse) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id");
}

async function main() {
  const httpPort = process.env.CONVERTLY_MCP_HTTP_PORT;

  if (httpPort) {
    const port = Number(httpPort);
    const { createServer } = await import("node:http");
    const transports = new Map<string, { transport: SSEServerTransport; lastActive: number }>();
    let totalConnections = 0;

    const cleanupIdleSessions = () => {
      const now = Date.now();
      for (const [sessionId, session] of transports) {
        if (now - session.lastActive > HTTP_SESSION_TIMEOUT_MS) {
          session.transport.close().catch(() => {});
          transports.delete(sessionId);
        }
      }
    };
    const cleanupInterval = setInterval(cleanupIdleSessions, 60000);

    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url || "/", `http://${req.headers.host}`);

      if (req.method === "OPTIONS") {
        setCorsHeaders(res);
        res.writeHead(204).end();
        return;
      }

      setCorsHeaders(res);

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", sessions: transports.size, version: "0.2.0" }));
        return;
      }

      if (req.method === "GET" && url.pathname === "/mcp") {
        if (transports.size >= MAX_HTTP_SESSIONS) {
          console.error("Max sessions reached");
          res.writeHead(503).end("Server at capacity");
          return;
        }
        try {
          const transport = new SSEServerTransport("/messages", res);
          const sessionId = transport.sessionId;
          transports.set(sessionId, { transport, lastActive: Date.now() });
          totalConnections++;

          transport.onclose = () => {
            transports.delete(sessionId);
          };

          await server.connect(transport);
          console.log(`Session ${sessionId} connected (${transports.size} active)`);
        } catch (error) {
          console.error("SSE connection error:", error);
          if (!res.headersSent) res.writeHead(500).end("SSE error");
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          res.writeHead(400).end("Missing sessionId");
          return;
        }
        const session = transports.get(sessionId);
        if (!session) {
          res.writeHead(404).end("Session not found");
          return;
        }
        try {
          session.lastActive = Date.now();
          await session.transport.handlePostMessage(req, res);
        } catch (error) {
          console.error("Message handling error:", error);
          if (!res.headersSent) res.writeHead(500).end("Message error");
        }
        return;
      }

      res.writeHead(404).end("Not found");
    });

    httpServer.listen(port, () => {
      console.log(`Convertly MCP HTTP server listening on http://localhost:${port}/mcp`);
      console.log(`Health check: http://localhost:${port}/health`);
      console.log(`Max sessions: ${MAX_HTTP_SESSIONS}, Session timeout: ${HTTP_SESSION_TIMEOUT_MS}ms`);
    });

    process.on("SIGINT", async () => {
      console.log("Shutting down...");
      clearInterval(cleanupInterval);
      for (const [, session] of transports) {
        await session.transport.close().catch(() => {});
      }
      transports.clear();
      httpServer.close(() => process.exit(0));
    });
  } else {
    await server.connect(new StdioServerTransport());
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/*  Docs helpers                                                        */
/* ------------------------------------------------------------------ */

function createDocsIndex(origin: string): DocEntry[] {
  const page = (slug: string, title: string, description: string, keywords: string[] = []) => ({
    slug, title, url: `${origin}/${slug}`, description, keywords,
  });

  return [
    page("", "Overview", "Start here for Convertly concepts, authentication, and the main API surfaces.", ["quickstart", "overview", "start"]),
    page("quickstart", "Quickstart", "Make your first authenticated Convertly API request.", ["api key", "curl", "sdk"]),
    page("authentication", "Authentication", "Use Convertly API keys with Bearer auth or x-api-key headers.", ["api key", "auth", "security"]),
    page("docs/sdk", "SDK", "Use the Convertly JavaScript SDK for conversion, compression, jobs, storage, and transfer workflows.", ["javascript", "typescript", "sdk"]),
    page("docs/php-sdk", "PHP SDK", "Use Convertly from PHP applications.", ["php", "sdk"]),
    page("docs/mcp-agents", "MCP for AI Agents", "Connect Convertly tools and approved local folders to MCP-compatible AI clients.", ["mcp", "claude", "codex", "cursor", "agents"]),
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
    return { slug: value, title: value, url: value, description: "Custom Convertly documentation URL.", keywords: [] };
  }
  return { slug: normalized, title: normalized || "Overview", url: `${docsBaseUrl}/${normalized}`, description: "Convertly documentation page.", keywords: [] };
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
