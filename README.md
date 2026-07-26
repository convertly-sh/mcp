# Convertly MCP

Model Context Protocol server for AI agents that work with Convertly media APIs — from Claude, Cursor, ChatGPT, and other MCP clients.

Docs: <a href="https://docs.convertly.sh/docs/mcp-agents" target="_blank" rel="noopener noreferrer">MCP agents guide</a>

## Install

```json
{
  "mcpServers": {
    "convertly": {
      "command": "npx",
      "args": ["-y", "@convertly-sh/mcp"],
      "env": {
        "CONVERTLY_API_KEY": "<paste-your-key-here>",
        "CONVERTLY_MCP_ROOTS": "/Users/you/Downloads:/Users/you/Pictures"
      }
    }
  }
}
```

On Windows, separate roots with `;`.

Windows example (JSON paths require doubled backslashes):

```json
{
  "mcpServers": {
    "convertly": {
      "command": "npx",
      "args": ["-y", "@convertly-sh/mcp"],
      "env": {
        "CONVERTLY_API_KEY": "<paste-your-key-here>",
        "CONVERTLY_MCP_ROOTS": "C:\\Users\\you\\Downloads;C:\\Users\\you\\Pictures"
      }
    }
  }
}
```

After rotating a key or editing this file, fully quit and reopen the MCP client so the server receives the new environment variables.

## Source on npm

Browse published files on <a href="https://www.npmjs.com/package/@convertly-sh/mcp?activeTab=code" target="_blank" rel="noopener noreferrer">npm → Code</a> (`dist/`, `bin/`, `LICENSE`). The main Convertly repo is private; this package is MIT-licensed.

## Modes

**Local (stdio)** — filesystem tools + API tools. **HTTP/SSE** — API tools only (`CONVERTLY_MCP_HTTP_PORT=3000`).

## Tools (summary)

- **Docs:** `list_convertly_docs`, `search_convertly_docs`, `get_convertly_doc`
- **CDN:** `build_cdn_url` — image/video/poster/GIF URLs (`trim` for logos)
- **Filesystem (local):** `scan_folder`, `move_files`, `create_archive`, …
- **Media:** `convert_media`, `compress_media`, `remove_background`, `trim_media`, `video_to_gif`, …
- **Cloud:** `list_cloud_files`, `save_cloud_file`, …
- **Forma AI:** `forma_ai_transform`, `forma_ai_analyze` (all plans; Forma AI units)

Full list: <a href="https://docs.convertly.sh/docs/mcp-agents" target="_blank" rel="noopener noreferrer">MCP agents docs</a>.

## CDN note

`build_cdn_url` for origin-backed URLs requires an origin source in **Settings → Image CDN → Sources**. See <a href="https://docs.convertly.sh/guides/image-cdn-setup" target="_blank" rel="noopener noreferrer">setup guide</a>.

## License

**MIT** © <a href="https://convertly.sh" target="_blank" rel="noopener noreferrer">Convertly</a>.

- Full text: <a href="https://www.npmjs.com/package/@convertly-sh/mcp?activeTab=code" target="_blank" rel="noopener noreferrer">npm → Code → `LICENSE`</a>
- Summary: <a href="https://opensource.org/license/mit" target="_blank" rel="noopener noreferrer">MIT on Open Source Initiative</a>
