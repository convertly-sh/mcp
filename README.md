# Convertly MCP

Convertly MCP is a local Model Context Protocol server for AI agents that need to work with approved folders and Convertly media APIs.

Use it from Claude, ChatGPT, Cursor, or another MCP-compatible client to scan folders, organize files, create ZIP archives, convert media, compress media, and search Convertly documentation.

## Install

Configure your MCP client to run the package with `npx`:

```json
{
  "mcpServers": {
    "convertly": {
      "command": "npx",
      "args": ["-y", "@convertly/mcp"],
      "env": {
        "CONVERTLY_API_KEY": "ctly_live_...",
        "CONVERTLY_MCP_ROOTS": "/Users/you/Downloads:/Users/you/Pictures"
      }
    }
  }
}
```

On Windows, separate approved roots with `;`:

```json
{
  "mcpServers": {
    "convertly": {
      "command": "npx",
      "args": ["-y", "@convertly/mcp"],
      "env": {
        "CONVERTLY_API_KEY": "ctly_live_...",
        "CONVERTLY_MCP_ROOTS": "C:/Users/you/Downloads;C:/Users/you/Pictures"
      }
    }
  }
}
```

`CONVERTLY_MCP_ROOTS` controls which folders the server can read or write. If omitted, only the current working directory is approved.

## Tools

- `list_convertly_docs`: list Convertly documentation pages
- `search_convertly_docs`: search Convertly docs by topic
- `get_convertly_doc`: fetch readable text for a Convertly docs page
- `list_roots`: show approved folders
- `scan_folder`: list files with size, modified date, and media category
- `plan_organize_folder`: dry-run moves into Images, Videos, Audio, Archives, Documents, and Other
- `move_files`: move files inside approved roots after `confirm: true`
- `create_archive`: create ZIP archives inside approved roots
- `convert_media`: convert local media with the Convertly API
- `compress_media`: compress local image, video, or audio files with the Convertly API
- `convert_images_to_webp`: convert local images to WebP
- `delete_files`: delete files only when `confirm` is `true`

## Safety

The model does not receive raw filesystem access. All filesystem paths are resolved and checked against approved roots. Move and delete operations require `confirm: true`, and planning tools return dry-run output by default.
