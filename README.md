# Convertly MCP

Local MCP server for AI agents that need to organize folders and run Convertly media workflows.

The model does not receive raw filesystem access. This server exposes scoped tools, and every path must live under an approved root.

## Setup

```bash
npm install
npm run build --prefix packages/convertly-mcp
```

Configure your MCP client:

```json
{
  "mcpServers": {
    "convertly": {
      "command": "node",
      "args": ["C:/Development/convertly/packages/convertly-mcp/dist/index.js"],
      "env": {
        "CONVERTLY_API_KEY": "your_api_key",
        "CONVERTLY_MCP_ROOTS": "C:/Users/you/Downloads;C:/Users/you/Pictures"
      }
    }
  }
}
```

`CONVERTLY_MCP_ROOTS` is separated by `;` on Windows and `:` elsewhere. If omitted, the current working directory is the only approved root.

## Safety

- All filesystem paths are resolved and checked against approved roots.
- Move and delete operations require `confirm: true`.
- Organization planning is dry-run by default.
- Convert and archive tools write outputs inside approved roots only.

## Tools

- `list_roots`: show approved folders
- `scan_folder`: list files with size, modified date, and media category
- `plan_organize_folder`: dry-run moves into Images, Videos, Audio, Archives, Documents, and Other
- `move_files`: move files inside approved roots after `confirm: true`
- `create_archive`: create ZIP archives inside approved roots
- `convert_media`: convert local media with the Convertly API
- `compress_media`: compress local image, video, or audio files with the Convertly API
- `convert_images_to_webp`: convenience wrapper for converting local images to WebP
- `delete_files`: delete files only when `confirm` is `true`
